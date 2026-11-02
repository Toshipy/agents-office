/**
 * Claude を実行基盤とする Runner（ADR-007/008 の候補のうち Claude を採用）。
 *
 * モデルの呼び出し方は 2 通りあり、ModelBackend で差し替える:
 *  - ClaudeApiBackend: Claude API（API キー・従量課金）
 *  - ClaudeCodeBackend: この PC でログイン済みの Claude Code CLI（サブスク等）
 *
 * 工程の流れ・成果物・安全確認はバックエンドによらず共通:
 *  - Planner / Reviewer: 構造化出力で計画とレビュー結果を JSON で受け取る
 *  - Developer: Run ごとの隔離 worktree でファイルを変更。終了後に変更パスを検査し、禁止パスへの変更があれば破棄
 *  - Tester: 利用者が Project に設定したコマンドだけを worktree で実行（シェルは使わない）
 *  - PR: 人の publish 承認の後にだけ push・PR 作成を行う。承認した head と worktree の HEAD が違えば何もしない
 *    （GitHub App 連携のない Repo は worktree のブランチを PR とみなす）
 *
 * 依頼本文・Issue・リポジトリ内容は非信頼入力として扱い、ツールポリシーは変更しない（基本設計書 9.3）。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PATTERNS, detectDangerous } from '@paw/sim-content';
import type { AgentRunner, PublishPreview, StepExecutionContext, StepOutput } from '../runner';
import { PublishStaleError, RunnerError } from '../runner';
import { sha256Hex } from '../../lib/crypto';
import { assertGitLink, changedPaths, commitAll, confine, diffFromBase, discardChanges, ensureWorktree, headSha, listFiles, removeWorktree, worktreeExists, type Worktree } from './git';
import type { RemoteRepoHost } from '../../github/repoHost';
import type { ModelBackend } from './shared';
import type { TestSandbox } from './testSandbox';
import { DEVELOPER_SYSTEM, PLANNER_SYSTEM, PlanOutput, REVIEWER_SYSTEM, ReviewOutput, bullet } from './shared';

const MAX_DIFF_FOR_REVIEW = 200 * 1024;

/** PR 本文・成果物に書くテスト結果の 1 行 */
function testsLineOf(previous: Record<string, unknown>): string {
  if (previous.testsSkipped) return '未実行（コマンド未設定）';
  return previous.testsPassed === false ? '✗ 失敗' : '✓ 通過';
}

/**
 * GitHub に出す PR の本文（副作用なし）。publish 承認で人に見せる本文と、承認後に PR へ書く本文は同じものを使う。
 * 1 行目は Issue のある Run だけ `Closes #<番号>`。
 */
export function buildPullRequestBody(args: {
  issueNumber: number | null;
  developerSummary: string;
  reviewSummary: string;
  testsLine: string;
  filesChanged: number;
  runId: string;
}): string {
  return [
    ...(args.issueNumber ? [`Closes #${args.issueNumber}`, ''] : []),
    '## 内容',
    '',
    args.developerSummary,
    '',
    '## AI レビュー',
    '',
    args.reviewSummary,
    '',
    `- テスト: ${args.testsLine}`,
    `- 変更: ${args.filesChanged} ファイル`,
    '',
    '---',
    `Run \`${args.runId}\``,
    'この PR は agents-office が作りました。マージは人が行います。',
  ].join('\n');
}

export interface ClaudeRunnerOptions {
  worktreesDir: string;
  testTimeoutMs: number;
  /** Tester の実行場所（サーバーモードは Docker コンテナ） */
  testSandbox: TestSandbox;
  backend: ModelBackend;
  /** GitHub App 連携（管理クローンの取得・push・PR）。未設定ならローカルリポジトリのみ */
  remoteHost?: RemoteRepoHost | null;
}

export class ClaudeRunner implements AgentRunner {
  readonly name: string;
  private readonly backend: ModelBackend;

  constructor(private readonly opts: ClaudeRunnerOptions) {
    this.backend = opts.backend;
    this.name = opts.backend.runtime;
  }

  async execute(ctx: StepExecutionContext): Promise<StepOutput> {
    try {
      return await this.executeInner(ctx);
    } catch (err) {
      // 中止・タイムアウトはエンジン側の扱い（中止 / 上限付き再試行）に任せる
      if (ctx.signal.aborted) throw ctx.signal.reason;
      throw err;
    }
  }

  private async executeInner(ctx: StepExecutionContext): Promise<StepOutput> {
    if (!ctx.localRepo) throw new RunnerError('Claude 実行にはローカルリポジトリの設定が必要です', 'LOCAL_REPO_MISSING', false);
    let baseRef: string | undefined;
    if (ctx.remote) {
      if (!this.opts.remoteHost) throw new RunnerError('GitHub App が設定されていないため、このリポジトリでは実行できません', 'GITHUB_APP_UNAVAILABLE', false);
      // 作業コピーを作る前に、GitHub の最新を取得して起点を決める（以降の工程は同じ作業コピーを使う）
      if (!worktreeExists(this.opts.worktreesDir, ctx.runId)) baseRef = (await this.opts.remoteHost.prepare(ctx, ctx.localRepo.path, ctx.remote)).baseRef;
    }
    const wt = await ensureWorktree(ctx.localRepo.path, this.opts.worktreesDir, ctx.runId, ctx.branch, ctx.signal, baseRef);
    switch (ctx.key) {
      case 'plan':
        return this.plan(ctx, wt);
      case 'implement':
        return this.implement(ctx, wt);
      case 'test':
        return this.test(ctx, wt);
      case 'review':
        return this.review(ctx, wt);
      case 'draft_pr':
      case 'update_pr':
        return this.pullRequest(ctx, wt);
    }
  }

  async onRunFinished(runId: string, localRepoPath: string | null, branch: string) {
    if (!localRepoPath) return;
    // コミットのあるブランチは残し（人がレビュー・マージする）、作業用の worktree を片付ける
    await removeWorktree(localRepoPath, `${this.opts.worktreesDir}/${runId}`, branch).catch(() => undefined);
  }

  /* ---------------------------------------------------------------- */

  private async repoContext(wt: Worktree) {
    const worktree = wt.path;
    const files = await listFiles(wt);
    const shown = files.slice(0, 400);
    let readme = '';
    for (const name of ['README.md', 'readme.md', 'README']) {
      if (existsSync(`${worktree}/${name}`)) {
        readme = (await readFile(`${worktree}/${name}`, 'utf8')).slice(0, 8000);
        break;
      }
    }
    return [
      `ファイル数: ${files.length}${files.length > shown.length ? `（先頭 ${shown.length} 件のみ表示）` : ''}`,
      shown.join('\n'),
      readme ? `\n--- README（先頭 8000 文字）---\n${readme}` : '',
    ].join('\n');
  }

  private async plan(ctx: StepExecutionContext, wt: Worktree): Promise<StepOutput> {
    const worktree = wt.path;
    await ctx.log(`${this.backend.label}で計画を作成 — 依頼本文は非信頼入力として扱う`);
    await ctx.tool('issue.read', {}, '依頼内容を取得');
    await ctx.tool('repo.read', { repo: ctx.repo }, 'リポジトリ構造を参照');
    const context = await this.repoContext(wt);
    const { output: plan, model } = await this.backend.structured(ctx, {
      purpose: 'plan',
      schema: PlanOutput,
      system: PLANNER_SYSTEM,
      worktree,
      gitDir: wt.gitDir,
      user: [
        `<untrusted_request>\nタイトル: ${ctx.title}\n\n${ctx.request}\n</untrusted_request>`,
        ctx.guidance ? `人からの追加指示（信頼できる指示）: ${ctx.guidance}` : '',
        `<repository_context>\n${context}\n</repository_context>`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });

    // 危険操作の判定はモデルの出力だけに頼らず、プログラムの検査も併用する（NFR-009）
    const detected = Array.from(new Set([...detectDangerous(`${ctx.title}\n${ctx.request}`), ...plan.dangerous_operations]));
    const flags: string[] = [];
    if (PATTERNS.injection.test(`${ctx.title}\n${ctx.request}`)) flags.push('非信頼入力内に AI への指示文を検出。ツールポリシー・承認要件は変更しません。');
    if (!ctx.guidance && detected.length > 0) {
      await ctx.log(`危険な操作を検知: ${detected.join(' / ')} — 実行を停止して判断を求めます`, 'error');
      return {
        status: 'succeeded',
        summary: `危険な操作（${detected.join('、')}）を含むため停止`,
        outcome: { needsInput: true, reason: 'dangerous_operation', detected, questions: plan.questions.length ? plan.questions : ['危険な操作を除外した安全な範囲で進めてよいですか？'] },
      };
    }
    if (!ctx.guidance && plan.needs_human_decision && plan.questions.length > 0) {
      await ctx.log('要件が曖昧なため判断を求めます', 'error');
      return {
        status: 'succeeded',
        summary: '要件の確認が必要',
        outcome: { needsInput: true, reason: 'clarification', questions: plan.questions, detected: [] },
      };
    }
    const steps = [
      { id: 'plan', role: 'planner' as const, dependsOn: [] },
      { id: 'implement', role: 'developer' as const, dependsOn: ['plan'] },
      { id: 'test', role: 'tester' as const, dependsOn: ['implement'] },
      { id: 'review', role: 'reviewer' as const, dependsOn: ['test'] },
      { id: 'draft_pr', role: 'tool_broker' as const, dependsOn: ['review'] },
    ];
    const md = [
      `# 実行計画 — ${ctx.title}`,
      '',
      `> ${this.backend.label}・${model} が作成`,
      '',
      '## 概要',
      '',
      plan.summary,
      '',
      ...(ctx.guidance ? ['## 人からの追加指示', '', `> ${ctx.guidance}`, ''] : []),
      '## 進め方',
      '',
      ...plan.approach.map((a, i) => `${i + 1}. ${a}`),
      '',
      '## 変更予定ファイル',
      '',
      bullet(plan.files_to_change.map((f) => `\`${f}\``)),
      '',
      '## 受入条件',
      '',
      ...plan.acceptance_criteria.map((c) => `- [ ] ${c}`),
      '',
      '## リスク',
      '',
      bullet(plan.risks),
      '',
      '## 必要権限',
      '',
      `- リポジトリ読み取り・隔離 worktree への書き込み（ブランチ \`${ctx.branch}\`）`,
      '- main へのマージ: **不可**（人間の操作）',
      ...(flags.length ? ['', '## 注意', '', bullet(flags)] : []),
      '',
    ].join('\n');
    await ctx.tool('plan.write', {}, '計画を保存');
    await ctx.artifact('plan', '実行計画', 'plan.md', 'text/markdown', md);
    return {
      status: 'succeeded',
      summary: plan.summary.slice(0, 200),
      outcome: { plan: { steps, maxRevisionAttempts: 3, summary: plan.summary.slice(0, 500), flags }, detail: plan },
    };
  }

  private async implement(ctx: StepExecutionContext, wt: Worktree): Promise<StepOutput> {
    const worktree = wt.path;
    await ctx.tool('worktree.write', { branch: ctx.branch }, `隔離 worktree で作業: ${ctx.branch}`);
    // 修正の前に（再開・再試行でも）、人が ai/ ブランチへ足したコミットを取り込む（取り込まずに push すると non-fast-forward になる）
    if (ctx.remote && this.opts.remoteHost) await this.opts.remoteHost.syncBranch(ctx, wt, ctx.remote, ctx.branch);
    const detail = ctx.previous.planDetail as PlanOutput | undefined;
    const feedback = [
      ctx.revision > 0 && ctx.guidance ? `PR レビューでの指摘（revision ${ctx.revision}）: ${ctx.guidance}` : '',
      ctx.previous.lastFailure ? `前回の検証で見つかった問題: ${String(ctx.previous.lastFailure)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const { summary } = await this.backend.develop(ctx, {
      system: DEVELOPER_SYSTEM,
      worktree,
      gitDir: wt.gitDir,
      user: [
        `<untrusted_request>\nタイトル: ${ctx.title}\n\n${ctx.request}\n</untrusted_request>`,
        detail
          ? `計画（Planner 作成）:\n${detail.summary}\n\n進め方:\n${detail.approach.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\n受入条件:\n${bullet(detail.acceptance_criteria)}`
          : '',
        feedback ? `今回対応すること:\n${feedback}` : '',
        '必要なファイルを調べてから変更してください。変更が終わったら、変更内容を 3 行以内で要約して終了してください。',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    // AI が作業ツリーの .git を書き換えていないことを確かめてから、git 操作に進む
    await assertGitLink(wt);
    await this.verifyChanges(ctx, wt);
    const sha = await commitAll(wt, `${ctx.title}\n\nrun: ${ctx.runId} (revision ${ctx.revision})`);
    await ctx.log(sha ? `コミット作成: ${sha.slice(0, 7)} on ${ctx.branch}` : '変更はありませんでした', sha ? 'log' : 'error');
    const diff = await diffFromBase(wt, wt.baseSha);
    const additions = diff.files.reduce((a, f) => a + f.additions, 0);
    const deletions = diff.files.reduce((a, f) => a + f.deletions, 0);
    await ctx.artifact('diff', `差分（revision ${ctx.revision}）`, 'changes.diff', 'text/x-diff', diff.patch || '# 変更なし\n');
    return {
      status: 'succeeded',
      summary: `${diff.files.length} ファイル変更 (+${additions} −${deletions})${summary ? ` — ${summary.slice(0, 120)}` : ''}`,
      outcome: { diff: { files: diff.files, additions, deletions }, commitSha: sha, developerSummary: summary },
    };
  }

  /**
   * コミット前に、作業コピーで変更されたパスを検査する（どのバックエンドでも実施）。
   * Claude Code のように外部プロセスがファイルを書いた場合でも、CI 設定・git フック・秘密値・
   * AI エージェント設定・worktree 外を指すリンクへの変更は取り込まない。
   */
  private async verifyChanges(ctx: StepExecutionContext, wt: Worktree) {
    const worktree = wt.path;
    const paths = await changedPaths(wt);
    const violations: string[] = [];
    for (const p of paths) {
      const c = confine(worktree, p);
      if (!c.ok) violations.push(`${p}（${c.reason}）`);
    }
    if (violations.length === 0) return;
    await discardChanges(wt);
    await ctx.log(`禁止されたパスへの変更を検出したため、この試行の変更をすべて破棄しました: ${violations.slice(0, 5).join(' / ')}`, 'error');
    throw new RunnerError(`禁止されたパスへの変更を検出しました: ${violations.slice(0, 5).join(' / ')}`, 'FORBIDDEN_CHANGE', false);
  }

  private async test(ctx: StepExecutionContext, wt: Worktree): Promise<StepOutput> {
    const worktree = wt.path;
    const command = ctx.localRepo?.testCommand?.trim();
    if (!command) {
      await ctx.log('テストコマンドが未設定のため実行しません（Projects でテストコマンドを設定できます）', 'error');
      const report = { runtime: ctx.runtime, commands: [], passed: true, skipped: true, note: 'テストコマンド未設定' };
      await ctx.artifact('test_report', 'テスト結果（未実行）', 'test-report.json', 'application/json', JSON.stringify(report, null, 2));
      return { status: 'succeeded', summary: 'テスト未実行（コマンド未設定）', outcome: { passed: true, skipped: true, total: 0, failed: 0 } };
    }
    const commands = command.split('&&').map((c) => c.trim()).filter(Boolean);
    const results: { command: string; exitCode: number; timedOut: boolean; output: string }[] = [];
    let passed = true;
    for (const c of commands) {
      const [bin, ...args] = c.split(/\s+/);
      const decision = await ctx.tool('shell.test', { cmd: c }, c);
      if (!decision.allowed) {
        passed = false;
        results.push({ command: c, exitCode: -1, timedOut: false, output: decision.reason });
        break;
      }
      const r = await this.opts.testSandbox.exec(bin, args, {
        worktree,
        timeoutMs: this.opts.testTimeoutMs,
        signal: ctx.signal,
        image: ctx.localRepo?.testImage ?? null,
        runId: ctx.runId,
        attempt: ctx.attempt,
      });
      // コンテナ内のコードは /work/.git を書き換えられる。以降の git 操作の前に、記録した中身と一致するか確かめる
      await assertGitLink(wt);
      const output = `${r.stdout}\n${r.stderr}`.trim();
      results.push({ command: c, exitCode: r.code, timedOut: r.timedOut, output: output.slice(-20_000) });
      await ctx.log(`${r.code === 0 ? '✓' : '✗'} ${c}（exit ${r.code}${r.timedOut ? '・タイムアウト' : ''}）`, r.code === 0 ? 'log' : 'error');
      if (r.code !== 0) {
        passed = false;
        break;
      }
    }
    const failedOutput = results.find((r) => r.exitCode !== 0)?.output ?? null;
    await ctx.artifact(
      'test_report',
      `テスト結果（${passed ? '成功' : '失敗'}）`,
      'test-report.json',
      'application/json',
      JSON.stringify({ runtime: ctx.runtime, passed, commands: results }, null, 2),
    );
    return {
      status: 'succeeded',
      summary: passed ? `${commands.length} コマンド成功` : 'テストが失敗',
      outcome: { passed, total: commands.length, failed: passed ? 0 : 1, failure: failedOutput ? failedOutput.slice(-1500) : null },
    };
  }

  private async review(ctx: StepExecutionContext, wt: Worktree): Promise<StepOutput> {
    const worktree = wt.path;
    await ctx.tool('diff.read', {}, '差分を取得');
    await ctx.tool('ci.read', {}, 'テスト結果を確認');
    const diff = await diffFromBase(wt, wt.baseSha);
    const truncated = diff.patch.length > MAX_DIFF_FOR_REVIEW;
    if (truncated) await ctx.log(`差分が大きいため先頭 ${MAX_DIFF_FOR_REVIEW / 1024}KB のみレビュー対象にします`, 'error');
    const detail = ctx.previous.planDetail as PlanOutput | undefined;
    const { output: review, model } = await this.backend.structured(ctx, {
      purpose: 'review',
      schema: ReviewOutput,
      system: REVIEWER_SYSTEM,
      worktree,
      gitDir: wt.gitDir,
      user: [
        `<untrusted_request>\nタイトル: ${ctx.title}\n\n${ctx.request}\n</untrusted_request>`,
        detail ? `受入条件:\n${bullet(detail.acceptance_criteria)}` : '',
        `テスト結果: ${ctx.previous.testsSkipped ? '未実行（テストコマンド未設定）' : ctx.previous.testsPassed === false ? '失敗' : '成功'}`,
        `<repository_context>\n差分（${diff.files.length} ファイル${truncated ? `・先頭 ${MAX_DIFF_FOR_REVIEW / 1024}KB のみ` : ''}）:\n${diff.patch.slice(0, MAX_DIFF_FOR_REVIEW) || '（変更なし）'}\n</repository_context>`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    const blockers = diff.files.length === 0 ? ['変更がありません', ...review.blockers] : review.blockers;
    const approved = review.verdict === 'ready_for_draft_pr' && blockers.length === 0;
    const md = [
      `# レビュー結果 — ${ctx.title}`,
      '',
      `> ${this.backend.label}・${model} によるレビュー。**これは AI による自己レビューであり、PR の承認ではありません。**`,
      '',
      review.summary,
      '',
      '## 受入条件との照合',
      '',
      ...(review.criteria.length ? review.criteria.map((c) => `- ${c.met ? '✓' : '✗'} ${c.criterion}${c.note ? ` — ${c.note}` : ''}`) : ['- （受入条件なし）']),
      '',
      '## 指摘',
      '',
      ...blockers.map((b) => `- **blocker**: ${b}`),
      ...review.nits.map((n) => `- nit: ${n}`),
      ...(blockers.length + review.nits.length === 0 ? ['- なし'] : []),
      '',
      '## 判定',
      '',
      approved ? 'PR として提出可能です。マージ可否は人間がレビューで判断します。' : '修正が必要です。Developer に差し戻します。',
      '',
    ].join('\n');
    await ctx.tool('review.write', {}, approved ? `指摘: blocker 0 / nit ${review.nits.length}` : `blocker ${blockers.length} 件`);
    await ctx.artifact('review', 'AI レビュー', 'review.md', 'text/markdown', md);
    // 通ったときは、エンジンが publish 承認に載せる PR の中身（head・差分のハッシュ・タイトル・本文）を返す
    const publish = approved ? await this.publishPreview(ctx, wt, review.summary) : undefined;
    return {
      status: 'succeeded',
      summary: approved ? 'PR 提出可（人間の承認ではない）' : `blocker ${blockers.length} 件（差し戻し）`,
      outcome: { approved, blockers, nits: review.nits, reviewSummary: review.summary, ...(publish ? { publish } : {}) },
    };
  }

  /** 今の worktree（HEAD・base からの差分）から、publish 承認で人に見せる PR の中身を作る */
  private async publishPreview(ctx: StepExecutionContext, wt: Worktree, reviewSummary: string): Promise<PublishPreview> {
    const diff = await diffFromBase(wt, wt.baseSha);
    return {
      headSha: await headSha(wt),
      diffSha256: sha256Hex(diff.patch),
      title: ctx.title,
      body: buildPullRequestBody({
        issueNumber: ctx.issueNumber,
        developerSummary: String(ctx.previous.developerSummary ?? ctx.title),
        reviewSummary,
        testsLine: testsLineOf(ctx.previous),
        filesChanged: diff.files.length,
        runId: ctx.runId,
      }),
    };
  }

  private async pullRequest(ctx: StepExecutionContext, wt: Worktree): Promise<StepOutput> {
    // push・PR 作成の前に、作業ツリーの .git が書き換えられていないことを確かめる
    await assertGitLink(wt);
    // 人が publish 承認で確かめた head と今の HEAD が違えば、承認していない内容なので何も書かない（エンジンが承認を作り直す）
    const approved = ctx.previous.publish as { headSha?: unknown; title?: unknown; body?: unknown } | undefined;
    const head = await headSha(wt);
    if (!approved || approved.headSha !== head) {
      await ctx.log(`承認した head（${String(approved?.headSha ?? 'なし').slice(0, 12)}）と worktree の HEAD（${head.slice(0, 12)}）が違うため、push せずテストと AI レビューからやり直します`, 'error');
      throw new PublishStaleError('承認した内容から worktree の HEAD が変わっています');
    }
    const update = ctx.key === 'update_pr' && ctx.pr !== null;
    const remote = ctx.remote;
    const push = await ctx.tool('github.branch.push', { repo: ctx.repo, branch: ctx.branch }, `ブランチを確定: ${ctx.branch}${remote ? '（GitHub に push）' : '（ローカル）'}`);
    if (!push.allowed) return { status: 'failed', summary: `ポリシーで拒否: ${push.reason}`, outcome: {}, errorCode: 'POLICY_DENIED' };
    const tool = update ? 'github.pull_request.update' : 'github.pull_request.create';
    const res = await ctx.tool(
      tool,
      { repo: ctx.repo, branch: ctx.branch, base: remote?.defaultBranch ?? 'main', draft: false },
      update ? `PR #${ctx.pr!.number} を更新` : `PR を作成${remote ? '（GitHub）' : '（ローカル）'}`,
    );
    if (!res.allowed) return { status: 'failed', summary: `ポリシーで拒否: ${res.reason}`, outcome: {}, errorCode: 'POLICY_DENIED' };
    const diff = await diffFromBase(wt, wt.baseSha);
    const testsLine = testsLineOf(ctx.previous);
    let pr: { number: number; url: string; branch: string; headSha: string; draft: false };
    if (remote) {
      // タイトル・本文は人が承認したものをそのまま使う
      const published = await this.opts.remoteHost!.publish(ctx, wt, remote, {
        branch: ctx.branch,
        // 照合済みなので head は承認した SHA。push するのはこのコミットだけ
        headSha: head,
        existing: update ? { number: ctx.pr!.number, url: ctx.pr!.url } : null,
        title: String(approved.title ?? ctx.title),
        body: String(approved.body ?? ''),
      });
      pr = { number: published.number, url: published.url, branch: ctx.branch, headSha: published.headSha, draft: false };
    } else {
      const number = update ? ctx.pr!.number : await ctx.allocatePrNumber();
      pr = { number, url: `local-git://${ctx.localRepo!.path}#${ctx.branch}`, branch: ctx.branch, headSha: head, draft: false };
    }
    const md = [
      `# ${update ? 'PR 更新' : 'PR 作成'} — #${pr.number}`,
      '',
      remote ? `- GitHub: ${pr.url}` : `- リポジトリ: \`${ctx.localRepo!.path}\``,
      `- ブランチ: \`${ctx.branch}\`（base: \`${remote ? `${remote.defaultBranch} @ ` : ''}${wt.baseSha.slice(0, 7)}\`）`,
      `- head: \`${pr.headSha.slice(0, 12)}\``,
      `- 変更: ${diff.files.length} ファイル`,
      `- テスト: ${testsLine}`,
      '',
      '## 内容',
      '',
      String(ctx.previous.developerSummary ?? ctx.title),
      '',
      '## AI レビュー',
      '',
      String(ctx.previous.reviewSummary ?? ''),
      '',
      '---',
      remote
        ? 'GitHub 上でレビューしてください。Approve で Run は完了、Request changes で同じ PR を修正します。マージは人が行います（AI はマージしません）。'
        : `ローカル版では GitHub に push しません。ブランチ \`${ctx.branch}\` を確認し、問題なければ人がマージしてください（AI はマージしません）。`,
      '',
    ].join('\n');
    await ctx.artifact('draft_pr', `PR #${pr.number}${update ? '（更新）' : ''}`, 'draft-pr.md', 'text/markdown', md);
    return { status: 'succeeded', summary: `PR #${pr.number} ${update ? '更新' : '作成'}（ブランチ ${ctx.branch}）`, outcome: { pr } };
  }
}
