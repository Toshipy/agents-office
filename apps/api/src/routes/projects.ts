import type { Hono } from 'hono';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  AGENT_ROLES,
  AutomationPolicyRequest,
  BindRepositoryRequest,
  CreateProjectRequest,
  LocalRepoRequest,
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
import { verifyRepository } from '../agents/claude/git';
import { GithubApiError } from '../github/app';
import { resolve } from 'node:path';
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
            defaultBranch: b.defaultBranch,
            automationEnabled: b.automationEnabled,
            policy: b.policy,
            // GitHub App 連携の管理クローンはサーバー内部のパスなので画面には出さない
            localPath: b.verification === 'github_app' ? null : b.localPath,
            managedCheckout: b.verification === 'github_app',
            testCommand: b.testCommand,
            runtime: s.engine.runtimeFor(b),
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

  /** GitHub 連携情報。GitHub App 設定時は App のインストール先、未設定時はローカルのシミュレーター */
  app.get('/v1/integrations/github/installations', async (c) => {
    const a = auth(c);
    const bindings = await s.db
      .select()
      .from(repositoryBindings)
      .where(eq(repositoryBindings.workspaceId, a.workspaceId));
    if (s.github) {
      let installations: Awaited<ReturnType<NonNullable<typeof s.github>['listInstallations']>> = [];
      let error: string | null = null;
      try {
        installations = await s.github.listInstallations();
      } catch (err) {
        error = err instanceof GithubApiError ? err.message : 'GitHub に接続できません';
      }
      return c.json({
        mode: 'github_app',
        note: 'GitHub App をインストールしたリポジトリを Project に接続できます。Issue・レビューは許可した GitHub ユーザーの操作だけを受け付けます。',
        allowedUsers: s.github.cfg.allowedUsers,
        error,
        installations: installations.map((i) => ({
          installationId: i.id,
          account: i.account,
          repositories: i.repositories.map((r) => ({
            fullName: r.fullName,
            repositoryId: r.id,
            private: r.private,
            projectId: bindings.find((b) => b.repositoryId === r.id)?.projectId ?? null,
          })),
        })),
      });
    }
    return c.json({
      mode: 'simulated',
      note: 'GitHub App が未設定のため GitHub には接続しません。署名付き Webhook をローカルのシミュレーターから送信します。',
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

    let values: Omit<typeof repositoryBindings.$inferInsert, 'id' | 'workspaceId' | 'projectId' | 'policy'>;
    if (s.github) {
      // GitHub App: インストール済みであることと実際の Repository ID・既定ブランチを GitHub API で確認する（10.2）
      const [owner, repo] = body.fullName.split('/');
      let installationId: number;
      let info: Awaited<ReturnType<NonNullable<typeof s.github>['getRepo']>>;
      try {
        installationId = (await s.github.findRepoInstallation(owner, repo)).id;
        info = await s.github.getRepo(installationId, owner, repo);
      } catch (err) {
        if (err instanceof GithubApiError && err.status === 404) {
          throw new AppError(422, 'GITHUB_APP_NOT_INSTALLED', `GitHub App が ${body.fullName} にインストールされていないか、リポジトリが見つかりません`);
        }
        throw new AppError(503, 'GITHUB_UNAVAILABLE', err instanceof GithubApiError ? err.message : 'GitHub に接続できません');
      }
      values = {
        installationId,
        repositoryId: info.id,
        fullName: info.fullName,
        verification: 'github_app',
        defaultBranch: info.defaultBranch,
        cloneUrl: info.cloneUrl,
        // サーバー上の管理クローン（初回の Run で取得）。Claude はここから作る Run 専用の作業コピーで作業する
        localPath: resolve(s.config.dataRoot, 'repos', String(info.id)),
      };
    } else {
      values = {
        installationId: simulatedInstallationId(a.workspaceId),
        repositoryId: simulatedRepositoryId(body.fullName),
        fullName: body.fullName,
      };
    }
    const [dup] = await s.db
      .select({ id: repositoryBindings.id })
      .from(repositoryBindings)
      .where(and(eq(repositoryBindings.workspaceId, a.workspaceId), eq(repositoryBindings.repositoryId, values.repositoryId)));
    if (dup) throw new AppError(409, 'REPO_BOUND_ELSEWHERE', 'この Repo は別の Project に接続済みです');
    const [b] = await s.db
      .insert(repositoryBindings)
      .values({
        id: newId('rbd'),
        workspaceId: a.workspaceId,
        projectId: project.id,
        ...values,
        automationEnabled: false, // FR-022: 接続直後は OFF
        policy: { triggerLabel: 'agents-office', events: ['issues.opened', 'issues.labeled'], maxRevisionAttempts: 3 },
      })
      .returning();
    await audit(s.db, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'repository.connected', targetType: 'project', targetId: project.id, detail: { fullName: b.fullName, verification: b.verification } });
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

  /** Claude が作業するローカル git リポジトリの設定（ローカル版のみ） */
  app.put('/v1/projects/:id/local-repo', async (c) => {
    const a = auth(c);
    const project = await ownedProject(s, a.workspaceId, c.req.param('id'));
    const body = await parseBody(c, LocalRepoRequest);
    const [binding] = await s.db
      .select()
      .from(repositoryBindings)
      .where(and(eq(repositoryBindings.projectId, project.id), eq(repositoryBindings.workspaceId, a.workspaceId)));
    if (!binding) throw new AppError(422, 'REPO_NOT_CONNECTED', '先に Repo を接続してください');
    if (await hasOpenRuns(a.workspaceId, project.id)) {
      throw new AppError(409, 'PROJECT_HAS_OPEN_RUNS', '進行中の Run があるため変更できません');
    }
    let localPath: string | null = null;
    if (binding.verification === 'github_app') {
      // GitHub App 連携はサーバー上の管理クローンを使う。変更できるのはテストコマンドだけ
      if (body.localPath) throw new AppError(422, 'MANAGED_CHECKOUT', 'GitHub App で接続した Repo は、サーバーが GitHub から取得した作業コピーを使います（パスは指定できません）');
      localPath = binding.localPath;
    } else if (body.localPath) {
      const v = await verifyRepository(body.localPath, s.config.dataRoot);
      if (!v.ok) throw new AppError(422, 'INVALID_LOCAL_REPO', v.reason);
      localPath = v.root;
    }
    const testCommand = body.testCommand && body.testCommand.length > 0 ? body.testCommand : null;
    await s.db
      .update(repositoryBindings)
      .set({ localPath, testCommand })
      .where(and(eq(repositoryBindings.id, binding.id), eq(repositoryBindings.workspaceId, a.workspaceId)));
    await audit(s.db, {
      workspaceId: a.workspaceId,
      actorUserId: a.userId,
      action: 'local_repo.updated',
      targetType: 'project',
      targetId: project.id,
      detail: { localPath, testCommand },
    });
    await s.bus.emit(a.workspaceId, 'project.updated', { action: 'local_repo_updated' }, { projectId: project.id });
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
