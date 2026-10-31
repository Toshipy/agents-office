/**
 * 3D オフィス用スナップショット（GET /v1/workspaces/me/office-state）と、
 * 席の表示状態の変化を agent.status_changed として配信する SeatWatcher。
 */
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import {
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  type OfficeState,
  type ProjectViewModel,
  type RunSummary,
  type SeatViewModel,
} from '@paw/contracts';
import { buildProjectStats, buildSeats, runProgress, type ProjectionInput } from '@paw/office-model';
import type { Db } from '../db/client';
import {
  agentDefinitions,
  approvals,
  eventLogs,
  projects,
  repositoryBindings,
  runSteps,
  runs,
  workspaces,
} from '../db/schema';
import type { EventBus } from '../events/bus';
import type { WorkflowEngine } from '../workflow/engine';

const DAY_MS = 24 * 3600_000;
const NON_TERMINAL = RUN_STATUSES.filter((s) => !TERMINAL_RUN_STATUSES.includes(s));

type RunRow = typeof runs.$inferSelect;
type StepRow = typeof runSteps.$inferSelect;

async function loadCore(db: Db, workspaceId: string, now: Date) {
  const since = new Date(now.getTime() - DAY_MS);
  const projectRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.status, 'active')))
    .orderBy(projects.position, projects.createdAt);
  const agentRows = await db.select().from(agentDefinitions).where(eq(agentDefinitions.workspaceId, workspaceId));
  const runRows = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.workspaceId, workspaceId),
        or(inArray(runs.status, [...NON_TERMINAL]), gte(runs.updatedAt, since)),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(300);
  const runIds = runRows.map((r) => r.id);
  const stepRows: StepRow[] = runIds.length
    ? await db
        .select()
        .from(runSteps)
        .where(and(eq(runSteps.workspaceId, workspaceId), inArray(runSteps.runId, runIds)))
    : [];
  const approvalRows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, 'pending')));
  const input: ProjectionInput = {
    now,
    workspaceId,
    projects: projectRows.map((p) => ({ id: p.id })),
    agents: agentRows.map((a) => ({ id: a.id, role: a.role, name: a.name, version: a.version })),
    runs: runRows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      title: r.title,
      status: r.status,
      prNumber: r.pr?.number ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      finishedAt: r.finishedAt,
    })),
    steps: stepRows
      .map((s) => {
        const run = runRows.find((r) => r.id === s.runId)!;
        return {
          id: s.id,
          runId: s.runId,
          projectId: run.projectId,
          role: s.role,
          key: s.key,
          status: s.status,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt,
        };
      }),
    approvals: approvalRows.map((a) => ({
      id: a.id,
      runId: a.runId,
      projectId: a.projectId,
      actionType: a.actionType,
      requestedByRole: a.requestedByRole,
      createdAt: a.createdAt,
    })),
  };
  return { projectRows, agentRows, runRows, stepRows, approvalRows, input };
}

export function summarizeRun(run: RunRow, steps: StepRow[]): RunSummary {
  const mine = steps.filter((s) => s.runId === run.id).sort((a, b) => a.seq - b.seq);
  const open = mine.filter((s) => s.status === 'running' || s.status === 'pending');
  const cur = open[open.length - 1] ?? mine[mine.length - 1] ?? null;
  return {
    id: run.id,
    projectId: run.projectId,
    title: run.title,
    status: run.status,
    statusVersion: run.statusVersion,
    sourceType: run.source.type,
    runtime: run.runtime,
    issueNumber: run.source.issueNumber ?? null,
    prNumber: run.pr?.number ?? null,
    currentStep: cur ? { key: cur.key, role: cur.role, status: cur.status } : null,
    progress: runProgress(run.status, cur?.key ?? null),
    revisionCount: run.revisionCount,
    costUsd: Math.round(run.costUsd * 10_000) / 10_000,
    errorCode: run.errorCode,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export async function buildOfficeState(db: Db, engine: WorkflowEngine, workspaceId: string): Promise<OfficeState> {
  // 連番は最初に読む（以降に発生したイベントを取りこぼさないため）
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) throw new Error('workspace not found');
  const now = new Date();
  const { projectRows, runRows, stepRows, approvalRows, input } = await loadCore(db, workspaceId, now);
  const bindingRows = projectRows.length
    ? await db
        .select()
        .from(repositoryBindings)
        .where(and(eq(repositoryBindings.workspaceId, workspaceId), inArray(repositoryBindings.projectId, projectRows.map((p) => p.id))))
    : [];
  const projectsVm: ProjectViewModel[] = projectRows.map((p) => {
    const b = bindingRows.find((x) => x.projectId === p.id);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      color: p.color,
      position: p.position,
      status: p.status,
      repo: b
        ? {
            fullName: b.fullName,
            claudeReady: engine.runtimeFor(b) !== 'simulated',
            automationEnabled: b.automationEnabled,
            triggerLabel: b.policy.triggerLabel,
            maxRevisionAttempts: b.policy.maxRevisionAttempts,
            events: b.policy.events,
          }
        : null,
      stats: buildProjectStats(input, p.id),
    };
  });
  const since = new Date(now.getTime() - DAY_MS);
  const [{ webhooks }] = await db
    .select({ webhooks: sql<number>`count(*)` })
    .from(eventLogs)
    .where(
      and(
        eq(eventLogs.workspaceId, workspaceId),
        inArray(eventLogs.eventType, ['webhook.received', 'webhook.ignored']),
        gte(eventLogs.occurredAt, since),
      ),
    );
  const activeProjectIds = new Set(projectRows.map((p) => p.id));
  const visibleRuns = runRows.filter((r) => activeProjectIds.has(r.projectId));
  const monthCost = await engine.monthCostUsd(workspaceId);
  return {
    workspace: {
      id: ws.id,
      name: ws.name,
      settings: {
        monthlyBudgetUsd: ws.monthlyBudgetUsd,
        runBudgetUsd: ws.runBudgetUsd,
        maxConcurrentRuns: ws.maxConcurrentRuns,
        demoTraffic: ws.demoTraffic,
        paused: ws.paused,
      },
    },
    projects: projectsVm,
    seats: buildSeats(input),
    hub: {
      queued: visibleRuns.filter((r) => r.status === 'queued').length,
      active: visibleRuns.filter((r) => ['planning', 'running', 'validating', 'pr_ready', 'revising', 'approved'].includes(r.status)).length,
      waitingApproval: approvalRows.filter((a) => activeProjectIds.has(a.projectId)).length,
      completed24h: visibleRuns.filter((r) => r.status === 'completed' && (r.finishedAt?.getTime() ?? 0) >= since.getTime()).length,
      webhooks24h: Number(webhooks),
      paused: ws.paused,
      budgetExceeded: monthCost >= ws.monthlyBudgetUsd,
    },
    runs: visibleRuns.slice(0, 120).map((r) => summarizeRun(r, stepRows)),
    approvalsPending: approvalRows.length,
    budget: { monthCostUsd: Math.round(monthCost * 10_000) / 10_000, monthlyBudgetUsd: ws.monthlyBudgetUsd },
    sequence: ws.eventSequence,
    generatedAt: now.toISOString(),
  };
}

/**
 * 席の表示状態（idle/working/...）が変わったら agent.status_changed を発行する。
 * 「完了」「失敗」の表示保持時間の経過もサーバー側で判定し、クライアントの演出に任せない。
 */
export class SeatWatcher {
  private last = new Map<string, Map<string, string>>();
  private pending = new Map<string, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  start() {
    this.unsubscribe = this.bus.onAny((e) => {
      if (e.sequence === null || e.type === 'agent.status_changed') return;
      this.schedule(e.workspaceId);
    });
    this.timer = setInterval(() => {
      for (const ws of this.last.keys()) if (this.bus.subscriberCount(ws) > 0) this.schedule(ws);
    }, 5_000);
  }

  stop() {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private schedule(workspaceId: string) {
    if (this.pending.has(workspaceId)) return;
    this.pending.set(
      workspaceId,
      setTimeout(() => {
        this.pending.delete(workspaceId);
        void this.refresh(workspaceId).catch(() => undefined);
      }, 150),
    );
  }

  async refresh(workspaceId: string): Promise<SeatViewModel[]> {
    const { input } = await loadCore(this.db, workspaceId, new Date());
    const seats = buildSeats(input);
    const prev = this.last.get(workspaceId);
    const next = new Map<string, string>();
    for (const s of seats) {
      const sig = `${s.status}|${s.currentRun?.id ?? ''}|${s.currentRun?.stepKey ?? ''}`;
      next.set(s.key, sig);
      if (prev && prev.get(s.key) !== sig) {
        await this.bus.emit(workspaceId, 'agent.status_changed', { seat: s }, { projectId: s.projectId });
      }
    }
    this.last.set(workspaceId, next);
    return seats;
  }
}
