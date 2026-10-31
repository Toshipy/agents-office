/**
 * ローカルデモ用の初期データ。
 * - alice: 5 Project（うち 3 つは自動起動 ON）、過去の Run 履歴、レビュー待ち 1 件、起動直後に動く Run
 * - bob:   1 Project（Workspace 分離の確認用）
 * パスワードはローカル専用のデモ値（127.0.0.1 でのみ待ち受け）。
 */
import { sql } from 'drizzle-orm';
import type { Services } from './app';
import {
  approvals,
  projects,
  repositoryBindings,
  runSteps,
  runs,
  usageRecords,
  users,
  type RepoPolicy,
} from './db/schema';
import { newId } from './lib/ids';
import { digestPayload, sha256Hex } from './lib/crypto';
import { log } from './lib/logger';
import { createUserWithWorkspace } from './services/provision';
import { simulatedInstallationId, simulatedRepositoryId } from './github/simulator';
import {
  draftPrMarkdown,
  generateDiff,
  planMarkdown,
  reviewMarkdown,
  testReport,
  type ContentContext,
} from './agents/content';
import { SIM_MODEL } from './agents/simulated';
import { branchFor, SIM_PRICE_PER_MTOK } from './workflow/engine';
import { AGENT_ROLES } from '@paw/contracts';

export const DEMO_ACCOUNTS = [
  { username: 'alice', password: 'alice-local-demo', displayName: 'Alice' },
  { username: 'bob', password: 'bob-local-demo', displayName: 'Bob' },
];

const POLICY: RepoPolicy = { triggerLabel: 'ai:ready', events: ['issues.opened', 'issues.labeled'], maxRevisionAttempts: 3 };

async function addProject(
  s: Services,
  workspaceId: string,
  position: number,
  p: { name: string; description: string; color: string; repo: string; automation: boolean },
) {
  const [project] = await s.db
    .insert(projects)
    .values({
      id: newId('prj'),
      workspaceId,
      name: p.name,
      description: p.description,
      color: p.color,
      position,
      agentConfig: { roles: [...AGENT_ROLES], workflow: 'issue_to_draft_pr' },
    })
    .returning();
  const [binding] = await s.db
    .insert(repositoryBindings)
    .values({
      id: newId('rbd'),
      workspaceId,
      projectId: project.id,
      installationId: simulatedInstallationId(workspaceId),
      repositoryId: simulatedRepositoryId(p.repo),
      fullName: p.repo,
      automationEnabled: p.automation,
      policy: POLICY,
      nextPrNumber: 40 + position * 7,
      nextIssueNumber: 120 + position * 11,
    })
    .returning();
  return { project, binding };
}

/** 完了済み（または waiting_review）の過去 Run を、実際の生成器で作った成果物つきで作る */
async function addHistoricalRun(
  s: Services,
  args: {
    workspaceId: string;
    projectId: string;
    binding: typeof repositoryBindings.$inferSelect;
    title: string;
    request: string;
    minutesAgo: number;
    final: 'completed' | 'waiting_review' | 'failed';
  },
) {
  const runId = newId('run');
  const start = new Date(Date.now() - args.minutesAgo * 60_000);
  const at = (sec: number) => new Date(start.getTime() + sec * 1000);
  const ctx: ContentContext = {
    runId,
    title: args.title,
    request: args.request,
    repo: args.binding.fullName,
    revision: 0,
    guidance: null,
    branch: branchFor(runId),
  };
  const [{ next }] = await s.db
    .update(repositoryBindings)
    .set({ nextPrNumber: sql`${repositoryBindings.nextPrNumber} + 1` })
    .where(sql`${repositoryBindings.id} = ${args.binding.id}`)
    .returning({ next: repositoryBindings.nextPrNumber });
  const prNumber = next - 1;
  const pr = {
    number: prNumber,
    url: `local-github://${args.binding.fullName}/pull/${prNumber}`,
    branch: ctx.branch,
    headSha: sha256Hex(`${runId}:seed`).slice(0, 40),
    draft: true,
  };
  const failed = args.final === 'failed';
  const finishedAt = args.final === 'waiting_review' ? null : at(failed ? 50 : 3600);
  await s.db.insert(runs).values({
    id: runId,
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    title: args.title,
    request: args.request,
    workflow: 'issue_to_draft_pr',
    source: { type: 'manual' },
    status: args.final,
    statusVersion: failed ? 6 : args.final === 'waiting_review' ? 7 : 9,
    budgetLimitUsd: 2,
    costUsd: 0,
    pr: failed ? null : pr,
    fixLoops: failed ? 2 : 0,
    errorCode: failed ? 'TESTS_FAILED' : null,
    errorMessage: failed ? '自動修正の上限（2 回）に達しました' : null,
    createdAt: start,
    updatedAt: finishedAt ?? at(70),
    startedAt: at(1),
    finishedAt,
  });
  const steps: { key: (typeof runSteps.$inferInsert)['key']; role: (typeof runSteps.$inferInsert)['role']; t0: number; t1: number; summary: string; outcome: Record<string, unknown>; status?: 'failed' | 'succeeded' }[] = [
    { key: 'plan', role: 'planner', t0: 1, t1: 9, summary: '5 ステップの計画を作成', outcome: {} },
    { key: 'implement', role: 'developer', t0: 10, t1: 28, summary: '3 ファイル変更', outcome: {} },
    failed
      ? { key: 'test', role: 'tester', t0: 29, t1: 40, summary: '1 件のテストが失敗', outcome: { passed: false }, status: 'succeeded' }
      : { key: 'test', role: 'tester', t0: 29, t1: 40, summary: '128 件のテストが通過', outcome: { passed: true } },
    ...(failed
      ? []
      : [
          { key: 'review' as const, role: 'reviewer' as const, t0: 41, t1: 52, summary: 'Draft PR 提出可（人間の承認ではない）', outcome: { approved: true, blockers: [] } },
          { key: 'draft_pr' as const, role: 'tool_broker' as const, t0: 53, t1: 56, summary: `Draft PR #${prNumber} 作成`, outcome: { pr } },
        ]),
  ];
  let seq = 0;
  const diff = generateDiff(ctx);
  for (const st of steps) {
    const stepId = newId('stp');
    seq++;
    await s.db.insert(runSteps).values({
      id: stepId,
      workspaceId: args.workspaceId,
      runId,
      seq,
      key: st.key,
      role: st.role,
      model: st.role === 'tool_broker' ? 'policy-broker' : SIM_MODEL,
      agentVersion: st.role === 'tool_broker' ? null : 1,
      status: st.status ?? 'succeeded',
      attempt: 1,
      summary: st.summary,
      outcome: st.outcome,
      startedAt: at(st.t0),
      finishedAt: at(st.t1),
      createdAt: at(st.t0),
    });
    const put = (kind: Parameters<typeof s.store.put>[0]['kind'], title: string, filename: string, mediaType: string, content: string) =>
      s.store.put({ workspaceId: args.workspaceId, runId, stepId, kind, title, filename, mediaType, content });
    if (st.key === 'plan') {
      await put('plan', '実行計画', 'plan.md', 'text/markdown', planMarkdown(ctx, [
        { id: 'plan', role: 'planner', dependsOn: [] },
        { id: 'implement', role: 'developer', dependsOn: ['plan'] },
        { id: 'test', role: 'tester', dependsOn: ['implement'] },
        { id: 'review', role: 'reviewer', dependsOn: ['test'] },
        { id: 'draft_pr', role: 'tool_broker', dependsOn: ['review'] },
      ], []));
    }
    if (st.key === 'implement') await put('diff', '差分（revision 0）', 'changes.diff', 'text/x-diff', diff.patch);
    if (st.key === 'test') await put('test_report', failed ? 'テスト結果（失敗）' : 'テスト結果（成功）', 'test-report.json', 'application/json', JSON.stringify(testReport(ctx, !failed, 42), null, 2));
    if (st.key === 'review') await put('review', 'AI レビュー', 'review.md', 'text/markdown', reviewMarkdown(ctx, diff, []));
    if (st.key === 'draft_pr') await put('draft_pr', `Draft PR #${prNumber}`, 'draft-pr.md', 'text/markdown', draftPrMarkdown(ctx, pr, true, false));
    if (st.role !== 'tool_broker') {
      const inTok = st.key === 'implement' ? 12500 : st.key === 'review' ? 8200 : st.key === 'plan' ? 4200 : 2600;
      const outTok = Math.round(inTok / 3.5);
      const cost = (inTok * SIM_PRICE_PER_MTOK.input + outTok * SIM_PRICE_PER_MTOK.output) / 1_000_000;
      await s.db.insert(usageRecords).values({
        id: newId('use'),
        workspaceId: args.workspaceId,
        runId,
        stepId,
        model: SIM_MODEL,
        inputTokens: inTok,
        outputTokens: outTok,
        durationMs: (st.t1 - st.t0) * 1000,
        estimatedCostUsd: cost,
        measurement: 'estimated',
        createdAt: at(st.t1),
      });
      await s.db.update(runs).set({ costUsd: sql`${runs.costUsd} + ${cost}` }).where(sql`${runs.id} = ${runId}`);
    }
  }
  if (!failed) {
    const approvalId = newId('apr');
    const payload = { pr, revision: 0, testsPassed: true, diff: { files: diff.files, additions: diff.additions, deletions: diff.deletions }, note: 'GitHub 上で人間がレビューします。マージは人間の操作です。' };
    await s.db.insert(approvals).values({
      id: approvalId,
      workspaceId: args.workspaceId,
      runId,
      projectId: args.projectId,
      actionType: 'pr_review',
      requestedByRole: 'reviewer',
      title: `Draft PR #${prNumber} のレビュー`,
      payload,
      payloadDigest: digestPayload({ approvalId, actionType: 'pr_review', runId, payload }),
      status: args.final === 'completed' ? 'approved' : 'pending',
      version: args.final === 'completed' ? 2 : 1,
      expiresAt: new Date(start.getTime() + 14 * 24 * 3600_000),
      decidedBy: args.final === 'completed' ? 'github:alice' : null,
      decidedAt: args.final === 'completed' ? at(3600) : null,
      createdAt: at(56),
    });
  }
}

export async function seedIfEmpty(s: Services) {
  const [{ count }] = await s.db.select({ count: sql<number>`count(*)` }).from(users);
  if (Number(count) > 0) return false;
  log.info('seeding local demo data');

  const alice = await createUserWithWorkspace(s.db, {
    ...DEMO_ACCOUNTS[0],
    settings: { monthlyBudgetUsd: 200, runBudgetUsd: 2, maxConcurrentRuns: 4, demoTraffic: true },
  });
  const ws = alice.workspace.id;
  const defs = [
    { name: 'Storefront Web', description: 'EC サイトのフロントエンド（React）', color: '#5eead4', repo: 'alice/storefront-web', automation: true },
    { name: 'Billing API', description: '請求・決済まわりのバックエンド API', color: '#fb7185', repo: 'alice/billing-api', automation: true },
    { name: 'Mobile App', description: 'iOS / Android アプリ（React Native）', color: '#a78bfa', repo: 'alice/mobile-app', automation: false },
    { name: 'Docs Portal', description: '開発者向けドキュメントサイト', color: '#fbbf24', repo: 'alice/docs-portal', automation: true },
    { name: 'Data Pipeline', description: '集計バッチと分析基盤', color: '#60a5fa', repo: 'alice/data-pipeline', automation: false },
  ];
  const created = [];
  for (let i = 0; i < defs.length; i++) created.push(await addProject(s, ws, i, defs[i]));

  const history: [number, string, string, number, 'completed' | 'waiting_review' | 'failed'][] = [
    [0, '商品詳細ページの画像遅延読み込み', '商品詳細ページの画像を lazy load にして LCP を改善する', 300, 'completed'],
    [0, 'カート画面のアクセシビリティ改善', 'カート画面のボタンに aria-label を付ける', 180, 'completed'],
    [1, '請求書 PDF のファイル名規則を変更', '請求書 PDF のファイル名を invoice-YYYYMM-番号.pdf にする', 240, 'completed'],
    [1, 'Webhook 受信のリトライ間隔を調整', 'Webhook 受信失敗時のリトライを指数バックオフにする', 26, 'waiting_review'],
    [2, 'プッシュ通知の許可ダイアログ文言修正', '通知許可ダイアログの文言を分かりやすくする', 420, 'completed'],
    [3, 'API リファレンスの検索を高速化', 'ドキュメント検索にインデックスを導入して検索を速くする', 95, 'completed'],
    [4, '日次集計ジョブのタイムゾーン不具合', '日次集計が UTC で区切られている不具合を修正する', 60, 'failed'],
  ];
  for (const [idx, title, request, minutesAgo, final] of history) {
    const c = created[idx];
    await addHistoricalRun(s, { workspaceId: ws, projectId: c.project.id, binding: c.binding, title, request, minutesAgo, final });
  }

  // 起動直後から動く Run（手動依頼）
  const live: [number, string, string][] = [
    [0, 'ログイン画面のパスワード表示切替', 'ログイン画面のパスワード表示切替を実装し、テストと Draft PR を作成して'],
    [1, 'API にユーザー単位のレート制限を追加', '1 分あたり 120 リクエストを超えたら 429 と Retry-After を返す'],
    [3, 'ドキュメントにダークモードを追加', 'ドキュメントサイトにダークモード切替を追加する'],
    [4, '本番 DB の古いテーブルを削除して集計を高速化', '本番 DB の不要テーブルを drop table して、集計クエリを速くしてほしい'],
  ];
  for (const [idx, title, request] of live) {
    await s.engine.createRun({
      workspaceId: ws,
      projectId: created[idx].project.id,
      title,
      request,
      source: { type: 'manual', requestedBy: alice.userId },
      maxRevisionAttempts: 3,
      budgetLimitUsd: 2,
    });
  }

  const bob = await createUserWithWorkspace(s.db, { ...DEMO_ACCOUNTS[1], settings: { maxConcurrentRuns: 2 } });
  const bobProject = await addProject(s, bob.workspace.id, 0, {
    name: 'Side Project',
    description: 'Bob の個人プロジェクト（alice からは見えない）',
    color: '#34d399',
    repo: 'bob/side-project',
    automation: false,
  });
  await addHistoricalRun(s, {
    workspaceId: bob.workspace.id,
    projectId: bobProject.project.id,
    binding: bobProject.binding,
    title: 'README に開発手順を追記',
    request: 'README にローカル開発の手順を追記する',
    minutesAgo: 90,
    final: 'completed',
  });
  log.info('seed complete', { users: DEMO_ACCOUNTS.map((a) => a.username) });
  return true;
}
