/**
 * ローカル版ワークフローエンジン（AWS Step Functions Standard の代替: ADR-004）。
 *
 * - Run の状態遷移は要件定義書 5.1 の遷移表でのみ行い、status_version を楽観ロックで更新する
 * - 次工程は Runner ではなくエンジンが検証済みの StepResult から決定する（基本設計書 1.2「重要」）
 * - 再試行・タイムアウト・予算・同時実行数に上限を持つ（FR-035〜037 / NFR-017 / NFR-018）
 * - 状態はすべて DB に永続化し、プロセス再起動時に復旧する（FR-032 / NFR-014）
 * - レビュー待ちは DB に保持し、レビューイベントで新しい修正サイクルを開始する（基本設計書 4.3）
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  canTransition,
  type AgentRole,
  type AgentRuntime,
  type ApprovalActionType,
  type RunStatus,
  type StepKey,
  type StepRole,
} from '@paw/contracts';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import {
  agentDefinitions,
  approvals,
  repositoryBindings,
  runSteps,
  runs,
  stepLogs,
  usageRecords,
  workspaces,
  type PlanJson,
  type RunPr,
} from '../db/schema';
import type { EventBus } from '../events/bus';
import { newId } from '../lib/ids';
import { digestPayload } from '../lib/crypto';
import { log } from '../lib/logger';
import { Mutex } from '../lib/mutex';
import type { AgentRunner, StepExecutionContext, StepOutput } from '../agents/runner';
import { RunnerCrashError, RunnerError, UsageLimitError } from '../agents/runner';
import type { ArtifactStore } from './artifactStore';
import { authorizeTool } from './toolBroker';

export type RunRow = typeof runs.$inferSelect;
export type StepRow = typeof runSteps.$inferSelect;

/** テスト失敗・レビュー指摘による自動修正ループの上限 */
export const MAX_FIX_LOOPS = 2;
/** シミュレーション単価（推定）。実際のモデル単価ではない */
export const SIM_PRICE_PER_MTOK = { input: 3, output: 12 };
const APPROVAL_TTL_MS: Record<ApprovalActionType, number> = {
  pr_review: 14 * 24 * 3600_000,
  dangerous_operation: 72 * 3600_000,
  clarification: 72 * 3600_000,
};

const PlanSchema = z.object({
  steps: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        role: z.enum(['planner', 'developer', 'tester', 'reviewer', 'tool_broker']),
        dependsOn: z.array(z.string()),
      }),
    )
    .min(1)
    .max(20),
  maxRevisionAttempts: z.number().int().min(1).max(5),
  summary: z.string().max(500),
  flags: z.array(z.string().max(300)).max(20),
});

class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
}
class StepTimeoutError extends Error {
  readonly code = 'STEP_TIMEOUT';
}
class StepCancelledError extends Error {
  readonly code = 'CANCELLED';
}

interface Inflight {
  controller: AbortController;
  runId: string;
  cancelled: boolean;
}

export function branchFor(runId: string): string {
  return `ai/run-${runId.slice(4, 14).toLowerCase()}`;
}

export class WorkflowEngine {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastSweep = 0;
  private inflight = new Map<string, Inflight>();
  private runLocks = new Map<string, Mutex>();
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly store: ArtifactStore,
    private readonly runner: AgentRunner,
    private readonly config: AppConfig,
  ) {}

  /* ------------------------------------------------------------ */
  /* lifecycle                                                     */
  /* ------------------------------------------------------------ */

  async start() {
    this.stopped = false;
    await this.recover();
    this.timer = setInterval(() => void this.tick(), this.config.tickMs);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const f of this.inflight.values()) f.controller.abort(new StepCancelledError('engine stopped'));
    // 実行中ステップの後始末を待つ
    for (let i = 0; i < 50 && this.inflight.size > 0; i++) await new Promise((r) => setTimeout(r, 20));
  }

  inflightCount() {
    return this.inflight.size;
  }

  /** テストから同期的に進めるための公開メソッド */
  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.scheduleQueued();
      await this.launchPendingSteps();
      if (Date.now() - this.lastSweep > 5_000) {
        this.lastSweep = Date.now();
        await this.sweepStuckRuns();
        await this.sweepExpiredApprovals();
      }
    } catch (err) {
      log.error('engine tick failed', { err: String(err), stack: (err as Error).stack });
    } finally {
      this.ticking = false;
    }
  }

  private lockFor(runId: string): Mutex {
    let m = this.runLocks.get(runId);
    if (!m) {
      m = new Mutex();
      this.runLocks.set(runId, m);
    }
    return m;
  }

  withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    return this.lockFor(runId).run(fn);
  }

  /* ------------------------------------------------------------ */
  /* Run creation / transitions                                    */
  /* ------------------------------------------------------------ */

  async createRun(args: {
    workspaceId: string;
    projectId: string;
    title: string;
    request: string;
    source: RunRow['source'];
    issueKey?: string | null;
    maxRevisionAttempts: number;
    budgetLimitUsd: number;
    runtime?: AgentRuntime;
  }): Promise<RunRow> {
    const [run] = await this.db
      .insert(runs)
      .values({
        id: newId('run'),
        workspaceId: args.workspaceId,
        projectId: args.projectId,
        title: args.title,
        request: args.request,
        workflow: 'issue_to_draft_pr',
        runtime: args.runtime ?? 'simulated',
        source: args.source,
        issueKey: args.issueKey ?? null,
        status: 'queued',
        maxRevisionAttempts: args.maxRevisionAttempts,
        budgetLimitUsd: args.budgetLimitUsd,
      })
      .returning();
    await this.bus.emit(
      run.workspaceId,
      'run.created',
      { title: run.title, status: run.status, source: run.source.type, runtime: run.runtime },
      { runId: run.id, projectId: run.projectId },
    );
    return run;
  }

  /**
   * 遷移表に従い楽観ロック付きで状態を更新する。
   * 現在の状態が既に `to` の場合は何もせず現在行を返す（復旧処理の再入を許すため）。
   */
  async transition(
    runId: string,
    to: RunStatus,
    patch: Partial<typeof runs.$inferInsert> = {},
  ): Promise<RunRow | null> {
    const [cur] = await this.db.select().from(runs).where(eq(runs.id, runId));
    if (!cur) return null;
    if (cur.status === to) return cur;
    if (!canTransition(cur.status, to)) {
      log.warn('rejected run transition', { runId, from: cur.status, to });
      return null;
    }
    const now = new Date();
    const terminal = TERMINAL_RUN_STATUSES.includes(to);
    const [row] = await this.db
      .update(runs)
      .set({
        ...patch,
        status: to,
        statusVersion: cur.statusVersion + 1,
        updatedAt: now,
        ...(to === 'planning' && !cur.startedAt ? { startedAt: now } : {}),
        ...(terminal ? { finishedAt: now } : {}),
      })
      .where(and(eq(runs.id, runId), eq(runs.statusVersion, cur.statusVersion)))
      .returning();
    if (!row) {
      log.warn('run transition lost optimistic lock', { runId, to });
      return null;
    }
    await this.bus.emit(
      row.workspaceId,
      'run.status_changed',
      { from: cur.status, to, statusVersion: row.statusVersion, errorCode: row.errorCode },
      { runId, projectId: row.projectId },
    );
    if (terminal) {
      await this.bus.emit(
        row.workspaceId,
        'run.completed',
        { status: to, errorCode: row.errorCode, costUsd: row.costUsd },
        { runId, projectId: row.projectId },
      );
      this.runLocks.delete(runId);
      void this.cleanupRun(row);
    }
    return row;
  }

  /** Project の設定から、この Run を Claude（API / Claude Code）で実行するかを決める */
  runtimeFor(binding: { localPath: string | null } | null | undefined): AgentRuntime {
    return this.config.agentRuntime !== 'simulated' && binding?.localPath ? this.config.agentRuntime : 'simulated';
  }

  private async cleanupRun(run: RunRow) {
    if (run.runtime === 'simulated' || !this.runner.onRunFinished) return;
    try {
      const [binding] = await this.db.select().from(repositoryBindings).where(eq(repositoryBindings.projectId, run.projectId));
      await this.runner.onRunFinished(run.id, binding?.localPath ?? null, branchFor(run.id));
    } catch (err) {
      log.warn('run cleanup failed', { runId: run.id, err: String(err) });
    }
  }

  private async addStep(run: RunRow, key: StepKey, role: StepRole, revision: number): Promise<StepRow> {
    const [{ maxSeq }] = await this.db
      .select({ maxSeq: sql<number>`coalesce(max(${runSteps.seq}), 0)` })
      .from(runSteps)
      .where(eq(runSteps.runId, run.id));
    const [step] = await this.db
      .insert(runSteps)
      .values({
        id: newId('stp'),
        workspaceId: run.workspaceId,
        runId: run.id,
        seq: Number(maxSeq) + 1,
        key,
        role,
        revision,
        status: 'pending',
        maxAttempts: role === 'tool_broker' ? 3 : 2,
      })
      .returning();
    return step;
  }

  private async createApproval(
    run: RunRow,
    actionType: ApprovalActionType,
    requestedByRole: AgentRole,
    title: string,
    payload: Record<string, unknown>,
  ) {
    const [existing] = await this.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.runId, run.id), eq(approvals.status, 'pending')));
    if (existing) return; // 冪等（復旧処理の再入時）
    const id = newId('apr');
    const digest = digestPayload({ approvalId: id, actionType, runId: run.id, payload });
    await this.db.insert(approvals).values({
      id,
      workspaceId: run.workspaceId,
      runId: run.id,
      projectId: run.projectId,
      actionType,
      requestedByRole,
      title,
      payload,
      payloadDigest: digest,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS[actionType]),
    });
    await this.bus.emit(
      run.workspaceId,
      'approval.requested',
      { approvalId: id, actionType, title },
      { runId: run.id, projectId: run.projectId },
    );
  }

  async supersedePendingApprovals(runId: string) {
    const rows = await this.db
      .update(approvals)
      .set({ status: 'superseded', version: sql`${approvals.version} + 1` })
      .where(and(eq(approvals.runId, runId), eq(approvals.status, 'pending')))
      .returning();
    for (const a of rows) {
      await this.bus.emit(
        a.workspaceId,
        'approval.resolved',
        { approvalId: a.id, status: 'superseded' },
        { runId, projectId: a.projectId },
      );
    }
  }

  async failRun(runId: string, errorCode: string, errorMessage: string) {
    const row = await this.transition(runId, 'failed', { errorCode, errorMessage });
    if (!row) return;
    await this.db
      .update(runSteps)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(runSteps.runId, runId), inArray(runSteps.status, ['pending', 'needs_input'])));
    await this.supersedePendingApprovals(runId);
  }

  /** 利用者による中止（FR-037）。実行中 Runner は AbortSignal で停止させる */
  async cancelRun(runId: string, reason: string): Promise<RunRow | null> {
    return this.withRunLock(runId, async () => {
      const row = await this.transition(runId, 'cancelled', {
        errorCode: 'CANCELLED_BY_USER',
        errorMessage: reason,
      });
      if (!row) return null;
      for (const f of this.inflight.values()) {
        if (f.runId === runId) {
          f.cancelled = true;
          f.controller.abort(new StepCancelledError(reason));
        }
      }
      await this.db
        .update(runSteps)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(and(eq(runSteps.runId, runId), inArray(runSteps.status, ['pending', 'running', 'needs_input'])));
      await this.supersedePendingApprovals(runId);
      return row;
    });
  }

  /* ------------------------------------------------------------ */
  /* Scheduling                                                    */
  /* ------------------------------------------------------------ */

  async monthCostUsd(workspaceId: string): Promise<number> {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const [r] = await this.db
      .select({ total: sql<number>`coalesce(sum(${usageRecords.estimatedCostUsd}), 0)` })
      .from(usageRecords)
      .where(and(eq(usageRecords.workspaceId, workspaceId), gte(usageRecords.createdAt, start)));
    return Number(r.total);
  }

  private async scheduleQueued() {
    const queuedWs = await this.db
      .selectDistinct({ workspaceId: runs.workspaceId })
      .from(runs)
      .where(eq(runs.status, 'queued'));
    for (const { workspaceId } of queuedWs) {
      const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
      if (!ws || ws.paused) continue;
      const [{ active }] = await this.db
        .select({ active: sql<number>`count(*)` })
        .from(runs)
        .where(and(eq(runs.workspaceId, workspaceId), inArray(runs.status, [...ACTIVE_RUN_STATUSES])));
      const slots = ws.maxConcurrentRuns - Number(active);
      if (slots <= 0) continue;
      // 予算超過中は新規開始を保留（FR-036 / FR-056）
      if ((await this.monthCostUsd(workspaceId)) >= ws.monthlyBudgetUsd) continue;
      const next = await this.db
        .select()
        .from(runs)
        .where(and(eq(runs.workspaceId, workspaceId), eq(runs.status, 'queued')))
        .orderBy(asc(runs.createdAt))
        .limit(slots);
      for (const run of next) {
        await this.withRunLock(run.id, async () => {
          const row = await this.transition(run.id, 'planning');
          if (row && row.status === 'planning') await this.addStep(row, 'plan', 'planner', row.revisionCount);
        });
      }
    }
  }

  private async launchPendingSteps() {
    const now = new Date();
    const pending = await this.db
      .select({ step: runSteps })
      .from(runSteps)
      .innerJoin(runs, eq(runs.id, runSteps.runId))
      .where(
        and(
          eq(runSteps.status, 'pending'),
          or(isNull(runSteps.nextAttemptAt), lte(runSteps.nextAttemptAt, now)),
          inArray(runs.status, ['planning', 'running', 'validating', 'revising']),
        ),
      )
      .orderBy(asc(runSteps.createdAt))
      .limit(50);
    for (const { step } of pending) {
      if (this.inflight.has(step.id)) continue;
      void this.executeStep(step.id);
    }
  }

  /* ------------------------------------------------------------ */
  /* Step execution                                                */
  /* ------------------------------------------------------------ */

  private async executeStep(stepId: string) {
    const controller = new AbortController();
    const [claimed] = await this.db
      .update(runSteps)
      .set({
        status: 'running',
        attempt: sql`${runSteps.attempt} + 1`,
        startedAt: new Date(),
        finishedAt: null,
        nextAttemptAt: null,
      })
      .where(and(eq(runSteps.id, stepId), eq(runSteps.status, 'pending')))
      .returning();
    if (!claimed) return;
    const flight: Inflight = { controller, runId: claimed.runId, cancelled: false };
    this.inflight.set(stepId, flight);
    let timeout: NodeJS.Timeout | undefined;
    try {
      // Claude で実行する工程はモデルの応答やテストに時間がかかるため、シミュレーションとは別の上限を使う
      const [rt] = await this.db.select({ runtime: runs.runtime }).from(runs).where(eq(runs.id, claimed.runId));
      const timeoutMs = rt && rt.runtime !== 'simulated' ? this.config.claudeStepTimeoutMs : this.config.stepTimeoutMs;
      timeout = setTimeout(() => controller.abort(new StepTimeoutError(`step timed out after ${timeoutMs}ms`)), timeoutMs);
      const prepared = await this.withRunLock(claimed.runId, () => this.prepareStep(claimed));
      if (!prepared) return;
      const ctx = this.buildContext(prepared.step, prepared.run, prepared, controller.signal);
      await this.bus.emit(
        prepared.run.workspaceId,
        'step.started',
        { stepId, key: claimed.key, role: claimed.role, attempt: claimed.attempt },
        { runId: claimed.runId, projectId: prepared.run.projectId },
      );
      let out: StepOutput;
      try {
        out = await this.runner.execute(ctx);
        if (controller.signal.aborted) throw controller.signal.reason;
      } catch (err) {
        clearTimeout(timeout);
        await this.withRunLock(claimed.runId, () => this.handleStepError(prepared.step, prepared.run, err, flight));
        return;
      }
      clearTimeout(timeout);
      await this.withRunLock(claimed.runId, () => this.finishStep(prepared.step, out));
    } catch (err) {
      log.error('executeStep failed', { stepId, err: String(err), stack: (err as Error).stack });
    } finally {
      clearTimeout(timeout);
      this.inflight.delete(stepId);
    }
  }

  /** 工程に表示するモデル名（Claude の工程は実行後に実際のモデル名で上書きする） */
  private stepModelLabel(runtime: AgentRuntime, role: StepRole, agentModel: string | null): string {
    if (role === 'tool_broker') return 'policy-broker';
    if (runtime === 'simulated') return agentModel ?? 'simulated-local';
    if (role === 'tester') return 'test-command';
    return runtime === 'claude' ? this.config.claudeModel : (this.config.claudeCode.model ?? 'claude-code');
  }

  private async prepareStep(step: StepRow) {
    const [run] = await this.db.select().from(runs).where(eq(runs.id, step.runId));
    if (!run || TERMINAL_RUN_STATUSES.includes(run.status) || run.status === 'waiting_review' || run.status === 'needs_input') {
      await this.db
        .update(runSteps)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(eq(runSteps.id, step.id));
      return null;
    }
    let current = run;
    if (step.key === 'implement' && run.status === 'revising') {
      current = (await this.transition(run.id, 'running')) ?? run;
    }
    const [binding] = await this.db
      .select()
      .from(repositoryBindings)
      .where(eq(repositoryBindings.projectId, run.projectId));
    const agent =
      step.role === 'tool_broker'
        ? null
        : (
            await this.db
              .select()
              .from(agentDefinitions)
              .where(and(eq(agentDefinitions.workspaceId, run.workspaceId), eq(agentDefinitions.role, step.role)))
          )[0] ?? null;
    const [updated] = await this.db
      .update(runSteps)
      .set({ agentId: agent?.id ?? null, agentVersion: agent?.version ?? null, model: this.stepModelLabel(run.runtime, step.role, agent?.model ?? null) })
      .where(eq(runSteps.id, step.id))
      .returning();
    const prior = await this.db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, run.id), eq(runSteps.status, 'succeeded')))
      .orderBy(asc(runSteps.seq));
    const previous: Record<string, unknown> = {};
    for (const p of prior) {
      const o = p.outcome ?? {};
      if (p.key === 'plan' && o.detail) previous.planDetail = o.detail;
      if (p.key === 'implement') {
        previous.diff = o.diff;
        previous.developerSummary = o.developerSummary;
        delete previous.lastFailure;
      }
      if (p.key === 'test') {
        previous.testsPassed = o.passed;
        previous.testsSkipped = o.skipped === true;
        if (!o.passed) previous.lastFailure = o.failure;
      }
      if (p.key === 'review') {
        previous.reviewSummary = o.reviewSummary;
        if (Array.isArray(o.blockers) && o.blockers.length) previous.lastFailure = (o.blockers as string[]).join(' / ');
      }
    }
    return { step: updated, run: current, binding: binding ?? null, agent, previous };
  }

  private buildContext(
    step: StepRow,
    run: RunRow,
    prepared: {
      binding: typeof repositoryBindings.$inferSelect | null;
      agent: typeof agentDefinitions.$inferSelect | null;
      previous: Record<string, unknown>;
    },
    signal: AbortSignal,
  ): StepExecutionContext {
    const { binding, agent } = prepared;
    const ws = run.workspaceId;
    const speed = this.config.simSpeed;
    const assertActive = () => {
      if (signal.aborted) throw signal.reason;
    };
    const appendLog = async (kind: 'log' | 'tool' | 'policy' | 'error', message: string) => {
      const [row] = await this.db
        .insert(stepLogs)
        .values({ workspaceId: ws, runId: run.id, stepId: step.id, kind, message })
        .returning();
      this.bus.emitTransient(
        ws,
        'step.log',
        { line: { id: row.id, runId: run.id, stepId: step.id, ts: row.createdAt.toISOString(), kind, message } },
        { runId: run.id, projectId: run.projectId },
      );
    };
    return {
      runId: run.id,
      stepId: step.id,
      workspaceId: ws,
      projectId: run.projectId,
      role: step.role,
      key: step.key,
      attempt: step.attempt,
      revision: step.revision,
      title: run.title,
      request: run.request,
      guidance: run.guidance,
      repo: binding?.fullName ?? null,
      branch: branchFor(run.id),
      fixLoops: run.fixLoops,
      previous: prepared.previous,
      pr: run.pr ? { number: run.pr.number, url: run.pr.url, branch: run.pr.branch, headSha: run.pr.headSha } : null,
      runtime: run.runtime,
      localRepo: binding?.localPath ? { path: binding.localPath, testCommand: binding.testCommand } : null,
      remote:
        binding && binding.verification === 'github_app' && binding.cloneUrl && binding.defaultBranch
          ? {
              provider: 'github',
              installationId: binding.installationId,
              repositoryId: binding.repositoryId,
              fullName: binding.fullName,
              defaultBranch: binding.defaultBranch,
              cloneUrl: binding.cloneUrl,
            }
          : null,
      issueNumber: run.source.type === 'github_issue' ? (run.source.issueNumber ?? null) : null,
      signal,
      log: async (message, kind = 'log') => {
        assertActive();
        await appendLog(kind, message);
      },
      tool: async (tool, args, summary) => {
        assertActive();
        const decision = authorizeTool({
          role: step.role,
          tool,
          args,
          allowedTools: agent?.toolPolicy ?? [],
          boundRepo: binding?.fullName ?? null,
        });
        if (decision.allowed) {
          await appendLog('tool', `${tool} — ${summary}`);
        } else {
          await appendLog('policy', `拒否: ${tool} — ${decision.reason}`);
          await this.bus.emit(
            ws,
            'policy.denied',
            { stepId: step.id, role: step.role, tool, reason: decision.reason },
            { runId: run.id, projectId: run.projectId },
          );
        }
        return decision;
      },
      sleep: (ms) =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          const d = Math.max(0, ms * speed);
          if (d === 0) return resolve();
          const t = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, d);
          const onAbort = () => {
            clearTimeout(t);
            reject(signal.reason);
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      artifact: async (kind, title, filename, mediaType, content) => {
        assertActive();
        const row = await this.store.put({
          workspaceId: ws,
          runId: run.id,
          stepId: step.id,
          kind,
          title,
          filename,
          mediaType,
          content,
        });
        await this.bus.emit(
          ws,
          'artifact.created',
          { artifactId: row.id, kind, title },
          { runId: run.id, projectId: run.projectId },
        );
        return row;
      },
      usage: async (model, inputTokens, outputTokens, durationMs, extra) => {
        // Claude で実行した工程は、実際に応答したモデル名を工程に記録する
        if (run.runtime !== 'simulated' && model) {
          await this.db.update(runSteps).set({ model: model.slice(0, 80) }).where(eq(runSteps.id, step.id));
        }
        const cost = extra?.costUsd ?? (inputTokens * SIM_PRICE_PER_MTOK.input + outputTokens * SIM_PRICE_PER_MTOK.output) / 1_000_000;
        await this.db.insert(usageRecords).values({
          id: newId('use'),
          workspaceId: ws,
          runId: run.id,
          stepId: step.id,
          model,
          inputTokens,
          outputTokens,
          durationMs,
          estimatedCostUsd: cost,
          measurement: extra?.measurement ?? 'estimated',
        });
        const [updated] = await this.db
          .update(runs)
          .set({ costUsd: sql`${runs.costUsd} + ${cost}` })
          .where(eq(runs.id, run.id))
          .returning({ costUsd: runs.costUsd, budget: runs.budgetLimitUsd });
        if (updated && updated.costUsd > updated.budget) {
          throw new BudgetExceededError(
            `Run の予算上限 $${updated.budget.toFixed(2)} を超過（推定 $${updated.costUsd.toFixed(2)}）`,
          );
        }
      },
      allocatePrNumber: async () => {
        if (!binding) throw new Error('repository binding missing');
        const [r] = await this.db
          .update(repositoryBindings)
          .set({ nextPrNumber: sql`${repositoryBindings.nextPrNumber} + 1` })
          .where(eq(repositoryBindings.id, binding.id))
          .returning({ next: repositoryBindings.nextPrNumber });
        return r.next - 1;
      },
    };
  }

  private async handleStepError(step: StepRow, run: RunRow, err: unknown, flight: Inflight) {
    const now = new Date();
    // プロセス停止時は running のまま残し、次回起動時の recover() で再開させる
    if (this.stopped && !flight.cancelled) return;
    if (flight.cancelled || err instanceof StepCancelledError) {
      await this.db.update(runSteps).set({ status: 'cancelled', finishedAt: now }).where(eq(runSteps.id, step.id));
      return;
    }
    if (err instanceof UsageLimitError) {
      await this.pauseForUsageLimit(step, run, err);
      return;
    }
    const code =
      err instanceof RunnerError
        ? err.code
        : err instanceof BudgetExceededError
        ? 'BUDGET_EXCEEDED'
        : err instanceof StepTimeoutError
          ? 'STEP_TIMEOUT'
          : err instanceof RunnerCrashError
            ? 'RUNNER_CRASHED'
            : 'STEP_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    const [fresh] = await this.db.select().from(runSteps).where(eq(runSteps.id, step.id));
    const attempt = fresh?.attempt ?? step.attempt;
    const retryable = code !== 'BUDGET_EXCEEDED' && !(err instanceof RunnerError && !err.retryable) && attempt < step.maxAttempts;
    await this.db.insert(stepLogs).values({
      workspaceId: run.workspaceId,
      runId: run.id,
      stepId: step.id,
      kind: 'error',
      message: `${code}: ${message}${retryable ? `（再試行 ${attempt + 1}/${step.maxAttempts}）` : ''}`,
    });
    if (retryable) {
      const backoff = Math.min(30_000, 1000 * 2 ** attempt) * Math.max(this.config.simSpeed, 0.01);
      await this.db
        .update(runSteps)
        .set({ status: 'pending', errorCode: code, nextAttemptAt: new Date(Date.now() + backoff) })
        .where(eq(runSteps.id, step.id));
      await this.bus.emit(
        run.workspaceId,
        'step.finished',
        { stepId: step.id, key: step.key, role: step.role, status: 'retrying', errorCode: code, attempt },
        { runId: run.id, projectId: run.projectId },
      );
      return;
    }
    await this.db
      .update(runSteps)
      .set({ status: 'failed', errorCode: code, summary: message.slice(0, 300), finishedAt: now })
      .where(eq(runSteps.id, step.id));
    await this.bus.emit(
      run.workspaceId,
      'step.finished',
      { stepId: step.id, key: step.key, role: step.role, status: 'failed', errorCode: code },
      { runId: run.id, projectId: run.projectId },
    );
    await this.failRun(run.id, code, message);
  }

  private async finishStep(step: StepRow, out: StepOutput) {
    const [row] = await this.db
      .update(runSteps)
      .set({
        status: out.status,
        summary: out.summary.slice(0, 300),
        outcome: out.outcome,
        errorCode: out.errorCode ?? null,
        finishedAt: new Date(),
      })
      .where(and(eq(runSteps.id, step.id), eq(runSteps.status, 'running')))
      .returning();
    if (!row) return; // 既に中止済み
    const [run] = await this.db.select().from(runs).where(eq(runs.id, step.runId));
    if (!run) return;
    await this.bus.emit(
      run.workspaceId,
      'step.finished',
      { stepId: step.id, key: step.key, role: step.role, status: out.status, summary: row.summary },
      { runId: run.id, projectId: run.projectId },
    );
    if (out.status === 'failed') {
      await this.failRun(run.id, out.errorCode ?? 'STEP_FAILED', out.summary);
      return;
    }
    await this.advance(run, row);
  }

  /** 検証済みの StepResult から次工程を決める（Runner は次工程を決められない） */
  private async advance(run: RunRow, step: StepRow) {
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return;
    const o = step.outcome ?? {};
    switch (step.key) {
      case 'plan': {
        if (o.needsInput === true && o.reason === 'clarification') {
          const r = await this.transition(run.id, 'needs_input');
          if (!r) return;
          await this.createApproval(r, 'clarification', 'planner', '要件の確認が必要です', {
            reason: 'requirements_unclear',
            questions: o.questions,
            requestExcerpt: run.request.slice(0, 600),
            note: '回答をコメントに書いて差し戻すと、その内容を踏まえて再計画します。',
          });
          return;
        }
        if (o.needsInput === true) {
          const r = await this.transition(run.id, 'needs_input');
          if (!r) return;
          await this.createApproval(r, 'dangerous_operation', 'planner', '危険な操作を含む依頼のため停止', {
            reason: o.reason,
            detected: o.detected,
            questions: o.questions,
            requestExcerpt: run.request.slice(0, 600),
            note: 'MVP では危険操作は承認しても実行できません。安全な範囲での再計画（差し戻し）か中止を選んでください。',
          });
          return;
        }
        const parsed = PlanSchema.safeParse(o.plan);
        if (!parsed.success) {
          await this.failRun(run.id, 'INVALID_PLAN', '計画の構造検証に失敗しました');
          return;
        }
        const r = await this.transition(run.id, 'running', { plan: parsed.data as PlanJson });
        if (r) await this.addStep(r, 'implement', 'developer', r.revisionCount);
        return;
      }
      case 'implement': {
        const r = await this.transition(run.id, 'validating');
        if (r) await this.addStep(r, 'test', 'tester', r.revisionCount);
        return;
      }
      case 'test':
      case 'review': {
        const ok = step.key === 'test' ? o.passed === true : o.approved === true;
        if (ok) {
          if (step.key === 'test') await this.addStep(run, 'review', 'reviewer', run.revisionCount);
          else await this.addStep(run, run.pr ? 'update_pr' : 'draft_pr', 'tool_broker', run.revisionCount);
          return;
        }
        if (run.fixLoops < MAX_FIX_LOOPS) {
          const r = await this.transition(run.id, 'running', { fixLoops: run.fixLoops + 1 });
          if (r) await this.addStep(r, 'implement', 'developer', r.revisionCount);
        } else {
          await this.failRun(
            run.id,
            step.key === 'test' ? 'TESTS_FAILED' : 'REVIEW_BLOCKED',
            `自動修正の上限（${MAX_FIX_LOOPS} 回）に達しました`,
          );
        }
        return;
      }
      case 'draft_pr':
      case 'update_pr': {
        const pr = o.pr as RunPr | undefined;
        if (!pr) {
          await this.failRun(run.id, 'PR_MISSING', 'Draft PR の結果がありません');
          return;
        }
        const r1 = await this.transition(run.id, 'pr_ready', { pr });
        if (!r1) return;
        const r2 = await this.transition(run.id, 'waiting_review');
        if (!r2) return;
        const prior = await this.db
          .select()
          .from(runSteps)
          .where(and(eq(runSteps.runId, run.id), eq(runSteps.status, 'succeeded')))
          .orderBy(desc(runSteps.seq));
        const lastTest = prior.find((p) => p.key === 'test');
        const lastImpl = prior.find((p) => p.key === 'implement');
        await this.createApproval(r2, 'pr_review', 'reviewer', `Draft PR #${pr.number} のレビュー`, {
          pr,
          revision: r2.revisionCount,
          testsPassed: lastTest?.outcome?.passed ?? null,
          diff: lastImpl?.outcome?.diff ?? null,
          note: 'GitHub 上で人間がレビューします。マージは人間の操作です。',
        });
        return;
      }
    }
  }

  /* ------------------------------------------------------------ */
  /* External decisions                                            */
  /* ------------------------------------------------------------ */

  /** GitHub の pull_request_review を反映（基本設計書 4.3 / 10.3） */
  async applyReview(args: {
    runId: string;
    state: 'approved' | 'changes_requested';
    body: string;
    reviewer: string;
    commitId: string;
  }): Promise<'approved' | 'revision_started' | 'escalated' | 'ignored_not_waiting' | 'ignored_stale_commit'> {
    return this.withRunLock(args.runId, async () => {
      const [run] = await this.db.select().from(runs).where(eq(runs.id, args.runId));
      if (!run || run.status !== 'waiting_review' || !run.pr) return 'ignored_not_waiting';
      if (run.pr.headSha !== args.commitId) return 'ignored_stale_commit';
      const decided = await this.db
        .update(approvals)
        .set({
          status: args.state === 'approved' ? 'approved' : 'changes_requested',
          version: sql`${approvals.version} + 1`,
          decidedBy: `github:${args.reviewer}`,
          decidedAt: new Date(),
          decisionComment: args.body.slice(0, 2000) || null,
        })
        .where(
          and(eq(approvals.runId, run.id), eq(approvals.status, 'pending'), eq(approvals.actionType, 'pr_review')),
        )
        .returning();
      for (const a of decided) {
        await this.bus.emit(
          run.workspaceId,
          'approval.resolved',
          { approvalId: a.id, status: a.status, decidedBy: a.decidedBy },
          { runId: run.id, projectId: run.projectId },
        );
      }
      if (args.state === 'approved') {
        // 承認を認識しても自動マージはしない（基本設計書 10.3）
        const r = await this.transition(run.id, 'approved');
        if (r) await this.transition(run.id, 'completed');
        return 'approved';
      }
      if (run.revisionCount >= run.maxRevisionAttempts) {
        const r = await this.transition(run.id, 'needs_input', { guidance: args.body.slice(0, 2000) || null });
        if (r) {
          await this.createApproval(r, 'clarification', 'planner', '再修正の上限に達しました', {
            reason: 'revision_limit',
            revisionCount: run.revisionCount,
            maxRevisionAttempts: run.maxRevisionAttempts,
            lastReviewComment: args.body.slice(0, 1000),
            pr: run.pr,
            note: '続行を許可すると再計画から再開します。中止すると Run を終了します。',
          });
        }
        return 'escalated';
      }
      const r = await this.transition(run.id, 'revising', {
        revisionCount: run.revisionCount + 1,
        guidance: args.body.slice(0, 2000) || 'レビュー指摘への対応',
        fixLoops: 0,
      });
      if (r) await this.addStep(r, 'implement', 'developer', r.revisionCount);
      return 'revision_started';
    });
  }

  /** GitHub で PR が人の手でマージされた: レビュー待ちなら承認済み → 完了にする */
  async completeMergedRun(runId: string): Promise<RunRow | null> {
    return this.withRunLock(runId, async () => {
      const [run] = await this.db.select().from(runs).where(eq(runs.id, runId));
      if (!run || run.status !== 'waiting_review') return null;
      const decided = await this.db
        .update(approvals)
        .set({ status: 'approved', version: sql`${approvals.version} + 1`, decidedBy: 'github:merged', decidedAt: new Date(), decisionComment: 'PR がマージされました' })
        .where(and(eq(approvals.runId, runId), eq(approvals.status, 'pending'), eq(approvals.actionType, 'pr_review')))
        .returning();
      for (const a of decided) {
        await this.bus.emit(run.workspaceId, 'approval.resolved', { approvalId: a.id, status: a.status, decidedBy: a.decidedBy }, { runId, projectId: run.projectId });
      }
      const r = await this.transition(runId, 'approved');
      return r ? this.transition(runId, 'completed') : null;
    });
  }

  /** needs_input からの再開（人の判断: 承認 / 差し戻し）。計画からやり直す */
  async resumeFromInput(runId: string, guidance: string | null, resetRevisions: boolean) {
    const r = await this.transition(runId, 'planning', {
      guidance,
      fixLoops: 0,
      ...(resetRevisions ? { revisionCount: 0 } : {}),
    });
    if (!r) return r;
    // 利用上限で一時停止していた工程は、再計画するので取り消す
    await this.db
      .update(runSteps)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(runSteps.runId, runId), eq(runSteps.status, 'needs_input')));
    await this.addStep(r, 'plan', 'planner', r.revisionCount);
    return r;
  }

  /**
   * サブスク（Claude Code）の利用上限に達した工程を一時停止し、Run を needs_input にする。
   * 失敗にはせず、人の「続行」でその工程から再開できるようにする（利用者の要望）。
   */
  private async pauseForUsageLimit(step: StepRow, run: RunRow, err: UsageLimitError) {
    const now = new Date();
    await this.db.insert(stepLogs).values({
      workspaceId: run.workspaceId,
      runId: run.id,
      stepId: step.id,
      kind: 'error',
      message: `${err.code}: ${err.message} — Run を一時停止し、判断待ちにします`,
    });
    const r = await this.transition(run.id, 'needs_input');
    if (!r) {
      // 既に中止・失敗等で遷移できない場合は、この工程も終える
      await this.db.update(runSteps).set({ status: 'cancelled', finishedAt: now }).where(eq(runSteps.id, step.id));
      return;
    }
    await this.db
      .update(runSteps)
      .set({ status: 'needs_input', errorCode: err.code, summary: err.message.slice(0, 300), finishedAt: now })
      .where(eq(runSteps.id, step.id));
    await this.bus.emit(
      run.workspaceId,
      'step.finished',
      { stepId: step.id, key: step.key, role: step.role, status: 'needs_input', errorCode: err.code },
      { runId: run.id, projectId: run.projectId },
    );
    await this.createApproval(r, 'clarification', step.role === 'tool_broker' ? 'planner' : step.role, 'Claude の利用上限に達したため一時停止', {
      reason: 'usage_limit',
      pausedStepId: step.id,
      stepKey: step.key,
      resetsAt: err.resetsAt,
      message: err.message,
      note: '上限がリセットされた後に「続行」を押すと、止まった工程から再開します。差し戻すとコメントを踏まえて計画からやり直し、却下すると Run を中止します。',
    });
  }

  /** 利用上限で一時停止した工程を、同じ工程から再開する（承認＝続行） */
  async resumePausedStep(runId: string, stepId: string): Promise<RunRow | null> {
    const [step] = await this.db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.id, stepId), eq(runSteps.runId, runId), eq(runSteps.status, 'needs_input')));
    if (!step) return this.resumeFromInput(runId, null, false);
    const target: RunStatus = step.key === 'plan' ? 'planning' : step.key === 'implement' ? 'running' : 'validating';
    const r = await this.transition(runId, target);
    if (!r) return null;
    // 再開時は再試行回数を数え直す（上限による停止は失敗ではないため）
    await this.db
      .update(runSteps)
      .set({ status: 'pending', attempt: 0, errorCode: null, finishedAt: null, nextAttemptAt: new Date() })
      .where(eq(runSteps.id, step.id));
    await this.db.insert(stepLogs).values({
      workspaceId: r.workspaceId,
      runId: r.id,
      stepId: step.id,
      kind: 'log',
      message: '人の「続行」により、一時停止していた工程を再開します',
    });
    return r;
  }

  /* ------------------------------------------------------------ */
  /* Recovery                                                      */
  /* ------------------------------------------------------------ */

  /** 起動時: 前プロセスで実行中だった Step を「Runner 異常終了」として扱い再試行する */
  async recover() {
    const orphaned = await this.db.select().from(runSteps).where(eq(runSteps.status, 'running'));
    for (const step of orphaned) {
      if (this.inflight.has(step.id)) continue;
      await this.withRunLock(step.runId, async () => {
        const [run] = await this.db.select().from(runs).where(eq(runs.id, step.runId));
        if (!run) return;
        if (step.attempt < step.maxAttempts && !TERMINAL_RUN_STATUSES.includes(run.status)) {
          await this.db
            .update(runSteps)
            .set({ status: 'pending', errorCode: 'RUNNER_LOST', nextAttemptAt: new Date(Date.now() + 500) })
            .where(eq(runSteps.id, step.id));
          await this.db.insert(stepLogs).values({
            workspaceId: run.workspaceId,
            runId: run.id,
            stepId: step.id,
            kind: 'error',
            message: 'RUNNER_LOST: 前回のプロセス終了で中断 — 再開します',
          });
        } else {
          await this.db
            .update(runSteps)
            .set({ status: 'failed', errorCode: 'RUNNER_LOST', finishedAt: new Date() })
            .where(eq(runSteps.id, step.id));
          await this.failRun(run.id, 'RUNNER_LOST', 'Runner が異常終了し、再試行上限に達しました');
        }
      });
    }
    await this.sweepStuckRuns(0);
  }

  /** 進行中なのに次の Step が無い Run（途中クラッシュ等）を、最後に成功した Step から再開する */
  private async sweepStuckRuns(graceMs = 5_000) {
    const candidates = await this.db
      .select()
      .from(runs)
      .where(inArray(runs.status, ['planning', 'running', 'validating', 'pr_ready', 'revising', 'approved']));
    for (const c of candidates) {
      if (Date.now() - c.updatedAt.getTime() < graceMs) continue;
      await this.withRunLock(c.id, async () => {
        const [run] = await this.db.select().from(runs).where(eq(runs.id, c.id));
        if (!run || run.updatedAt.getTime() !== c.updatedAt.getTime()) return;
        const open = await this.db
          .select({ id: runSteps.id })
          .from(runSteps)
          .where(and(eq(runSteps.runId, run.id), inArray(runSteps.status, ['pending', 'running'])));
        if (open.length > 0) return;
        if (run.status === 'approved') {
          await this.transition(run.id, 'completed');
          return;
        }
        const [last] = await this.db
          .select()
          .from(runSteps)
          .where(and(eq(runSteps.runId, run.id), eq(runSteps.status, 'succeeded')))
          .orderBy(desc(runSteps.seq))
          .limit(1);
        log.warn('recovering stuck run', { runId: run.id, status: run.status, lastStep: last?.key });
        if (!last) {
          if (run.status === 'planning') await this.addStep(run, 'plan', 'planner', run.revisionCount);
          else await this.failRun(run.id, 'STATE_LOST', '復旧できない状態です');
          return;
        }
        if (run.status === 'revising') {
          await this.addStep(run, 'implement', 'developer', run.revisionCount);
          return;
        }
        await this.advance(run, last);
      });
    }
  }

  /** 期限切れ承認は失効させ、再確認を求める（基本設計書 12.1） */
  private async sweepExpiredApprovals() {
    const expired = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, new Date())));
    for (const a of expired) {
      await this.withRunLock(a.runId, async () => {
        const [row] = await this.db
          .update(approvals)
          .set({ status: 'expired', version: sql`${approvals.version} + 1` })
          .where(and(eq(approvals.id, a.id), eq(approvals.status, 'pending')))
          .returning();
        if (!row) return;
        await this.bus.emit(row.workspaceId, 'approval.resolved', { approvalId: row.id, status: 'expired' }, {
          runId: row.runId,
          projectId: row.projectId,
        });
        const [run] = await this.db.select().from(runs).where(eq(runs.id, row.runId));
        if (run && (run.status === 'waiting_review' || run.status === 'needs_input')) {
          const baseTitle = row.title.replace(/（再確認）$/, '');
          await this.createApproval(run, row.actionType, row.requestedByRole, `${baseTitle}（再確認）`, {
            ...row.payload,
            reconfirmationOf: row.id,
          });
        }
      });
    }
  }
}

