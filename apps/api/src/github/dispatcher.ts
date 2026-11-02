/**
 * Dispatcher（Lambda Dispatcher の代替: 基本設計書 2.1 / 10.1-4〜6）。
 * 永続キューから検証済み Webhook を取り出し、Installation ID / Repository ID / 登録済み接続 /
 * 自動起動ルールを照合して Run を作成する。対象外は軽量イベントのみ記録し Agent を起動しない。
 * 少なくとも1回の配信を前提とし、処理済みは processed_at で判定する。
 */
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { TERMINAL_RUN_STATUSES } from '@paw/contracts';
import type { Db } from '../db/client';
import { projects, repositoryBindings, runs, webhookDeliveries, workspaces } from '../db/schema';
import type { EventBus } from '../events/bus';
import { log } from '../lib/logger';
import type { WorkflowEngine } from '../workflow/engine';
import type { GithubApp } from './app';
import type { IssueIntake } from './issueIntake';

const MAX_DELIVERY_ATTEMPTS = 5;

type Delivery = typeof webhookDeliveries.$inferSelect;
type Binding = typeof repositoryBindings.$inferSelect;

export class Dispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly engine: WorkflowEngine,
    /** GitHub App 連携時のみ。Issue・レビューを受け付ける GitHub ユーザーを限定する */
    private readonly github: GithubApp | null = null,
    /** Issue から Run を作る入口（アサイン・コメント取得を含む） */
    private readonly intake: IssueIntake | null = null,
  ) {}

  /**
   * 実 GitHub のイベントは、許可した GitHub ユーザーの操作だけを受け付ける。公開リポジトリでは
   * 誰でも Issue を作れるため、他人の Issue でエージェントが動いたり利用枠を消費したりしないようにする。
   * シミュレーター（GitHub App 未設定）の場合は対象外。
   */
  private senderAllowed(binding: Binding, login: unknown): boolean {
    if (binding.verification !== 'github_app') return true;
    return this.github?.isAllowedUser(login) ?? false;
  }

  start(intervalMs = 400) {
    this.timer = setInterval(() => void this.drain(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      const batch = await this.db
        .select()
        .from(webhookDeliveries)
        .where(and(isNull(webhookDeliveries.processedAt), lt(webhookDeliveries.attempts, MAX_DELIVERY_ATTEMPTS)))
        .orderBy(asc(webhookDeliveries.receivedAt))
        .limit(20);
      for (const d of batch) {
        try {
          const outcome = await this.process(d);
          await this.db
            .update(webhookDeliveries)
            .set({ processedAt: new Date(), outcome, attempts: d.attempts + 1 })
            .where(and(eq(webhookDeliveries.provider, d.provider), eq(webhookDeliveries.deliveryId, d.deliveryId)));
        } catch (err) {
          const attempts = d.attempts + 1;
          log.error('webhook dispatch failed', { deliveryId: d.deliveryId, attempts, err: String(err) });
          await this.db
            .update(webhookDeliveries)
            .set({
              attempts,
              ...(attempts >= MAX_DELIVERY_ATTEMPTS ? { processedAt: new Date(), outcome: 'dead_letter' } : {}),
            })
            .where(and(eq(webhookDeliveries.provider, d.provider), eq(webhookDeliveries.deliveryId, d.deliveryId)));
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async bindingsFor(d: Delivery): Promise<Binding[]> {
    if (d.installationId == null || d.repositoryId == null) return [];
    return this.db
      .select()
      .from(repositoryBindings)
      .where(
        and(eq(repositoryBindings.installationId, d.installationId), eq(repositoryBindings.repositoryId, d.repositoryId)),
      );
  }

  private async record(binding: Binding, d: Delivery, accepted: boolean, reason: string, runId?: string) {
    await this.bus.emit(
      binding.workspaceId,
      accepted ? 'webhook.received' : 'webhook.ignored',
      { deliveryId: d.deliveryId, event: `${d.eventType}.${d.action ?? ''}`, reason, repo: binding.fullName },
      { projectId: binding.projectId, runId: runId ?? null },
    );
  }

  async process(d: Delivery): Promise<string> {
    if (d.eventType === 'ping') return 'ping';
    const bindings = await this.bindingsFor(d);
    if (bindings.length === 0) return 'no_binding';
    const outcomes: string[] = [];
    for (const binding of bindings) {
      if (d.eventType === 'issues') outcomes.push(await this.onIssue(binding, d));
      else if (d.eventType === 'pull_request_review') outcomes.push(await this.onReview(binding, d));
      else if (d.eventType === 'pull_request') outcomes.push(await this.onPullRequest(binding, d));
      else {
        await this.record(binding, d, false, 'unhandled_event');
        outcomes.push('unhandled_event');
      }
    }
    return outcomes.join(',');
  }

  private async onIssue(binding: Binding, d: Delivery): Promise<string> {
    const p = d.payload as Record<string, any>;
    const action = d.action ?? '';
    const issue = p.issue ?? {};
    const issueNumber = Number(issue.number);
    const ignore = async (reason: string) => {
      await this.record(binding, d, false, reason);
      return reason;
    };
    if (!Number.isSafeInteger(issueNumber)) return ignore('invalid_issue');
    if (!this.senderAllowed(binding, p.sender?.login)) return ignore('sender_not_allowed');
    const eventName = `issues.${action}` as 'issues.opened' | 'issues.labeled';
    if (!binding.policy.events.includes(eventName)) return ignore('event_not_enabled');
    if (!binding.automationEnabled) return ignore('automation_disabled');
    const label = binding.policy.triggerLabel;
    const labels: string[] = Array.isArray(issue.labels)
      ? issue.labels.map((l: any) => String(l?.name ?? '')).filter(Boolean)
      : [];
    const matched = action === 'labeled' ? p.label?.name === label : labels.includes(label);
    if (!matched) return ignore('label_mismatch');
    const [project] = await this.db.select().from(projects).where(eq(projects.id, binding.projectId));
    if (!project || project.status !== 'active') return ignore('project_inactive');
    const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, binding.workspaceId));
    if (!ws) return ignore('workspace_missing');
    if (ws.paused) return ignore('workspace_paused');
    if ((await this.engine.monthCostUsd(ws.id)) >= ws.monthlyBudgetUsd) return ignore('budget_exceeded');
    // 同一 Issue の重複・他人の担当・夜間の確認、アサイン、Run 作成は IssueIntake が行う
    if (!this.intake) return ignore('intake_unavailable');
    const result = await this.intake.start(binding, issueNumber, {
      via: 'label',
      labeledBy: typeof p.sender?.login === 'string' ? p.sender.login : null,
      guidance: null,
      deliveryId: d.deliveryId,
      payload: {
        title: String(issue.title ?? ''),
        body: String(issue.body ?? '').slice(0, 4000),
        htmlUrl: typeof issue.html_url === 'string' ? issue.html_url : undefined,
      },
    });
    if ('skipped' in result) return ignore(result.skipped);
    const run = { id: result.runId };
    await this.record(binding, d, true, 'run_created', run.id);
    return 'run_created';
  }

  private async onReview(binding: Binding, d: Delivery): Promise<string> {
    const p = d.payload as Record<string, any>;
    if (d.action !== 'submitted') {
      await this.record(binding, d, false, 'review_action_ignored');
      return 'review_action_ignored';
    }
    const state = String(p.review?.state ?? '').toLowerCase();
    const prNumber = Number(p.pull_request?.number);
    if (!this.senderAllowed(binding, p.review?.user?.login ?? p.sender?.login)) {
      await this.record(binding, d, false, 'reviewer_not_allowed');
      return 'reviewer_not_allowed';
    }
    if (!Number.isSafeInteger(prNumber) || (state !== 'approved' && state !== 'changes_requested')) {
      await this.record(binding, d, false, 'review_state_ignored');
      return 'review_state_ignored';
    }
    // 本サービスが作成した PR に関連付く Run のみ対象（FR-025 / FR-026）
    const candidates = await this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, binding.workspaceId),
          eq(runs.projectId, binding.projectId),
          sql`(${runs.pr} ->> 'number')::int = ${prNumber}`,
          inArray(runs.status, ['waiting_review']),
        ),
      );
    const run = candidates[0];
    if (!run) {
      await this.record(binding, d, false, 'no_matching_run');
      return 'no_matching_run';
    }
    const result = await this.engine.applyReview({
      runId: run.id,
      state: state as 'approved' | 'changes_requested',
      body: String(p.review?.body ?? ''),
      reviewer: String(p.review?.user?.login ?? p.sender?.login ?? 'unknown').slice(0, 60),
      commitId: String(p.review?.commit_id ?? ''),
    });
    await this.record(binding, d, result === 'approved' || result === 'revision_started' || result === 'escalated', result, run.id);
    return result;
  }

  /** PR がマージ / クローズされたら Run を終える（マージは人の操作。AI はマージしない） */
  private async onPullRequest(binding: Binding, d: Delivery): Promise<string> {
    const p = d.payload as Record<string, any>;
    const prNumber = Number(p.pull_request?.number);
    if (d.action !== 'closed' || !Number.isSafeInteger(prNumber)) {
      await this.record(binding, d, false, 'pr_action_ignored');
      return 'pr_action_ignored';
    }
    const [run] = await this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, binding.workspaceId),
          eq(runs.projectId, binding.projectId),
          sql`(${runs.pr} ->> 'number')::int = ${prNumber}`,
          sql`${runs.status} not in (${sql.join(
            TERMINAL_RUN_STATUSES.map((st) => sql`${st}`),
            sql`, `,
          )})`,
        ),
      );
    if (!run) {
      await this.record(binding, d, false, 'no_matching_run');
      return 'no_matching_run';
    }
    const merged = p.pull_request?.merged === true;
    const result = merged ? await this.engine.completeMergedRun(run.id) : await this.engine.cancelRun(run.id, `PR #${prNumber} がマージされずにクローズされました`);
    const outcome = merged ? (result ? 'run_completed_merged' : 'merge_not_applied') : result ? 'run_cancelled_pr_closed' : 'close_not_applied';
    await this.record(binding, d, Boolean(result), outcome, run.id);
    return outcome;
  }
}
