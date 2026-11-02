/**
 * worktree の自己修復と、AI による .git リンクファイルの改ざん検出のテスト。
 * 実際の git リポジトリ（一時ディレクトリ）で検証する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GithubRepoHost } from './github/repoHost';
import { assertGitLink, changedPaths, ensureWorktree, headSha, removeWorktree } from './agents/claude/git';

const tmp = mkdtempSync(join(tmpdir(), 'paw-wt-'));
const repo = join(tmp, 'repo');
const wtDir = join(tmp, 'worktrees');

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
}

beforeAll(() => {
  execFileSync('mkdir', ['-p', repo]);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'init');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('worktree', () => {
  it('.base が無い作りかけの worktree を作り直す', async () => {
    const wt = await ensureWorktree(repo, wtDir, 'run_a', 'ai/run-a');
    rmSync(`${wt.path}.base`);
    const again = await ensureWorktree(repo, wtDir, 'run_a', 'ai/run-a');
    expect(existsSync(`${again.path}.base`)).toBe(true);
    expect(await headSha(again)).toBe(again.baseSha);
  });

  it('.gitlink が無い worktree も作り直す', async () => {
    const wt = await ensureWorktree(repo, wtDir, 'run_d', 'ai/run-d');
    rmSync(`${wt.path}.gitlink`);
    const again = await ensureWorktree(repo, wtDir, 'run_d', 'ai/run-d');
    expect(existsSync(`${again.path}.gitlink`)).toBe(true);
    expect(again.gitDir).toBe(wt.gitDir);
  });

  it('.git ファイルの書き換えを検出する', async () => {
    const wt = await ensureWorktree(repo, wtDir, 'run_b', 'ai/run-b');
    await expect(assertGitLink(wt)).resolves.toBeUndefined();
    writeFileSync(join(wt.path, '.git'), 'gitdir: /tmp/elsewhere\n');
    await expect(assertGitLink(wt)).rejects.toMatchObject({ code: 'GIT_LINK_TAMPERED' });
  });

  it('.git が書き換えられても changedPaths は本物の git を見る', async () => {
    const wt = await ensureWorktree(repo, wtDir, 'run_c', 'ai/run-c');
    writeFileSync(join(wt.path, 'a.txt'), 'x');
    writeFileSync(join(wt.path, '.git'), 'gitdir: /tmp/elsewhere\n');
    expect(await changedPaths(wt)).toContain('a.txt');
  });

  it('removeWorktree は .gitlink も消す', async () => {
    const wt = await ensureWorktree(repo, wtDir, 'run_e', 'ai/run-e');
    await removeWorktree(repo, wt.path, wt.branch);
    expect(existsSync(`${wt.path}.gitlink`)).toBe(false);
  });

  it('.git を別の有効な git dir に向け直すと、再取得で GIT_LINK_TAMPERED になる（作り直さない）', async () => {
    const wt = await ensureWorktree(repo, wtDir, 'run_f', 'ai/run-f');
    writeFileSync(join(wt.path, '.git'), `gitdir: ${join(repo, '.git')}\n`);
    await expect(ensureWorktree(repo, wtDir, 'run_f', 'ai/run-f')).rejects.toMatchObject({ code: 'GIT_LINK_TAMPERED' });
    expect(existsSync(`${wt.path}.gitlink`)).toBe(true);
  });

  it('リンクが無傷で git の管理情報が壊れた worktree は作り直す', async () => {
    const wt = await ensureWorktree(repo, wtDir, 'run_g', 'ai/run-g');
    rmSync(join(repo, '.git', 'worktrees', basename(wt.gitDir)), { recursive: true, force: true });
    const again = await ensureWorktree(repo, wtDir, 'run_g', 'ai/run-g');
    expect(await headSha(again)).toBe(again.baseSha);
  });

  it('publish は .git が書き換えられていても記録した gitDir で push する', async () => {
    const bare = join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    const wt = await ensureWorktree(repo, wtDir, 'run_h', 'ai/run-h');
    writeFileSync(join(wt.path, '.git'), 'gitdir: /tmp/elsewhere\n');
    const host = new GithubRepoHost({ installationToken: async () => 't', findOpenPullByHead: async () => null, createPullRequest: async () => ({ number: 1, htmlUrl: 'u' }) } as never, join(tmp, 'data'));
    const ctx = { log: async () => undefined, signal: new AbortController().signal } as never;
    const remote = { provider: 'github', installationId: 1, repositoryId: 1, fullName: 'o/r', defaultBranch: 'main', cloneUrl: bare } as const;
    const res = await host.publish(ctx, wt, remote, { branch: 'ai/run-h', existing: null, title: 't', body: 'b' });
    expect(res.headSha).toBe(wt.baseSha);
    expect(git(bare, 'rev-parse', 'refs/heads/ai/run-h').trim()).toBe(wt.baseSha);
  });
});
