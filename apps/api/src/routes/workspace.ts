import { authMethodLabel } from '../agents/claude/detect';
import type { Hono } from 'hono';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { ACTIVE_RUN_STATUSES, KillSwitchRequest, WorkspaceSettingsRequest } from '@paw/contracts';
import { aggregateAgentStatus } from '@paw/office-model';
import type { AppEnv, Services } from '../app';
import { agentDefinitions, auditLogs, projects, runs, usageRecords, workspaces } from '../db/schema';
import { audit } from '../services/audit';
import { buildOfficeState } from '../services/office';
import { SIM_PRICE_PER_MTOK } from '../workflow/engine';
import { auth, parseBody } from './helpers';

export function registerWorkspaceRoutes(app: Hono<AppEnv>, s: Services) {
  const loadWorkspace = async (workspaceId: string) => {
    const [ws] = await s.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    return ws;
  };
  const wsJson = (ws: typeof workspaces.$inferSelect) => ({
    id: ws.id,
    name: ws.name,
    settings: {
      monthlyBudgetUsd: ws.monthlyBudgetUsd,
      runBudgetUsd: ws.runBudgetUsd,
      maxConcurrentRuns: ws.maxConcurrentRuns,
      demoTraffic: ws.demoTraffic,
      paused: ws.paused,
    },
    createdAt: ws.createdAt.toISOString(),
  });

  app.get('/v1/me', async (c) => {
    const a = auth(c);
    const ws = await loadWorkspace(a.workspaceId);
    return c.json({
      user: { id: a.userId, username: a.username, displayName: a.displayName },
      workspace: wsJson(ws),
    });
  });

  app.get('/v1/workspaces/me', async (c) => c.json(wsJson(await loadWorkspace(auth(c).workspaceId))));

  app.patch('/v1/workspaces/me/settings', async (c) => {
    const a = auth(c);
    const body = await parseBody(c, WorkspaceSettingsRequest);
    const [ws] = await s.db.update(workspaces).set(body).where(eq(workspaces.id, a.workspaceId)).returning();
    await audit(s.db, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'settings.updated', targetType: 'workspace', targetId: a.workspaceId, detail: body });
    await s.bus.emit(a.workspaceId, 'workspace.updated', { settings: wsJson(ws).settings });
    return c.json(wsJson(ws));
  });

  /** キルスイッチ（FR-056 / R-04）: 新規開始の停止と、必要なら実行中 Run の一括中止 */
  app.post('/v1/workspaces/me/kill-switch', async (c) => {
    const a = auth(c);
    const body = await parseBody(c, KillSwitchRequest);
    const [ws] = await s.db
      .update(workspaces)
      .set({ paused: body.action === 'pause' })
      .where(eq(workspaces.id, a.workspaceId))
      .returning();
    let cancelled = 0;
    if (body.action === 'pause' && body.cancelActive) {
      const targets = await s.db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.workspaceId, a.workspaceId), inArray(runs.status, ['queued', ...ACTIVE_RUN_STATUSES.filter((x) => x !== 'approved')])));
      for (const t of targets) if (await s.engine.cancelRun(t.id, 'キルスイッチによる一括停止')) cancelled++;
    }
    await audit(s.db, {
      workspaceId: a.workspaceId,
      actorUserId: a.userId,
      action: body.action === 'pause' ? 'kill_switch.paused' : 'kill_switch.resumed',
      targetType: 'workspace',
      targetId: a.workspaceId,
      detail: { cancelActive: body.cancelActive, cancelled },
    });
    await s.bus.emit(a.workspaceId, 'workspace.updated', { settings: wsJson(ws).settings, cancelled });
    return c.json({ ...wsJson(ws), cancelled });
  });

  app.get('/v1/workspaces/me/office-state', async (c) => c.json(await buildOfficeState(s.db, s.engine, auth(c).workspaceId)));

  /** AI 実行基盤の状態（どの手段で Claude を動かすか・モデル・検出結果） */
  app.get('/v1/runtime', (c) => {
    const rt = s.config.agentRuntime;
    const cc = s.config.claudeCode;
    return c.json({
      runtime: rt,
      mode: s.config.agentRuntimeMode,
      reason: s.config.agentRuntimeReason,
      model: rt === 'claude' ? s.config.claudeModel : rt === 'claude_code' ? cc.model : null,
      effort: rt === 'claude' ? s.config.claudeEffort : rt === 'claude_code' ? cc.effort : null,
      fallbacks: rt === 'claude' ? 'default' : null,
      billing: rt === 'claude' ? 'api' : rt === 'claude_code' ? (cc.detected?.subscription === false ? 'api' : 'subscription') : 'none',
      claudeCode: {
        bin: cc.bin,
        restricted: cc.restricted,
        allowApiBilling: cc.allowApiBilling,
        maxTurns: cc.maxTurns,
        version: cc.detected?.version ?? null,
        loggedIn: cc.detected?.loggedIn ?? null,
        authMethod: cc.detected?.authMethod ?? null,
        authLabel: cc.detected ? authMethodLabel(cc.detected.authMethod) : null,
        problem: cc.detected?.problem ?? null,
      },
      stepTimeoutMs: rt === 'simulated' ? s.config.stepTimeoutMs : s.config.claudeStepTimeoutMs,
      note:
        rt === 'claude_code'
          ? 'ローカルリポジトリを設定した Project の Run は、この PC の Claude Code（ログイン中のサブスクの利用枠）で実行されます。利用上限に達すると Run は一時停止し、続行の判断を待ちます。'
          : rt === 'claude'
            ? 'ローカルリポジトリを設定した Project の Run は Claude API（従量課金）で実行されます。それ以外の Project はシミュレーションです。'
            : 'Claude Code にサブスクでログインするか ANTHROPIC_API_KEY を設定して API を再起動すると、ローカルリポジトリを設定した Project の Run が Claude で実行されます。',
    });
  });

  app.get('/v1/agents', async (c) => {
    const a = auth(c);
    const defs = await s.db.select().from(agentDefinitions).where(eq(agentDefinitions.workspaceId, a.workspaceId));
    const seats = await s.seats.refresh(a.workspaceId);
    const agg = aggregateAgentStatus(seats);
    return c.json({
      agents: defs.map((d) => ({
        id: d.id,
        role: d.role,
        name: d.name,
        model:
          s.config.agentRuntime === 'claude'
            ? s.config.claudeModel
            : s.config.agentRuntime === 'claude_code'
              ? (s.config.claudeCode.model ?? 'Claude Code の既定モデル')
              : d.model,
        runtime:
          d.role === 'tester'
            ? 'Project に設定したテストコマンド（ローカル worktree で実行）'
            : s.config.agentRuntime === 'claude'
              ? `Claude API（${s.config.claudeModel}・従量課金）— ローカルリポジトリ未設定の Project はシミュレーション`
              : s.config.agentRuntime === 'claude_code'
                ? 'Claude Code（この PC のログイン・サブスクの利用枠）— ローカルリポジトリ未設定の Project はシミュレーション'
                : 'Claude（未設定 → ローカルシミュレーション）',
        promptVersion: d.promptVersion,
        toolPolicy: d.toolPolicy,
        version: d.version,
        status: agg.get(d.id) ?? 'idle',
        activeRunIds: Array.from(new Set(seats.filter((x) => x.agentId === d.id).flatMap((x) => x.activeRunIds))),
        activeProjectIds: Array.from(new Set(seats.filter((x) => x.agentId === d.id).flatMap((x) => x.activeProjectIds))),
      })),
    });
  });

  /** FR-055 / NFR-021: 概算費用（推定・シミュレーション単価）と実行上限 */
  app.get('/v1/usage', async (c) => {
    const a = auth(c);
    const ws = await loadWorkspace(a.workspaceId);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const since14 = new Date(Date.now() - 13 * 24 * 3600_000);
    since14.setUTCHours(0, 0, 0, 0);
    const [month] = await s.db
      .select({
        cost: sql<number>`coalesce(sum(${usageRecords.estimatedCostUsd}), 0)`,
        inTok: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`,
        outTok: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`,
      })
      .from(usageRecords)
      .where(and(eq(usageRecords.workspaceId, a.workspaceId), gte(usageRecords.createdAt, monthStart)));
    const daily = await s.db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${usageRecords.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        cost: sql<number>`sum(${usageRecords.estimatedCostUsd})`,
        runs: sql<number>`count(distinct ${usageRecords.runId})`,
      })
      .from(usageRecords)
      .where(and(eq(usageRecords.workspaceId, a.workspaceId), gte(usageRecords.createdAt, since14)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const byProject = await s.db
      .select({
        projectId: runs.projectId,
        name: projects.name,
        cost: sql<number>`coalesce(sum(${runs.costUsd}), 0)`,
        runs: sql<number>`count(*)`,
      })
      .from(runs)
      .innerJoin(projects, eq(projects.id, runs.projectId))
      .where(and(eq(runs.workspaceId, a.workspaceId), gte(runs.createdAt, monthStart)))
      .groupBy(runs.projectId, projects.name);
    const [{ active }] = await s.db
      .select({ active: sql<number>`count(*)` })
      .from(runs)
      .where(and(eq(runs.workspaceId, a.workspaceId), inArray(runs.status, [...ACTIVE_RUN_STATUSES])));
    return c.json({
      measurement: 'estimated',
      note: 'ローカル版はシミュレーション単価による推定値です（実際のモデル料金ではありません）',
      pricePerMTok: SIM_PRICE_PER_MTOK,
      month: {
        costUsd: Number(month.cost),
        inputTokens: Number(month.inTok),
        outputTokens: Number(month.outTok),
        budgetUsd: ws.monthlyBudgetUsd,
      },
      limits: { runBudgetUsd: ws.runBudgetUsd, maxConcurrentRuns: ws.maxConcurrentRuns, activeRuns: Number(active), paused: ws.paused },
      daily: daily.map((d) => ({ day: d.day, costUsd: Number(d.cost), runs: Number(d.runs) })),
      byProject: byProject.map((p) => ({ projectId: p.projectId, name: p.name, costUsd: Number(p.cost), runs: Number(p.runs) })),
    });
  });

  app.get('/v1/audit-logs', async (c) => {
    const a = auth(c);
    const rows = await s.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.workspaceId, a.workspaceId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(100);
    return c.json({
      items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    });
  });
}
