/**
 * 承認 API（基本設計書 6.3 / 11.2）。
 * 必須チェック: 所有 Workspace / pending / 期限内 / 版数一致 / 内容ハッシュ一致 / ポリシー。
 * 判定は条件付き UPDATE（status='pending' AND version=expected）で比較更新し、二重承認を防ぐ。
 */
import type { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { ApprovalDecisionRequest } from '@paw/contracts';
import type { AppEnv, Services } from '../app';
import { approvals, projects, runs } from '../db/schema';
import { AppError, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import { audit } from '../services/audit';
import { auth, parseBody, withIdempotency } from './helpers';

export function registerApprovalRoutes(app: Hono<AppEnv>, s: Services) {
  app.get('/v1/approvals', async (c) => {
    const a = auth(c);
    const status = c.req.query('status') ?? 'pending';
    const rows = await s.db
      .select({ approval: approvals, runTitle: runs.title, runStatus: runs.status, projectName: projects.name, projectColor: projects.color })
      .from(approvals)
      .innerJoin(runs, eq(runs.id, approvals.runId))
      .innerJoin(projects, eq(projects.id, approvals.projectId))
      .where(
        status === 'all'
          ? eq(approvals.workspaceId, a.workspaceId)
          : and(eq(approvals.workspaceId, a.workspaceId), eq(approvals.status, 'pending')),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(100);
    return c.json({
      items: rows.map((r) => ({
        ...r.approval,
        expiresAt: r.approval.expiresAt.toISOString(),
        decidedAt: r.approval.decidedAt?.toISOString() ?? null,
        createdAt: r.approval.createdAt.toISOString(),
        run: { id: r.approval.runId, title: r.runTitle, status: r.runStatus },
        project: { id: r.approval.projectId, name: r.projectName, color: r.projectColor },
      })),
    });
  });

  app.post('/v1/approvals/:id/decision', async (c) => {
    const a = auth(c);
    const id = c.req.param('id');
    const body = await parseBody(c, ApprovalDecisionRequest);
    return withIdempotency(c, s, `POST /v1/approvals/${id}/decision`, body, async () => {
      const [ap] = await s.db.select().from(approvals).where(and(eq(approvals.id, id), eq(approvals.workspaceId, a.workspaceId)));
      if (!ap) {
        // AT-008: 他ユーザーの承認は存在を明かさず拒否し、試行を記録する（記録先は操作者自身の Workspace）
        log.warn('approval decision denied (not owner or missing)', { approvalId: id, actor: a.userId });
        await audit(s.db, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'approval.decision_denied', targetType: 'approval', targetId: id, detail: { reason: 'not_found_or_not_owner' } });
        throw notFound('Approval');
      }
      const deny = async (status: 403 | 409 | 410 | 400, code: string, message: string) => {
        await audit(s.db, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'approval.decision_rejected', targetType: 'approval', targetId: ap.id, detail: { code, decision: body.decision } });
        return new AppError(status, code, message);
      };
      if (ap.status !== 'pending') throw await deny(409, 'ALREADY_DECIDED', 'この承認は既に処理済みです');
      if (ap.version !== body.expectedVersion) throw await deny(409, 'VERSION_CONFLICT', '承認内容が更新されています。再読み込みしてください');
      if (ap.payloadDigest !== body.confirmationDigest) throw await deny(409, 'DIGEST_MISMATCH', '承認対象の内容が変わっています。内容を再確認してください');
      if (ap.expiresAt.getTime() <= Date.now()) throw await deny(410, 'APPROVAL_EXPIRED', '承認期限が切れています');
      if (ap.actionType === 'pr_review') {
        throw await deny(409, 'DECIDE_ON_GITHUB', 'Draft PR のレビューは GitHub 上で行います（ローカル版は GitHub シミュレーターを使用）');
      }
      if (ap.actionType === 'dangerous_operation' && body.decision === 'approve') {
        throw await deny(403, 'POLICY_FORBIDDEN', 'MVP では危険な操作は承認しても実行できません。差し戻し（安全な範囲で再計画）か却下を選んでください');
      }
      if (body.decision === 'request_changes' && !body.comment) {
        throw await deny(400, 'COMMENT_REQUIRED', '差し戻しには指示コメントが必要です');
      }
      const status = body.decision === 'approve' ? 'approved' : body.decision === 'request_changes' ? 'changes_requested' : 'rejected';

      const result = await s.engine.withRunLock(ap.runId, async () => {
        const [updated] = await s.db
          .update(approvals)
          .set({ status, version: sql`${approvals.version} + 1`, decidedBy: a.userId, decidedAt: new Date(), decisionComment: body.comment ?? null })
          .where(and(eq(approvals.id, ap.id), eq(approvals.workspaceId, a.workspaceId), eq(approvals.status, 'pending'), eq(approvals.version, body.expectedVersion)))
          .returning();
        if (!updated) return null;
        await s.bus.emit(a.workspaceId, 'approval.resolved', { approvalId: ap.id, status, decidedBy: a.userId }, { runId: ap.runId, projectId: ap.projectId });
        const [run] = await s.db.select().from(runs).where(and(eq(runs.id, ap.runId), eq(runs.workspaceId, a.workspaceId)));
        if (!run || run.status !== 'needs_input') return { updated, run };
        if (body.decision === 'reject') return { updated, run, cancel: true };
        // GitHub への書き込みの承認: 承認で PR の工程へ、差し戻しで implement からやり直す
        if (ap.actionType === 'publish') {
          const next = await s.engine.resumeAfterPublish(run.id, body.decision, body.comment ?? null);
          return { updated, run: next ?? run };
        }
        // 利用上限・ブランチ分岐による一時停止: 続行（承認）は止まった工程から再開、差し戻しはコメントを踏まえて再計画
        if (ap.payload.reason === 'usage_limit' || ap.payload.reason === 'branch_diverged') {
          const next =
            body.decision === 'approve' && typeof ap.payload.pausedStepId === 'string'
              ? await s.engine.resumePausedStep(run.id, ap.payload.pausedStepId)
              : await s.engine.resumeFromInput(run.id, body.comment ?? null, false);
          return { updated, run: next ?? run };
        }
        const guidance =
          ap.actionType === 'dangerous_operation'
            ? `危険な操作（${(ap.payload.detected as string[] | undefined)?.join('、') ?? ''}）は除外し、安全な範囲のみ実施。${body.comment ?? ''}`
            : body.comment ?? '現状の方針で続行';
        const next = await s.engine.resumeFromInput(run.id, guidance, ap.actionType === 'clarification');
        return { updated, run: next ?? run };
      });
      if (!result) throw await deny(409, 'VERSION_CONFLICT', '他の操作と競合しました。再読み込みしてください');
      let runStatus = result.run?.status ?? null;
      if (result.cancel && result.run) {
        const r = await s.engine.cancelRun(result.run.id, '承認者が却下');
        runStatus = r?.status ?? runStatus;
      }
      await audit(s.db, {
        workspaceId: a.workspaceId,
        actorUserId: a.userId,
        action: `approval.${status}`,
        targetType: 'approval',
        targetId: ap.id,
        detail: { runId: ap.runId, actionType: ap.actionType, digest: ap.payloadDigest, hasComment: Boolean(body.comment) },
      });
      return {
        status: 200 as const,
        body: { approvalId: ap.id, status, version: result.updated.version, runId: ap.runId, runStatus },
      };
    });
  });
}

