import type { Hono } from 'hono';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  AGENT_ROLES,
  AutomationPolicyRequest,
  BindRepositoryRequest,
  CreateProjectRequest,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  UpdateProjectRequest,
} from '@paw/contracts';
import type { AppEnv, Services } from '../app';
import { projects, repositoryBindings, runs } from '../db/schema';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { audit } from '../services/audit';
import { simulatedInstallationId, simulatedRepositoryId } from '../github/simulator';
import { auth, ownedProject, parseBody } from './helpers';

const NON_TERMINAL = RUN_STATUSES.filter((x) => !TERMINAL_RUN_STATUSES.includes(x));

export function registerProjectRoutes(app: Hono<AppEnv>, s: Services) {
  const projectJson = async (workspaceId: string, p: typeof projects.$inferSelect) => {
    const [b] = await s.db
      .select()
      .from(repositoryBindings)
      .where(and(eq(repositoryBindings.workspaceId, workspaceId), eq(repositoryBindings.projectId, p.id)));
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      color: p.color,
      position: p.position,
      status: p.status,
      agentConfig: p.agentConfig,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      repository: b
        ? {
            id: b.id,
            fullName: b.fullName,
            installationId: b.installationId,
            repositoryId: b.repositoryId,
            verification: b.verification,
            automationEnabled: b.automationEnabled,
            policy: b.policy,
          }
        : null,
    };
  };

  const hasOpenRuns = async (workspaceId: string, projectId: string) => {
    const open = await s.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.workspaceId, workspaceId), eq(runs.projectId, projectId), inArray(runs.status, NON_TERMINAL)))
      .limit(1);
    return open.length > 0;
  };

  app.get('/v1/projects', async (c) => {
    const a = auth(c);
    const includeArchived = c.req.query('includeArchived') === '1';
    const rows = await s.db
      .select()
      .from(projects)
      .where(
        includeArchived
          ? eq(projects.workspaceId, a.workspaceId)
          : and(eq(projects.workspaceId, a.workspaceId), eq(projects.status, 'active')),
      )
      .orderBy(asc(projects.position), asc(projects.createdAt));
    return c.json({ items: await Promise.all(rows.map((p) => projectJson(a.workspaceId, p))) });
  });

  app.post('/v1/projects', async (c) => {
    const a = auth(c);
    const body = await parseBody(c, CreateProjectRequest);
    const [{ count }] = await s.db
      .select({ count: sql<number>`count(*)` })
      .from(projects)
      .where(and(eq(projects.workspaceId, a.workspaceId), eq(projects.status, 'active')));
    if (Number(count) >= 8) throw new AppError(409, 'PROJECT_LIMIT', 'アクティブな Project は 8 件までです（ローカル版の表示上限）');
    const [{ maxPos }] = await s.db
      .select({ maxPos: sql<number>`coalesce(max(${projects.position}), -1)` })
      .from(projects)
      .where(eq(projects.workspaceId, a.workspaceId));
    const [p] = await s.db
      .insert(projects)
      .values({
        id: newId('prj'),
        workspaceId: a.workspaceId,
        name: body.name,
        description: body.description,
        color: body.color,
        position: Number(maxPos) + 1,
        agentConfig: { roles: [...AGENT_ROLES], workflow: 'issue_to_draft_pr' },
      })
      .returning();
    await audit(s.db, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'project.created', targetType: 'project', targetId: p.id, detail: { name: p.name } });
    await s.bus.emit(a.workspaceId, 'project.updated', { action: 'created' }, { projectId: p.id });
    return c.json(await projectJson(a.workspaceId, p), 201);
  });

  app.get('/v1/projects/:id', async (c) => {
    const a = auth(c);
    return c.json(await projectJson(a.workspaceId, await ownedProject(s, a.workspaceId, c.req.param('id'))));
  });

  app.patch('/v1/projects/:id', async (c) => {
    const a = auth(c);
    const project = await ownedProject(s, a.workspaceId, c.req.param('id'));
    const body = await parseBody(c, UpdateProjectRequest);
    if (body.status === 'archived' && project.status !== 'archived' && (await hasOpenRuns(a.workspaceId, project.id))) {
      throw new AppError(409, 'PROJECT_HAS_OPEN_RUNS', '進行中の Run があるためアーカイブできません。先に完了または中止してください');
    }
    const [p] = await s.db
      .update(projects)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(projects.id, project.id), eq(projects.workspaceId, a.workspaceId)))
      .returning();
    await audit(s.db, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'project.updated', targetType: 'project', targetId: p.id, detail: body });
    await s.bus.emit(a.workspaceId, 'project.updated', { action: 'updated' }, { projectId: p.id });
    return c.json(await projectJson(a.workspaceId, p));
  });

  /** ローカル版は GitHub App の代わりにシミュレーターの Installation を使う（ADR-012 の代替） */
  app.get('/v1/integrations/github/installations', async (c) => {
    const a = auth(c);
    const bindings = await s.db
      .select()
      .from(repositoryBindings)
      .where(eq(repositoryBindings.workspaceId, a.workspaceId));
    return c.json({
      mode: 'simulated',
      note: 'ローカル版は GitHub に接続しません。署名付き Webhook をローカルのシミュレーターから送信します。',
      installations: [
        {
          installationId: simulatedInstallationId(a.workspaceId),
          account: a.username,
          repositories: bindings.map((b) => ({ fullName: b.fullName, repositoryId: b.repositoryId, projectId: b.projectId })),
        },
      ],
    });
  });

  app.post('/v1/projects/:id/repositories', async (c) => {
    const a = auth(c);
    const project = await ownedProject(s, a.workspaceId, c.req.param('id'));
    const body = await parseBody(c, BindRepositoryRequest);
    const [existing] = await s.db.select().from(repositoryBindings).where(eq(repositoryBindings.projectId, project.id));
    if (existing) throw new AppError(409, 'REPO_ALREADY_CONNECTED', 'この Project には既に Repo が接続されています');
    const repositoryId = simulatedRepositoryId(body.fullName);
    const [dup] = await s.db
      .select({ id: repositoryBindings.id })
      .from(repositoryBindings)
      .where(and(eq(repositoryBindings.workspaceId, a.workspaceId), eq(repositoryBindings.repositoryId, repositoryId)));
    if (dup) throw new AppError(409, 'REPO_BOUND_ELSEWHERE', 'この Repo は別の Project に接続済みです');
    const [b] = await s.db
      .insert(repositoryBindings)
      .values({
        id: newId('rbd'),
        workspaceId: a.workspaceId,
        projectId: project.id,
        installationId: simulatedInstallationId(a.workspaceId),
        repositoryId,
        fullName: body.fullName,
        automationEnabled: false, // FR-022: 接続直後は OFF
        policy: { triggerLabel: 'ai:ready', events: ['issues.opened', 'issues.labeled'], maxRevisionAttempts: 3 },
      })
      .returning();
    await audit(s.db, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'repository.connected', targetType: 'project', targetId: project.id, detail: { fullName: b.fullName } });
    await s.bus.emit(a.workspaceId, 'project.updated', { action: 'repository_connected' }, { projectId: project.id });
    return c.json(await projectJson(a.workspaceId, project), 201);
  });

  app.delete('/v1/projects/:id/repositories', async (c) => {
    const a = auth(c);
    const project = await ownedProject(s, a.workspaceId, c.req.param('id'));
    if (await hasOpenRuns(a.workspaceId, project.id)) {
      throw new AppError(409, 'PROJECT_HAS_OPEN_RUNS', '進行中の Run があるため接続を解除できません');
    }
    await s.db
      .delete(repositoryBindings)
      .where(and(eq(repositoryBindings.projectId, project.id), eq(repositoryBindings.workspaceId, a.workspaceId)));
    await audit(s.db, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'repository.disconnected', targetType: 'project', targetId: project.id });
    await s.bus.emit(a.workspaceId, 'project.updated', { action: 'repository_disconnected' }, { projectId: project.id });
    return c.json(await projectJson(a.workspaceId, project));
  });

  app.put('/v1/projects/:id/automation-policy', async (c) => {
    const a = auth(c);
    const project = await ownedProject(s, a.workspaceId, c.req.param('id'));
    const body = await parseBody(c, AutomationPolicyRequest);
    const [b] = await s.db
      .update(repositoryBindings)
      .set({
        automationEnabled: body.enabled,
        policy: { triggerLabel: body.triggerLabel, events: body.events, maxRevisionAttempts: body.maxRevisionAttempts },
      })
      .where(and(eq(repositoryBindings.projectId, project.id), eq(repositoryBindings.workspaceId, a.workspaceId)))
      .returning();
    if (!b) throw new AppError(422, 'REPO_NOT_CONNECTED', '先に Repo を接続してください');
    await audit(s.db, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'automation_policy.updated', targetType: 'project', targetId: project.id, detail: body });
    await s.bus.emit(a.workspaceId, 'project.updated', { action: 'automation_updated', enabled: body.enabled }, { projectId: project.id });
    return c.json(await projectJson(a.workspaceId, project));
  });
}
