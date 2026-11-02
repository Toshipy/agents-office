/**
 * GitHub ポーリング（Webhook の代わり）。サーバーをインターネットに出さなくてよいように、
 * 一定間隔で GitHub を読み、合成した配信を既存の永続キュー（webhook_deliveries）に積む。
 * 処理は Dispatcher がそのまま行う（Webhook と同じ形のペイロードにしてあるので Dispatcher は変えない）。
 * 重複は (provider, deliveryId) の一意制約で弾く。
 */
import { and, eq, sql } from 'drizzle-orm';
import { TERMINAL_RUN_STATUSES } from '@paw/contracts';
import type { Db } from '../db/client';
import { repositoryBindings, runs, webhookDeliveries } from '../db/schema';
import { log } from '../lib/logger';
import type { GithubApp } from './app';

export const POLL_PROVIDER = 'github_poll';

type Binding = typeof repositoryBindings.$inferSelect;
type Run = typeof runs.$inferSelect;

export class GithubPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /**
   * @param login 自分の GitHub ログイン名。null なら（誰の Issue か決められないので）Issue からは Run を作らない。
   *              省略（undefined）のときは制限しない（許可ユーザーの確認は Dispatcher が行う）
   */
  constructor(
    private readonly db: Db,
    private readonly github: GithubApp,
    private readonly intervalMs: number,
    private readonly login?: string | null,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
    void this.pollOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 1 回分の取り込み。Repo ごとの失敗は記録して次へ進む。多重実行はしない */
  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pollIssues();
      await this.pollPulls();
    } finally {
      this.running = false;
    }
  }

  private async enqueue(
    binding: Pick<Binding, 'installationId' | 'repositoryId'>,
    deliveryId: string,
    eventType: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .insert(webhookDeliveries)
      .values({
        provider: POLL_PROVIDER,
        deliveryId,
        eventType,
        action,
        installationId: binding.installationId,
        repositoryId: binding.repositoryId,
        payload,
      })
      .onConflictDoNothing();
  }

  private async pollIssues(): Promise<void> {
    if (this.login === null) {
      log.warn('GitHub のログイン名が未設定のため、ポーリングでは Issue から Run を作りません');
      return;
    }
    const bindings = await this.db
      .select()
      .from(repositoryBindings)
      .where(and(eq(repositoryBindings.automationEnabled, true), eq(repositoryBindings.verification, 'github_app')));
    for (const b of bindings) {
      try {
        const label = b.policy.triggerLabel;
        const issues = await this.github.listIssuesWithLabel(b.installationId, b.fullName, label);
        for (const issue of issues) {
          // 同じ Issue の Run が動いている間は、取り込んでも Dispatcher が捨てるだけなので events API を呼ばない
          const issueKey = `${b.repositoryId}#${issue.number}`;
          const active = await this.db
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.workspaceId, b.workspaceId), eq(runs.issueKey, issueKey), sql`${runs.status} not in (${sql.join(TERMINAL_RUN_STATUSES.map((s) => sql`${s}`), sql`, `)})`));
          if (active.length > 0) continue;
          const labeled = await this.github.lastLabeled(b.installationId, b.fullName, issue.number, label);
          if (!labeled) continue;
          await this.enqueue(b, `poll:issue:${b.repositoryId}:${issue.number}:${labeled.at}`, 'issues', 'labeled', {
            action: 'labeled',
            label: { name: label },
            issue: {
              number: issue.number,
              title: issue.title,
              body: issue.body,
              html_url: issue.htmlUrl,
              labels: issue.labels.map((name) => ({ name })),
              assignees: issue.assignees.map((l) => ({ login: l })),
            },
            repository: { id: b.repositoryId, full_name: b.fullName },
            installation: { id: b.installationId },
            sender: { login: labeled.login },
          });
        }
      } catch (err) {
        log.error('github poll (issues) failed', { repo: b.fullName, err: String(err) });
      }
    }
  }

  /** PR を持つ終端でない Run について、マージ・クローズとレビューを取り込む */
  private async pollPulls(): Promise<void> {
    const rows = await this.db
      .select({ run: runs, binding: repositoryBindings })
      .from(runs)
      .innerJoin(repositoryBindings, eq(repositoryBindings.projectId, runs.projectId))
      .where(
        and(
          eq(repositoryBindings.verification, 'github_app'),
          sql`${runs.pr} is not null`,
          sql`${runs.status} not in (${sql.join(TERMINAL_RUN_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
        ),
      );
    for (const { run, binding } of rows) {
      try {
        await this.pollPull(run, binding);
      } catch (err) {
        log.error('github poll (pull) failed', { repo: binding.fullName, runId: run.id, err: String(err) });
      }
    }
  }

  private async pollPull(run: Run, b: Binding): Promise<void> {
    const pr = run.pr;
    if (!pr) return;
    const pull = await this.github.getPull(b.installationId, b.fullName, pr.number);
    const repo = { repository: { id: b.repositoryId, full_name: b.fullName }, installation: { id: b.installationId } };
    if (pull.state === 'closed') {
      await this.enqueue(b, `poll:pr:${b.repositoryId}:${pr.number}:closed`, 'pull_request', 'closed', {
        action: 'closed',
        pull_request: { number: pr.number, merged: pull.merged, head: { sha: pull.headSha } },
        ...repo,
        sender: { login: this.login ?? 'github' },
      });
      return;
    }
    // レビューは承認待ちの Run にだけ渡す（それ以外で積むと、取りこぼしたまま重複扱いで二度と届かなくなる）
    if (run.status !== 'waiting_review') return;
    const reviews = await this.github.listReviews(b.installationId, b.fullName, pr.number);
    for (const r of reviews) {
      const state = r.state.toLowerCase();
      if (state !== 'approved' && state !== 'changes_requested') continue;
      // 古いコミットへのレビューはエンジンが無視するので積まない
      if (r.commitId !== pr.headSha) continue;
      await this.enqueue(b, `poll:review:${b.repositoryId}:${pr.number}:${r.id}`, 'pull_request_review', 'submitted', {
        action: 'submitted',
        review: { id: r.id, state, body: r.body, commit_id: r.commitId, user: { login: r.user } },
        pull_request: { number: pr.number },
        ...repo,
        sender: { login: r.user },
      });
    }
  }
}
