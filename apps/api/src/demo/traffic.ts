/**
 * デモ用トラフィック生成（ローカル専用）。
 * demo_traffic が ON の Workspace に対し、GitHub Issue / PR レビューのイベントを
 * 署名付き Webhook としてシミュレーターから送る。自動起動の可否は通常どおり Repo の設定で判定される。
 */
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Services } from '../app';
import { projects, repositoryBindings, runs, users, workspaces } from '../db/schema';
import { simulateIssue, simulateReview } from '../github/simulator';
import { log } from '../lib/logger';

const ISSUE_TITLES = [
  ['ログイン画面にパスワード表示切替を追加', '目のアイコンでパスワードの表示/非表示を切り替えたい。キーボード操作にも対応すること。'],
  ['注文履歴を CSV でエクスポート', '管理画面から注文履歴を CSV でダウンロードしたい。Excel で文字化けしないように。'],
  ['ダークモードの配色を調整', 'ダークモードでボタンのコントラストが低い。WCAG AA を満たしたい。'],
  ['API にユーザー単位のレート制限を追加', '1 分あたり 120 リクエストを超えたら 429 を返す。'],
  ['商品検索にカテゴリフィルターを追加', '検索結果をカテゴリで絞り込めるようにしたい。'],
  ['請求書一覧のページネーションを cursor 方式に変更', 'offset 方式だと件数が多いときに遅い。'],
  ['日付表示がタイムゾーン境界でずれるバグを修正', 'JST の 0 時台の注文が前日扱いになる。'],
  ['通知一覧に未読バッジを表示', 'ヘッダーのベルに未読件数を出したい。'],
  ['設定画面のフォームバリデーションを強化', '必須項目が空のまま保存できてしまう。'],
  ['セッション切れ時のエラー表示を改善', '401 のとき真っ白な画面になる。ログイン画面へ誘導したい。'],
];
const REVIEW_COMMENTS = [
  'エラーメッセージを日本語に統一してください。',
  '境界値のテストケースを 1 つ追加してください。',
  'ボタンに aria-label を付けてください。',
  '定数はファイル先頭にまとめてください。',
];

export class DemoTraffic {
  private timer: NodeJS.Timeout | null = null;
  private nextDue = new Map<string, number>();
  private busy = false;
  /** 起動前からレビュー待ちだった Run は自動レビューしない（利用者が操作できるよう残す） */
  private readonly startedAt = new Date();

  constructor(private readonly s: Services) {}

  start(intervalMs = 5_000) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = await this.s.db
        .select({ ws: workspaces, username: users.username })
        .from(workspaces)
        .innerJoin(users, eq(users.id, workspaces.ownerUserId))
        .where(and(eq(workspaces.demoTraffic, true), eq(workspaces.paused, false)));
      for (const { ws, username } of rows) {
        await this.maybeReview(ws.id, username);
        const due = this.nextDue.get(ws.id) ?? Date.now() + 8_000;
        if (!this.nextDue.has(ws.id)) this.nextDue.set(ws.id, due);
        if (Date.now() < due) continue;
        this.nextDue.set(ws.id, Date.now() + 22_000 + Math.random() * 20_000);
        await this.maybeIssue(ws.id, username);
      }
    } catch (err) {
      log.warn('demo traffic tick failed', { err: String(err) });
    } finally {
      this.busy = false;
    }
  }

  private async maybeIssue(workspaceId: string, username: string) {
    const [{ queued }] = await this.s.db
      .select({ queued: sql<number>`count(*)` })
      .from(runs)
      .where(and(eq(runs.workspaceId, workspaceId), eq(runs.status, 'queued')));
    if (Number(queued) >= 2) return;
    const candidates = await this.s.db
      .select({ projectId: projects.id })
      .from(projects)
      .innerJoin(repositoryBindings, eq(repositoryBindings.projectId, projects.id))
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.status, 'active'), eq(repositoryBindings.automationEnabled, true)));
    if (candidates.length === 0) return;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const [title, body] = ISSUE_TITLES[Math.floor(Math.random() * ISSUE_TITLES.length)];
    const withLabel = Math.random() > 0.12; // 一部はラベル無し → 条件不一致で記録のみ（FR-023）
    await simulateIssue(this.s.db, this.s.config, {
      workspaceId,
      projectId: target.projectId,
      action: 'opened',
      title,
      body,
      labels: withLabel ? ['ai:ready', 'enhancement'] : ['question'],
      senderLogin: username,
    });
    void this.s.dispatcher.drain();
  }

  private async maybeReview(workspaceId: string, username: string) {
    const stale = await this.s.db
      .select({ id: runs.id, revisionCount: runs.revisionCount })
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, workspaceId),
          eq(runs.status, 'waiting_review'),
          lte(runs.updatedAt, new Date(Date.now() - 150_000)),
          gte(runs.updatedAt, this.startedAt),
        ),
      )
      .orderBy(asc(runs.updatedAt))
      .limit(1);
    const run = stale[0];
    if (!run) return;
    const approve = run.revisionCount > 0 || Math.random() < 0.65;
    await simulateReview(this.s.db, this.s.config, {
      workspaceId,
      runId: run.id,
      state: approve ? 'approved' : 'changes_requested',
      body: approve ? 'LGTM' : REVIEW_COMMENTS[Math.floor(Math.random() * REVIEW_COMMENTS.length)],
      reviewerLogin: `${username}-reviewer`,
    }).catch(() => undefined);
    void this.s.dispatcher.drain();
  }
}
