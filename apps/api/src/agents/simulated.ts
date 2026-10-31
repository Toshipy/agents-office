/**
 * ローカル用シミュレーション Runner。
 * 外部 LLM / GitHub に接続せず、計画→実装→テスト→レビュー→Draft PR の流れと
 * ツール呼び出し・ポリシー判定・成果物・利用量を再現する。
 *
 * テスト・デモ用マーカー（依頼本文に含めると挙動を固定できる）:
 *   [sim:crash]      Developer Runner が毎回異常終了 → 上限付き再試行の後に失敗（AT-010）
 *   [sim:test-fail]  テストが毎回失敗 → 修正ループ上限で失敗
 *   [sim:expensive]  大量トークン消費 → Run 予算超過で停止（FR-036）
 */
import {
  PATTERNS,
  detectDangerous,
  draftPrMarkdown,
  generateDiff,
  planMarkdown,
  reviewMarkdown,
  seededRandom,
  testReport,
  type ContentContext,
  type DiffResult,
} from './content';
import { RunnerCrashError, type AgentRunner, type StepExecutionContext, type StepOutput } from './runner';
import { sha256Hex } from '../lib/crypto';

export const SIM_MODEL = 'simulated-local';

export interface SimulatedOptions {
  randomFailures: boolean;
}

function contentCtx(ctx: StepExecutionContext): ContentContext {
  return {
    runId: ctx.runId,
    title: ctx.title,
    request: ctx.request,
    repo: ctx.repo,
    revision: ctx.revision,
    guidance: ctx.guidance,
    branch: ctx.branch,
  };
}

function jitter(rand: () => number, base: number, spread: number) {
  return Math.round(base + (rand() - 0.5) * 2 * spread);
}

/** 作業の様子が見えるよう、待ち時間は少し長めにする */
const PACE = 1.35;
function work(rand: () => number, base: number, spread: number) {
  return jitter(rand, base, spread) * PACE;
}

export class SimulatedRunner implements AgentRunner {
  readonly name = 'local-simulator';

  constructor(private readonly opts: SimulatedOptions) {}

  async execute(ctx: StepExecutionContext): Promise<StepOutput> {
    const rand = seededRandom(`${ctx.stepId}:${ctx.attempt}`);
    const started = Date.now();
    let out: StepOutput;
    switch (ctx.key) {
      case 'plan':
        out = await this.plan(ctx, rand);
        break;
      case 'implement':
        out = await this.implement(ctx, rand);
        break;
      case 'test':
        out = await this.test(ctx, rand);
        break;
      case 'review':
        out = await this.review(ctx, rand);
        break;
      case 'draft_pr':
      case 'update_pr':
        out = await this.pullRequest(ctx, rand);
        break;
    }
    const expensive = PATTERNS.simExpensive.test(ctx.request);
    const scale = expensive ? 400 : 1;
    const tokens: Record<string, [number, number]> = {
      plan: [4200, 1100],
      implement: [12500, 4200],
      test: [2600, 500],
      review: [8200, 1500],
      draft_pr: [0, 0],
      update_pr: [0, 0],
    };
    const [inTok, outTok] = tokens[ctx.key];
    if (inTok > 0) {
      await ctx.usage(
        SIM_MODEL,
        jitter(rand, inTok, inTok * 0.2) * scale,
        jitter(rand, outTok, outTok * 0.2) * scale,
        Date.now() - started,
      );
    }
    return out;
  }

  private async plan(ctx: StepExecutionContext, rand: () => number): Promise<StepOutput> {
    const text = `${ctx.title}\n${ctx.request}`;
    await ctx.log('依頼本文を読み込み（Issue・依頼文は非信頼入力として扱う）');
    await ctx.tool('issue.read', {}, '依頼内容を取得');
    await ctx.sleep(work(rand, 1600, 500));
    await ctx.tool('repo.read', { repo: ctx.repo }, 'リポジトリ構造を参照: src/, tests/, package.json');
    await ctx.sleep(work(rand, 1800, 600));

    const flags: string[] = [];
    if (PATTERNS.injection.test(text)) {
      flags.push('非信頼入力内に AI への指示文を検出。ツールポリシー・承認要件は変更しません。');
      await ctx.log('⚠ 非信頼入力内に指示文を検出 — ポリシーは変更されません', 'error');
    }
    if (PATTERNS.mergeRequest.test(text)) {
      flags.push('main へのマージ要求を検出。マージは人間のみが実行できるため計画から除外します。');
    }

    const dangerous = detectDangerous(text);
    if (dangerous.length > 0 && !ctx.guidance) {
      await ctx.log(`危険な操作を検知: ${dangerous.join(' / ')} — 実行を停止して判断を求めます`, 'error');
      await ctx.sleep(work(rand, 800, 200));
      return {
        status: 'succeeded',
        summary: `危険な操作（${dangerous.join('、')}）を含むため停止`,
        outcome: {
          needsInput: true,
          reason: 'dangerous_operation',
          detected: dangerous,
          questions: [
            '危険な操作を除外した安全な範囲で実装を進めてよいですか？',
            '本番環境・Secrets への変更が必要な場合は、人間が別途実施してください。',
          ],
        },
      };
    }
    if (dangerous.length > 0) {
      flags.push(`危険な操作（${dangerous.join('、')}）は人の指示により計画から除外`);
    }

    await ctx.log('Step DAG を構築: plan → implement → test → review → draft_pr');
    await ctx.sleep(work(rand, 1500, 400));
    const steps = [
      { id: 'plan', role: 'planner' as const, dependsOn: [] },
      { id: 'implement', role: 'developer' as const, dependsOn: ['plan'] },
      { id: 'test', role: 'tester' as const, dependsOn: ['implement'] },
      { id: 'review', role: 'reviewer' as const, dependsOn: ['test'] },
      { id: 'draft_pr', role: 'tool_broker' as const, dependsOn: ['review'] },
    ];
    const md = planMarkdown(contentCtx(ctx), steps, flags);
    await ctx.tool('plan.write', {}, '計画を保存');
    await ctx.artifact('plan', '実行計画', 'plan.md', 'text/markdown', md);
    return {
      status: 'succeeded',
      summary: `${steps.length} ステップの計画を作成${flags.length ? `（注意 ${flags.length} 件）` : ''}`,
      outcome: {
        plan: { steps, maxRevisionAttempts: 3, summary: ctx.title, flags },
      },
    };
  }

  private async implement(ctx: StepExecutionContext, rand: () => number): Promise<StepOutput> {
    const text = `${ctx.title}\n${ctx.request}\n${ctx.guidance ?? ''}`;
    await ctx.tool('worktree.write', { branch: ctx.branch }, `隔離 worktree を準備: ${ctx.branch}`);
    await ctx.sleep(work(rand, 1400, 400));
    if (ctx.revision > 0 && ctx.guidance) {
      await ctx.log(`レビューコメントを反映（revision ${ctx.revision}）: ${ctx.guidance.slice(0, 80)}`);
    }
    if (ctx.fixLoops > 0 && ctx.previous.lastFailure) {
      await ctx.log(`前回の指摘を修正: ${String(ctx.previous.lastFailure).slice(0, 100)}`);
    }
    if (PATTERNS.simCrash.test(text)) {
      await ctx.sleep(work(rand, 1200, 300));
      throw new RunnerCrashError('Runner process exited unexpectedly (simulated crash)');
    }

    const diff = generateDiff(contentCtx(ctx));
    for (const f of diff.files) {
      await ctx.tool('worktree.write', { path: f.path }, `編集: ${f.path} (+${f.additions} −${f.deletions})`);
      await ctx.sleep(work(rand, 2200, 700));
    }

    // 依頼文に影響された「AI の試行」をポリシーが拒否することの実演（AT-009 / NFR-006）
    if (PATTERNS.mergeRequest.test(text)) {
      await ctx.tool('github.pull_request.merge', { repo: ctx.repo, base: 'main' }, 'main へのマージを試行');
    }
    if (PATTERNS.injection.test(text)) {
      await ctx.tool('secrets.read', { name: 'GITHUB_TOKEN' }, '秘密値の読み取りを試行');
    }

    await ctx.tool('shell.test', { cmd: 'tsc --noEmit' }, '型チェック: tsc --noEmit → OK');
    await ctx.sleep(work(rand, 1500, 500));
    const commitSha = sha256Hex(`${ctx.runId}:${ctx.stepId}:${ctx.attempt}`).slice(0, 40);
    await ctx.log(`コミット作成: ${commitSha.slice(0, 7)} on ${ctx.branch}`);
    await ctx.artifact('diff', `差分（revision ${ctx.revision}）`, 'changes.diff', 'text/x-diff', diff.patch);
    return {
      status: 'succeeded',
      summary: `${diff.files.length} ファイル変更 (+${diff.additions} −${diff.deletions})`,
      outcome: { diff: { files: diff.files, additions: diff.additions, deletions: diff.deletions }, commitSha },
    };
  }

  private async test(ctx: StepExecutionContext, rand: () => number): Promise<StepOutput> {
    const text = `${ctx.title}\n${ctx.request}`;
    await ctx.tool('shell.build', { cmd: 'pnpm build' }, 'pnpm build');
    await ctx.sleep(work(rand, 2000, 600));
    await ctx.tool('shell.lint', { cmd: 'pnpm lint' }, 'pnpm lint → 0 errors');
    await ctx.sleep(work(rand, 1200, 300));
    await ctx.tool('shell.test', { cmd: 'pnpm test' }, 'pnpm test');
    await ctx.sleep(work(rand, 2600, 800));
    const forcedFail = PATTERNS.simTestFail.test(text);
    const randomFail = this.opts.randomFailures && ctx.fixLoops === 0 && ctx.revision === 0 && rand() < 0.22;
    const passed = !(forcedFail || randomFail);
    const seed = Math.floor(rand() * 10_000);
    const report = testReport(contentCtx(ctx), passed, seed);
    await ctx.log(
      passed ? `✓ ${report.total} tests passed` : `✗ ${report.failed} failed / ${report.total} tests`,
      passed ? 'log' : 'error',
    );
    await ctx.artifact('test_report', `テスト結果（${passed ? '成功' : '失敗'}）`, 'test-report.json', 'application/json', JSON.stringify(report, null, 2));
    return {
      status: 'succeeded',
      summary: passed ? `${report.total} 件のテストが通過` : `${report.failed} 件のテストが失敗`,
      outcome: { passed, total: report.total, failed: report.failed, failure: report.failures[0]?.message ?? null },
    };
  }

  private async review(ctx: StepExecutionContext, rand: () => number): Promise<StepOutput> {
    await ctx.tool('diff.read', {}, '差分を取得');
    await ctx.sleep(work(rand, 1800, 500));
    await ctx.tool('ci.read', {}, 'テスト結果を確認');
    await ctx.sleep(work(rand, 1400, 400));
    await ctx.log('受入条件との照合中…');
    await ctx.sleep(work(rand, 1800, 500));
    const blockers =
      this.opts.randomFailures && ctx.fixLoops === 0 && ctx.revision === 0 && rand() < 0.12
        ? ['エラー時のメッセージがユーザーに表示されない']
        : [];
    const md = reviewMarkdown(contentCtx(ctx), (ctx.previous.diff as DiffResult | undefined) ?? null, blockers);
    await ctx.tool('review.write', {}, blockers.length ? `blocker ${blockers.length} 件` : '指摘: blocker 0 / nit 2');
    await ctx.artifact('review', 'AI レビュー', 'review.md', 'text/markdown', md);
    return {
      status: 'succeeded',
      summary: blockers.length ? `blocker ${blockers.length} 件（差し戻し）` : 'Draft PR 提出可（人間の承認ではない）',
      outcome: { approved: blockers.length === 0, blockers },
    };
  }

  private async pullRequest(ctx: StepExecutionContext, rand: () => number): Promise<StepOutput> {
    const update = ctx.key === 'update_pr' && ctx.pr !== null;
    const push = await ctx.tool(
      'github.branch.push',
      { repo: ctx.repo, branch: ctx.branch },
      `ブランチを push: ${ctx.branch}`,
    );
    if (!push.allowed) {
      return { status: 'failed', summary: `push がポリシーで拒否: ${push.reason}`, outcome: {}, errorCode: 'POLICY_DENIED' };
    }
    await ctx.sleep(work(rand, 900, 200));
    const tool = update ? 'github.pull_request.update' : 'github.pull_request.create_draft';
    const res = await ctx.tool(
      tool,
      { repo: ctx.repo, branch: ctx.branch, base: 'main', draft: true },
      update ? `Draft PR #${ctx.pr!.number} を更新` : 'Draft PR を作成（base: main）',
    );
    if (!res.allowed) {
      return { status: 'failed', summary: `PR 操作がポリシーで拒否: ${res.reason}`, outcome: {}, errorCode: 'POLICY_DENIED' };
    }
    await ctx.sleep(work(rand, 900, 200));
    const number = update ? ctx.pr!.number : await ctx.allocatePrNumber();
    const headSha = sha256Hex(`${ctx.runId}:${ctx.stepId}:pr`).slice(0, 40);
    const pr = {
      number,
      url: `local-github://${ctx.repo}/pull/${number}`,
      branch: ctx.branch,
      headSha,
      draft: true,
    };
    const testsPassed = (ctx.previous.testsPassed as boolean | undefined) ?? true;
    await ctx.artifact(
      'draft_pr',
      `Draft PR #${number}${update ? '（更新）' : ''}`,
      'draft-pr.md',
      'text/markdown',
      draftPrMarkdown(contentCtx(ctx), pr, testsPassed, update),
    );
    return { status: 'succeeded', summary: `Draft PR #${number} ${update ? '更新' : '作成'}`, outcome: { pr } };
  }
}
