import type { Hono } from 'hono';
import { and, asc, desc, eq, gt, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import { CreateRunRequest, RUN_STATUSES, isTerminal, type RunStatus } from '@paw/contracts';
import type { AppEnv, Services } from '../app';
import {
  approvals,
  artifacts,
  eventLogs,
  projects,
  repositoryBindings,
  runSteps,
  runs,
  stepLogs,
  usageRecords,
  workspaces,
} from '../db/schema';
import { AppError, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { summarizeRun } from '../services/office';
import { branchFor } from '../workflow/engine';
import { auth, ownedProject, ownedRun, parseBody, withIdempotency } from './helpers';

function encodeCursor(createdAt: Date, id: string) {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}
function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()) || !/^run_[A-Za-z0-9]+$/.test(id)) return null;
    return { createdAt: d, id };
  } catch {
    return null;
  }
}

export function registerRunRoutes(app: Hono<AppEnv>, s: Services) {
  /** 手動 Run 作成（基本設計書 4.1 / 6.3）→ 202 Accepted */
  app.post('/v1/runs', async (c) => {
    const a = auth(c);
    const body = await parseBody(c, CreateRunRequest);
    return withIdempotency(c, s, 'POST /v1/runs', body, async () => {
      const project = await ownedProject(s, a.workspaceId, body.projectId);
      if (project.status !== 'active') throw new AppError(409, 'PROJECT_ARCHIVED', 'アーカイブ済みの Project です');
      const [binding] = await s.db
        .select()
        .from(repositoryBindings)
        .where(and(eq(repositoryBindings.projectId, project.id), eq(repositoryBindings.workspaceId, a.workspaceId)));
      if (!binding) throw new AppError(422, 'REPO_NOT_CONNECTED', 'Draft PR を作るには Project に Repo を接続してください');
      const [ws] = await s.db.select().from(workspaces).where(eq(workspaces.id, a.workspaceId));
      if (ws.paused) throw new AppError(409, 'WORKSPACE_PAUSED', 'キルスイッチで停止中です。設定から再開してください');
      if ((await s.engine.monthCostUsd(ws.id)) >= ws.monthlyBudgetUsd) {
        throw new AppError(402, 'BUDGET_EXCEEDED', '今月の予算上限に達しているため新しい Run を開始できません');
      }
      const title = body.title?.trim() || body.request.split('\n')[0].slice(0, 80);
      const run = await s.engine.createRun({
        workspaceId: a.workspaceId,
        projectId: project.id,
        title,
        request: body.request,
        source: { type: 'manual', requestedBy: a.userId },
        maxRevisionAttempts: binding.policy.maxRevisionAttempts,
        budgetLimitUsd: ws.runBudgetUsd,
        runtime: s.engine.runtimeFor(binding),
      });
      await audit(s.db, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'run.created', targetType: 'run', targetId: run.id, detail: { projectId: project.id } });
      return { status: 202, body: { runId: run.id, status: run.status, projectId: run.projectId, runtime: run.runtime } };
    });
  });

  /** Workspace 横断の Run 一覧（FR-006 / FR-013）— cursor-based pagination */
  app.get('/v1/runs', async (c) => {
    const a = auth(c);
    const statusParam = c.req.query('status');
    const statuses = statusParam
      ? statusParam.split(',').filter((x): x is RunStatus => (RUN_STATUSES as readonly string[]).includes(x))
      : [];
    const projectId = c.req.query('projectId');
    const q = c.req.query('q')?.trim().slice(0, 100);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 30) || 30, 1), 100);
    const cursor = c.req.query('cursor') ? decodeCursor(c.req.query('cursor')!) : null;
    const conds = [eq(runs.workspaceId, a.workspaceId)];
    if (statuses.length) conds.push(inArray(runs.status, statuses));
    if (projectId) conds.push(eq(runs.projectId, projectId));
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      conds.push(or(ilike(runs.title, like), ilike(runs.id, like))!);
    }
    if (cursor) {
      conds.push(or(lt(runs.createdAt, cursor.createdAt), and(eq(runs.createdAt, cursor.createdAt), lt(runs.id, cursor.id)))!);
    }
    const rows = await s.db
      .select()
      .from(runs)
      .where(and(...conds))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const steps = page.length
      ? await s.db.select().from(runSteps).where(and(eq(runSteps.workspaceId, a.workspaceId), inArray(runSteps.runId, page.map((r) => r.id))))
      : [];
    const projectRows = await s.db.select({ id: projects.id, name: projects.name, color: projects.color }).from(projects).where(eq(projects.workspaceId, a.workspaceId));
    const [{ total }] = await s.db.select({ total: sql<number>`count(*)` }).from(runs).where(and(...conds.slice(0, cursor ? -1 : undefined)));
    return c.json({
      items: page.map((r) => ({ ...summarizeRun(r, steps), project: projectRows.find((p) => p.id === r.projectId) ?? null })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null,
      total: Number(total),
    });
  });

  app.get('/v1/runs/:id', async (c) => {
    const a = auth(c);
    const run = await ownedRun(s, a.workspaceId, c.req.param('id'));
    const [project] = await s.db.select().from(projects).where(and(eq(projects.id, run.projectId), eq(projects.workspaceId, a.workspaceId)));
    const [binding] = await s.db.select().from(repositoryBindings).where(eq(repositoryBindings.projectId, run.projectId));
    const steps = await s.db.select().from(runSteps).where(and(eq(runSteps.runId, run.id), eq(runSteps.workspaceId, a.workspaceId))).orderBy(asc(runSteps.seq));
    const approvalRows = await s.db.select().from(approvals).where(and(eq(approvals.runId, run.id), eq(approvals.workspaceId, a.workspaceId))).orderBy(desc(approvals.createdAt));
    const artifactRows = await s.db.select().from(artifacts).where(and(eq(artifacts.runId, run.id), eq(artifacts.workspaceId, a.workspaceId))).orderBy(asc(artifacts.createdAt));
    const usageRows = await s.db.select().from(usageRecords).where(and(eq(usageRecords.runId, run.id), eq(usageRecords.workspaceId, a.workspaceId)));
    const events = await s.db
      .select()
      .from(eventLogs)
      .where(and(eq(eventLogs.workspaceId, a.workspaceId), eq(eventLogs.runId, run.id)))
      .orderBy(asc(eventLogs.sequence))
      .limit(300);
    const durationMs = run.startedAt ? (run.finishedAt ?? new Date()).getTime() - run.startedAt.getTime() : null;
    return c.json({
      run: {
        ...summarizeRun(run, steps),
        request: run.request,
        source: run.source,
        plan: run.plan,
        guidance: run.guidance,
        maxRevisionAttempts: run.maxRevisionAttempts,
        fixLoops: run.fixLoops,
        budgetLimitUsd: run.budgetLimitUsd,
        pr: run.pr,
        branch: branchFor(run.id),
        runtime: run.runtime,
        model:
          run.runtime === 'claude'
            ? s.config.claudeModel
            : run.runtime === 'claude_code'
              ? (usageRows.find((u) => u.model !== 'claude-code')?.model ?? s.config.claudeCode.model ?? 'Claude Code の既定モデル')
              : 'simulated-local',
        errorMessage: run.errorMessage,
        durationMs,
      },
      project: project ? { id: project.id, name: project.name, color: project.color } : null,
      repository: binding ? { fullName: binding.fullName, localPath: binding.localPath } : null,
      steps: steps.map((st) => ({
        id: st.id,
        seq: st.seq,
        key: st.key,
        role: st.role,
        agentId: st.agentId,
        agentVersion: st.agentVersion,
        model: st.model,
        status: st.status,
        attempt: st.attempt,
        maxAttempts: st.maxAttempts,
        revision: st.revision,
        summary: st.summary,
        errorCode: st.errorCode,
        startedAt: st.startedAt?.toISOString() ?? null,
        finishedAt: st.finishedAt?.toISOString() ?? null,
      })),
      approvals: approvalRows.map((ap) => ({ ...ap, expiresAt: ap.expiresAt.toISOString(), decidedAt: ap.decidedAt?.toISOString() ?? null, createdAt: ap.createdAt.toISOString() })),
      artifacts: artifactRows.map((ar) => ({ id: ar.id, kind: ar.kind, title: ar.title, stepId: ar.stepId, mediaType: ar.mediaType, sizeBytes: ar.sizeBytes, checksum: ar.checksum, createdAt: ar.createdAt.toISOString() })),
      usage: {
        measurement: !usageRows.length
          ? 'estimated'
          : usageRows.every((u) => u.measurement === 'measured')
            ? 'measured'
            : usageRows.every((u) => u.measurement === 'subscription')
              ? 'subscription'
              : 'estimated',
        inputTokens: usageRows.reduce((x, u) => x + u.inputTokens, 0),
        outputTokens: usageRows.reduce((x, u) => x + u.outputTokens, 0),
        estimatedCostUsd: usageRows.reduce((x, u) => x + u.estimatedCostUsd, 0),
        records: usageRows.length,
      },
      events: events.map((e) => ({ id: e.id, sequence: e.sequence, type: e.eventType, occurredAt: e.occurredAt.toISOString(), data: e.meta })),
    });
  });

  app.get('/v1/runs/:id/logs', async (c) => {
    const a = auth(c);
    const run = await ownedRun(s, a.workspaceId, c.req.param('id'));
    const after = Number(c.req.query('after') ?? 0) || 0;
    const stepId = c.req.query('stepId');
    const conds = [eq(stepLogs.workspaceId, a.workspaceId), eq(stepLogs.runId, run.id), gt(stepLogs.id, after)];
    if (stepId) conds.push(eq(stepLogs.stepId, stepId));
    const rows = await s.db.select().from(stepLogs).where(and(...conds)).orderBy(asc(stepLogs.id)).limit(500);
    return c.json({
      items: rows.map((r) => ({ id: r.id, runId: r.runId, stepId: r.stepId, ts: r.createdAt.toISOString(), kind: r.kind, message: r.message })),
    });
  });

  app.post('/v1/runs/:id/cancel', async (c) => {
    const a = auth(c);
    const run = await ownedRun(s, a.workspaceId, c.req.param('id'));
    if (isTerminal(run.status)) throw new AppError(409, 'RUN_ALREADY_FINISHED', 'この Run は既に終了しています');
    const row = await s.engine.cancelRun(run.id, `${a.displayName} が中止`);
    if (!row) throw new AppError(409, 'CANCEL_CONFLICT', '状態が変化したため中止できませんでした。再読み込みしてください');
    await audit(s.db, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'run.cancelled', targetType: 'run', targetId: run.id, detail: { from: run.status } });
    return c.json({ runId: row.id, status: row.status, statusVersion: row.statusVersion });
  });

  app.get('/v1/runs/:id/artifacts', async (c) => {
    const a = auth(c);
    const run = await ownedRun(s, a.workspaceId, c.req.param('id'));
    const rows = await s.db.select().from(artifacts).where(and(eq(artifacts.runId, run.id), eq(artifacts.workspaceId, a.workspaceId))).orderBy(asc(artifacts.createdAt));
    return c.json({ items: rows.map((ar) => ({ id: ar.id, kind: ar.kind, title: ar.title, mediaType: ar.mediaType, sizeBytes: ar.sizeBytes, checksum: ar.checksum, createdAt: ar.createdAt.toISOString() })) });
  });

  /** 所有権を確認してから内容を返す（パス名だけではアクセス制御にならない: 基本設計書 7.3） */
  app.get('/v1/artifacts/:id', async (c) => {
    const a = auth(c);
    const [row] = await s.db.select().from(artifacts).where(and(eq(artifacts.id, c.req.param('id')), eq(artifacts.workspaceId, a.workspaceId)));
    if (!row) throw notFound('Artifact');
    const content = await s.store.read(row);
    return c.json({
      id: row.id,
      runId: row.runId,
      kind: row.kind,
      title: row.title,
      mediaType: row.mediaType,
      checksum: row.checksum,
      createdAt: row.createdAt.toISOString(),
      content,
    });
  });
}
