/**
 * Issue の入口 API。GitHub の Issue を「任せる候補」「資料済み」「実行中」に分けて見せ、
 * 画面から「AI に任せる」で Run を始める（ラベル付けと自分のアサインは IssueIntake が行う）。
 */
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppEnv, Services } from '../app';
import { repositoryBindings, workspaces } from '../db/schema';
import { AppError } from '../lib/errors';
import { audit } from '../services/audit';
import { auth, ownedProject, parseBody } from './helpers';

const DelegateRequest = z.object({ guidance: z.string().max(2000).optional() });

export function registerIssueRoutes(app: Hono<AppEnv>, s: Services) {
  app.get('/v1/projects/:id/issues', async (c) => {
    const a = auth(c);
    const project = await ownedProject(s, a.workspaceId, c.req.param('id'));
    return c.json(await s.issueIntake.list(project.id));
  });

  app.post('/v1/projects/:id/issues/:number/delegate', async (c) => {
    const a = auth(c);
    const project = await ownedProject(s, a.workspaceId, c.req.param('id'));
    const number = Number(c.req.param('number'));
    if (!Number.isSafeInteger(number) || number <= 0) throw new AppError(400, 'VALIDATION_ERROR', 'Issue 番号が不正です');
    const body = await parseBody(c, DelegateRequest);
    if (project.status !== 'active') throw new AppError(409, 'PROJECT_INACTIVE', 'アーカイブ済みの Project です');
    const [binding] = await s.db.select().from(repositoryBindings).where(eq(repositoryBindings.projectId, project.id));
    if (!binding || binding.verification !== 'github_app') throw new AppError(409, 'NOT_GITHUB_APP', 'GitHub App で接続した Repo の Project だけ Issue を任せられます');
    const [ws] = await s.db.select().from(workspaces).where(eq(workspaces.id, a.workspaceId));
    if (ws?.paused) throw new AppError(409, 'WORKSPACE_PAUSED', 'Workspace が停止中です');
    if (ws && (await s.engine.monthCostUsd(ws.id)) >= ws.monthlyBudgetUsd) throw new AppError(409, 'BUDGET_EXCEEDED', '今月の予算上限に達しています');
    const result = await s.issueIntake.start(binding, number, { via: 'ui', labeledBy: null, guidance: body.guidance?.trim() || null });
    if ('skipped' in result) {
      await s.bus.emit(
        a.workspaceId,
        'webhook.ignored',
        { deliveryId: `ui:${binding.repositoryId}#${number}`, event: 'issues.delegate', reason: result.skipped, repo: binding.fullName },
        { projectId: project.id, runId: null },
      );
      throw new AppError(409, 'ISSUE_SKIPPED', `この Issue は始められません（${result.skipped}）`, { reason: result.skipped });
    }
    await audit(s.db, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'issue.delegated', targetType: 'project', targetId: project.id, detail: { issueNumber: number, runId: result.runId } });
    return c.json({ runId: result.runId }, 201);
  });
}
