/**
 * GitHub 上のリポジトリを、サーバー上の管理クローン（.data/repos/<repositoryId>）経由で扱う。
 *  - prepare: クローン（初回）/ fetch して、Run の作業ブランチの起点（origin/<既定ブランチ>）を返す
 *  - publish: ai/ ブランチを push し、PR を作成（更新時は push のみ。PR は GitHub 側で自動更新される）
 *
 * Installation token は GIT_ASKPASS 経由で git に渡す（コマンド引数・remote URL・git の設定に残さない）。
 * credential.helper は空にして、OS の資格情報ストアにも保存させない。
 * これらの操作は API プロセスが Tool Broker の判定後に行い、Claude Code（Runner）にはトークンを渡さない。
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { StepExecutionContext } from '../agents/runner';
import { RunnerError } from '../agents/runner';
import { headSha, run, safeEnv, wtArgs, type Worktree } from '../agents/claude/git';
import { Mutex } from '../lib/mutex';
import { GithubApiError, type GithubApp } from './app';

export interface RemoteRepo {
  provider: 'github';
  installationId: number;
  repositoryId: number;
  fullName: string;
  defaultBranch: string;
  cloneUrl: string;
}

export interface RemoteRepoHost {
  prepare(ctx: StepExecutionContext, localPath: string, remote: RemoteRepo): Promise<{ baseRef: string }>;
  publish(
    ctx: StepExecutionContext,
    wt: Worktree,
    remote: RemoteRepo,
    args: { branch: string; existing: { number: number; url: string } | null; title: string; body: string },
  ): Promise<{ number: number; url: string; headSha: string }>;
  /** GitHub 上の ai/ ブランチに人が足したコミットを worktree へ取り込む。履歴が分岐していたら BRANCH_DIVERGED */
  syncBranch(ctx: StepExecutionContext, wt: Worktree, remote: RemoteRepo, branch: string): Promise<'up_to_date' | 'fast_forwarded'>;
}

const ASKPASS = `#!/bin/sh
# GitHub の Installation token を git に渡すための askpass（トークンは環境変数でだけ受け取る）
case "$1" in
  Username*|username*) printf '%s\\n' "x-access-token" ;;
  *) printf '%s\\n' "$PAW_GIT_ASKPASS_TOKEN" ;;
esac
`;

/** GitHub API の失敗を、コードと再試行可否つきの RunnerError に変換する */
export function githubRunnerError(err: unknown, what: string): RunnerError {
  if (err instanceof RunnerError) return err;
  if (err instanceof GithubApiError) {
    if (err.status === 401 || err.status === 403 || err.status === 404) {
      return new RunnerError(`${what}: GitHub App の権限・インストールを確認してください（${err.status} ${err.detail.slice(0, 200)}）`, 'GITHUB_AUTH_ERROR', false);
    }
    if (err.status === 422) return new RunnerError(`${what}: GitHub が受け付けませんでした（${err.detail.slice(0, 300)}）`, 'GITHUB_REJECTED', false);
    return new RunnerError(`${what}: GitHub API エラー（${err.status}）`, 'GITHUB_API_ERROR', true);
  }
  return new RunnerError(`${what}: ${String((err as Error)?.message ?? err).slice(0, 300)}`, 'GITHUB_API_ERROR', true);
}

export class GithubRepoHost implements RemoteRepoHost {
  private readonly locks = new Map<number, Mutex>();

  constructor(
    private readonly app: GithubApp,
    private readonly dataRoot: string,
  ) {}

  private lock(repositoryId: number) {
    let m = this.locks.get(repositoryId);
    if (!m) {
      m = new Mutex();
      this.locks.set(repositoryId, m);
    }
    return m;
  }

  private async gitEnv(installationId: number) {
    const askpass = resolve(this.dataRoot, 'git-askpass.sh');
    if (!existsSync(askpass)) {
      await mkdir(this.dataRoot, { recursive: true });
      await writeFile(askpass, ASKPASS, { mode: 0o700 });
    }
    let token: string;
    try {
      token = await this.app.installationToken(installationId);
    } catch (err) {
      throw githubRunnerError(err, 'Installation token を取得できません');
    }
    return safeEnv({ GIT_ASKPASS: askpass, PAW_GIT_ASKPASS_TOKEN: token });
  }

  async prepare(ctx: StepExecutionContext, localPath: string, remote: RemoteRepo): Promise<{ baseRef: string }> {
    return this.lock(remote.repositoryId).run(async () => {
      const env = await this.gitEnv(remote.installationId);
      if (!existsSync(join(localPath, '.git'))) {
        await ctx.log(`GitHub から ${remote.fullName} を取得します（初回のみ）`);
        await mkdir(dirname(localPath), { recursive: true });
        const r = await run('git', ['-c', 'credential.helper=', 'clone', '--no-tags', '--quiet', remote.cloneUrl, localPath], {
          cwd: dirname(localPath),
          env,
          timeoutMs: 15 * 60_000,
          signal: ctx.signal,
        });
        if (r.code !== 0) throw new RunnerError(`リポジトリを取得できません: ${r.stderr.trim().slice(-300)}`, 'GIT_CLONE_FAILED', true);
      } else {
        // remote URL は常に資格情報を含まないクローン URL にしておく
        await run('git', ['remote', 'set-url', 'origin', remote.cloneUrl], { cwd: localPath, env: safeEnv() });
        const r = await run('git', ['-c', 'credential.helper=', 'fetch', '--prune', '--no-tags', '--quiet', 'origin'], {
          cwd: localPath,
          env,
          timeoutMs: 10 * 60_000,
          signal: ctx.signal,
        });
        if (r.code !== 0) throw new RunnerError(`リポジトリを更新できません: ${r.stderr.trim().slice(-300)}`, 'GIT_FETCH_FAILED', true);
      }
      await ctx.log(`起点: origin/${remote.defaultBranch}`);
      return { baseRef: `refs/remotes/origin/${remote.defaultBranch}` };
    });
  }

  async publish(
    ctx: StepExecutionContext,
    wt: Worktree,
    remote: RemoteRepo,
    args: { branch: string; existing: { number: number; url: string } | null; title: string; body: string },
  ) {
    if (!/^ai\/[A-Za-z0-9._/-]+$/.test(args.branch)) throw new RunnerError('ai/ 以外のブランチには push しません', 'POLICY_DENIED', false);
    const env = await this.gitEnv(remote.installationId);
    // 強制 push はしない（人が同じブランチに追加したコミットを消さない）
    // フックは実行しない（リポジトリ由来の設定でトークンを持つプロセスにコードを実行させない）
    // 作業ツリーの .git は信用せず記録した gitDir を使い、push 先も origin ではなく取得済みのクローン URL を明示する
    const push = wtArgs(wt, ['push', '--quiet', '--no-verify', remote.cloneUrl, `HEAD:refs/heads/${args.branch}`]);
    const r = await run('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...push.args], {
      cwd: push.cwd,
      env,
      timeoutMs: 10 * 60_000,
      signal: ctx.signal,
    });
    if (r.code !== 0) throw new RunnerError(`ブランチ ${args.branch} を push できません: ${r.stderr.trim().slice(-300)}`, 'GIT_PUSH_FAILED', false);
    const sha = await headSha(wt);
    await ctx.log(`GitHub に push: ${args.branch}（${sha.slice(0, 7)}）`);
    if (args.existing) return { number: args.existing.number, url: args.existing.url, headSha: sha };
    try {
      // 再試行で PR 作成が 2 回目になっても 422 にならないよう、先に同じブランチの open な PR を探す
      const found = await this.app.findOpenPullByHead(remote.installationId, remote.fullName, args.branch);
      if (found) {
        await ctx.log(`既存の PR #${found.number} を使用: ${found.htmlUrl}`);
        return { number: found.number, url: found.htmlUrl, headSha: sha };
      }
      const pr = await this.app.createPullRequest(remote.installationId, remote.fullName, {
        title: args.title.slice(0, 250),
        head: args.branch,
        base: remote.defaultBranch,
        body: args.body.slice(0, 60_000),
      });
      await ctx.log(`PR #${pr.number} を作成: ${pr.htmlUrl}`);
      return { number: pr.number, url: pr.htmlUrl, headSha: sha };
    } catch (err) {
      throw githubRunnerError(err, 'PR を作成できません');
    }
  }

  async syncBranch(ctx: StepExecutionContext, wt: Worktree, remote: RemoteRepo, branch: string): Promise<'up_to_date' | 'fast_forwarded'> {
    if (!/^ai\/[A-Za-z0-9._/-]+$/.test(branch)) throw new RunnerError('ai/ 以外のブランチは取り込みません', 'POLICY_DENIED', false);
    const env = await this.gitEnv(remote.installationId);
    const tracking = `refs/remotes/origin/${branch}`;
    // 作業ツリーの .git は信用せず記録した gitDir を使い、取得先も取得済みのクローン URL を明示する（refs は共有オブジェクトストアに入る）
    const fetch = wtArgs(wt, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', remote.cloneUrl, `+refs/heads/${branch}:${tracking}`]);
    // 管理クローンの fetch と同じ共有オブジェクトストアを触るので、リポジトリ単位の排他に入れる
    const f = await this.lock(remote.repositoryId).run(() =>
      run('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...fetch.args], {
        cwd: fetch.cwd,
        env,
        timeoutMs: 10 * 60_000,
        signal: ctx.signal,
      }),
    );
    if (f.code !== 0) {
      // まだ GitHub に無いブランチなら、取り込むものは無い
      if (/couldn't find remote ref/i.test(f.stderr)) return 'up_to_date';
      throw new RunnerError(`ブランチ ${branch} を取得できません: ${f.stderr.trim().slice(-300)}`, 'GIT_FETCH_FAILED', true);
    }
    const git = async (args: string[]) => {
      const a = wtArgs(wt, args);
      return run('git', ['-c', 'core.hooksPath=/dev/null', ...a.args], { cwd: a.cwd, env: safeEnv(), timeoutMs: 120_000, signal: ctx.signal });
    };
    // merge-base --is-ancestor は 0=祖先 / 1=祖先でない / それ以外（128 等）=git の失敗。失敗を「分岐」と取り違えない
    const isAncestor = async (a: string, b: string) => {
      const r = await git(['merge-base', '--is-ancestor', a, b]);
      if (r.code === 0) return true;
      if (r.code === 1) return false;
      throw new RunnerError(`履歴を比較できません: ${r.stderr.trim().slice(-300)}`, 'GIT_COMPARE_FAILED', false);
    };
    const rp = await git(['rev-parse', '--verify', tracking]);
    if (rp.code !== 0) throw new RunnerError(`取得したブランチを読めません: ${rp.stderr.trim().slice(-300)}`, 'GIT_COMPARE_FAILED', false);
    const remoteSha = rp.stdout.trim();
    const local = await headSha(wt);
    if (remoteSha === local) return 'up_to_date';
    // GitHub 側が worktree の祖先なら、人は何も足していない（AI の未 push 分が進んでいるだけ）
    if (await isAncestor(remoteSha, 'HEAD')) return 'up_to_date';
    // worktree が GitHub 側の祖先なら fast-forward で人のコミットを取り込む
    if (await isAncestor('HEAD', remoteSha)) {
      const m = await git(['merge', '--ff-only', '--quiet', remoteSha]);
      if (m.code !== 0) throw new RunnerError(`人のコミットを取り込めません: ${m.stderr.trim().slice(-300)}`, 'GIT_MERGE_FAILED', false);
      await ctx.log(`GitHub の ${branch} に足された人のコミットを取り込みました（${remoteSha.slice(0, 7)}）`);
      return 'fast_forwarded';
    }
    throw new RunnerError(
      `ブランチ ${branch} は GitHub 側と履歴が分岐しています（GitHub: ${remoteSha.slice(0, 7)} / Run: ${local.slice(0, 7)}）。人の判断が必要です`,
      'BRANCH_DIVERGED',
      false,
    );
  }
}
