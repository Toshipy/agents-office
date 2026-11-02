/**
 * ローカル git リポジトリの操作（Run ごとの隔離 worktree）。
 * すべて execFile（シェルを介さない）で実行し、子プロセスには秘密値を含む環境変数を渡さない。
 */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RunnerError } from '../runner';

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SESSION|COOKIE|AUTH)/i;

/** 子プロセス用の最小限の環境変数（API キー等は渡さない） */
export function safeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || SECRET_ENV.test(k) || k.startsWith('ANTHROPIC_') || k.startsWith('PAW_')) continue;
    if (['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'USER', 'NVM_DIR', 'COREPACK_HOME', 'PNPM_HOME'].includes(k)) env[k] = v;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra };
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal; maxBuffer?: number; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024,
        env: opts.env ?? safeEnv(),
        signal: opts.signal ?? undefined,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
        resolvePromise({
          code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') + (e && typeof e.code === 'string' ? `\n${e.code}: ${e.message}` : ''),
          timedOut: Boolean(e?.killed && e.signal === 'SIGTERM'),
        });
      },
    );
    child.stdin?.end();
  });
}

async function git(cwd: string, args: string[], signal?: AbortSignal) {
  const r = await run('git', args, { cwd, signal, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().slice(0, 400)}`);
  return r.stdout;
}

/** 利用者が設定したパスが git の作業ツリーかを確認する */
export async function verifyRepository(path: string, dataDir: string): Promise<{ ok: true; root: string } | { ok: false; reason: string }> {
  if (!isAbsolute(path)) return { ok: false, reason: '絶対パスで指定してください' };
  if (!existsSync(path) || !statSync(path).isDirectory()) return { ok: false, reason: 'ディレクトリが見つかりません' };
  const real = realpathSync(path);
  const data = existsSync(dataDir) ? realpathSync(dataDir) : resolve(dataDir);
  if (real === data || real.startsWith(data + sep)) return { ok: false, reason: 'データディレクトリ内は指定できません' };
  const r = await run('git', ['rev-parse', '--show-toplevel'], { cwd: real, timeoutMs: 10_000 });
  if (r.code !== 0) return { ok: false, reason: 'git リポジトリではありません' };
  const head = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: real, timeoutMs: 10_000 });
  if (head.code !== 0) return { ok: false, reason: 'コミットが 1 つもないリポジトリは使えません' };
  return { ok: true, root: r.stdout.trim() };
}

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
  /** `git rev-parse --absolute-git-dir` の値。AI が作業ツリーの .git を書き換えても、ここを明示して本物の git を見る */
  gitDir: string;
}

/** worktree 向けの git の共通引数。作業ツリーの `.git` ファイルを信用せず、記録した gitDir を使う */
export function wtArgs(wt: Worktree | string, args: string[]): { cwd: string; args: string[] } {
  if (typeof wt === 'string') return { cwd: wt, args };
  return { cwd: wt.path, args: [`--git-dir=${wt.gitDir}`, `--work-tree=${wt.path}`, ...args] };
}

async function wtGit(wt: Worktree | string, args: string[], signal?: AbortSignal) {
  const a = wtArgs(wt, args);
  return git(a.cwd, a.args, signal);
}

export function worktreeExists(worktreesDir: string, runId: string) {
  const path = resolve(worktreesDir, runId);
  return existsSync(path) && existsSync(`${path}.base`);
}

/**
 * Run 用の worktree を作る（既にあれば再利用）。ブランチは ai/ で始まる専用ブランチ。
 * baseRef は起点（ローカルリポジトリは HEAD、GitHub 連携の管理クローンは origin/<既定ブランチ>）。
 */
export async function ensureWorktree(
  repoPath: string,
  worktreesDir: string,
  runId: string,
  branch: string,
  signal?: AbortSignal,
  baseRef = 'HEAD',
): Promise<Worktree> {
  const path = resolve(worktreesDir, runId);
  const baseFile = `${path}.base`;
  const linkFile = `${path}.gitlink`;
  const oldBase = existsSync(baseFile) ? (await readFile(baseFile, 'utf8')).trim() : '';
  if (existsSync(path) && oldBase && existsSync(linkFile)) {
    // 記録した .git の中身と違えば、AI（やテスト内のコード）が書き換えたとみなして止める（作り直さない）
    const recorded = await readFile(linkFile, 'utf8');
    const live = await readFile(join(path, '.git'), 'utf8').catch(() => null);
    if (live !== recorded) throw gitLinkTampered();
    // gitDir は生きた .git ではなく、記録した中身から決める
    const gitDir = await trustedGitDir(repoPath, path, recorded);
    if (gitDir) {
      const r = await run('git', [`--git-dir=${gitDir}`, `--work-tree=${path}`, 'rev-parse', '--verify', 'HEAD'], { cwd: path, timeoutMs: 10_000 });
      if (r.code === 0) return { path, branch, baseSha: oldBase, gitDir };
    }
  }
  // 作りかけ（.base / .gitlink が無い、git が壊れている）は片付けて作り直す
  if (existsSync(path) || existsSync(baseFile) || existsSync(linkFile)) {
    await run('git', ['worktree', 'remove', '--force', path], { cwd: repoPath, timeoutMs: 60_000 });
    await rm(path, { recursive: true, force: true });
    await rm(linkFile, { force: true });
    await rm(baseFile, { force: true });
  }
  await run('git', ['worktree', 'prune'], { cwd: repoPath, timeoutMs: 30_000 });
  await mkdir(worktreesDir, { recursive: true });
  // 作り直しでも起点は変えない（.base が読めればそれを使う）
  const baseSha = oldBase || (await git(repoPath, ['rev-parse', '--verify', `${baseRef}^{commit}`], signal)).trim();
  const exists = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath });
  if (exists.code === 0) await git(repoPath, ['worktree', 'add', path, branch], signal);
  else await git(repoPath, ['worktree', 'add', '-b', branch, path, baseSha], signal);
  const linkText = await readFile(join(path, '.git'), 'utf8');
  const gitDir = await trustedGitDir(repoPath, path, linkText);
  if (!gitDir) throw new RunnerError('worktree の gitDir を確認できません', 'GIT_LINK_TAMPERED', false);
  await writeFile(linkFile, linkText, 'utf8');
  await writeFile(baseFile, baseSha, 'utf8');
  return { path, branch, baseSha, gitDir };
}

function gitLinkTampered() {
  return new RunnerError('作業ツリーの .git が書き換えられたため中止しました', 'GIT_LINK_TAMPERED', false);
}

/**
 * 記録した `.git` の中身（`gitdir: <path>`）から gitDir を決める。
 * 元リポジトリの `<共通 git dir>/worktrees/` の直下を指していなければ null（信用しない）。
 */
async function trustedGitDir(repoPath: string, worktreePath: string, linkText: string): Promise<string | null> {
  const m = /^gitdir: (.+)\n?$/.exec(linkText);
  if (!m) return null;
  const dir = resolve(worktreePath, m[1].trim());
  if (!existsSync(dir)) return null;
  const common = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoPath, timeoutMs: 10_000 });
  if (common.code !== 0) return null;
  const root = realpathSync(join(common.stdout.trim(), 'worktrees'));
  const real = realpathSync(dir);
  return dirname(real) === root ? real : null;
}

/**
 * AI の工程の後に呼ぶ。作業ツリーの `.git` ファイルが作成時の中身と違えば、
 * 以降の git 操作（フック・設定の読み込み）が別の場所に向けられ得るため中止する。
 */
export async function assertGitLink(wt: Worktree): Promise<void> {
  const expected = existsSync(`${wt.path}.gitlink`) ? await readFile(`${wt.path}.gitlink`, 'utf8') : null;
  const actual = await readFile(join(wt.path, '.git'), 'utf8').catch(() => null);
  if (expected === null || actual !== expected) {
    throw gitLinkTampered();
  }
}

/**
 * worktree を片付ける。コミットのあるブランチは人がレビュー・マージするため残し、
 * 何も変更しなかったブランチは削除する。
 */
export async function removeWorktree(repoPath: string, worktreePath: string, branch: string) {
  const baseFile = `${worktreePath}.base`;
  const baseSha = existsSync(baseFile) ? (await readFile(baseFile, 'utf8')).trim() : null;
  if (existsSync(worktreePath)) await run('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath, timeoutMs: 60_000 });
  await run('git', ['worktree', 'prune'], { cwd: repoPath, timeoutMs: 30_000 });
  if (baseSha) {
    const count = await run('git', ['rev-list', '--count', `${baseSha}..refs/heads/${branch}`], { cwd: repoPath, timeoutMs: 30_000 });
    if (count.code === 0 && count.stdout.trim() === '0') await run('git', ['branch', '-D', branch], { cwd: repoPath, timeoutMs: 30_000 });
  }
  await rm(baseFile, { force: true });
  await rm(`${worktreePath}.gitlink`, { force: true });
}

export async function listFiles(worktree: string): Promise<string[]> {
  const out = await git(worktree, ['ls-files', '--cached', '--others', '--exclude-standard']);
  return out.split('\n').filter(Boolean);
}

export async function grep(worktree: string, query: string): Promise<string> {
  const r = await run('git', ['grep', '-n', '-I', '--fixed-strings', '-e', query, '--', '.'], { cwd: worktree, timeoutMs: 30_000 });
  return r.stdout;
}

/** 変更をコミットする。変更が無ければ null */
export async function commitAll(worktree: Worktree | string, message: string): Promise<string | null> {
  await wtGit(worktree, ['add', '-A']);
  const status = await wtGit(worktree, ['status', '--porcelain']);
  if (!status.trim()) return null;
  await wtGit(worktree, ['-c', 'user.name=Personal AI Workspace', '-c', 'user.email=agent@localhost', 'commit', '--no-verify', '-q', '-m', message]);
  return (await wtGit(worktree, ['rev-parse', 'HEAD'])).trim();
}

/**
 * 作業ツリーで変更・追加・削除されたパス（コミット前）。リネームは新旧両方を返す。
 * Developer が外部プロセス（Claude Code）でファイルを編集した後の検証に使う。
 */
export async function changedPaths(worktree: Worktree | string): Promise<string[]> {
  const out = await wtGit(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  const entries = out.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const xy = e.slice(0, 2);
    paths.push(e.slice(3));
    // --no-renames でも念のため: R/C の次の要素は元のパス
    if (xy.includes('R') || xy.includes('C')) paths.push(entries[++i] ?? '');
  }
  return paths.filter(Boolean);
}

/** コミットされていない変更をすべて破棄する（禁止パスの変更を検出したとき用） */
export async function discardChanges(worktree: Worktree | string) {
  await wtGit(worktree, ['reset', '--hard', '-q', 'HEAD']);
  await wtGit(worktree, ['clean', '-fdq']);
}

export async function headSha(worktree: Worktree | string): Promise<string> {
  return (await wtGit(worktree, ['rev-parse', 'HEAD'])).trim();
}

export async function diffFromBase(worktree: Worktree | string, baseSha: string): Promise<{ patch: string; files: { path: string; additions: number; deletions: number }[] }> {
  const patch = await wtGit(worktree, ['diff', '--no-color', `${baseSha}..HEAD`]);
  const numstat = await wtGit(worktree, ['diff', '--numstat', `${baseSha}..HEAD`]);
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...p] = l.split('\t');
      return { path: p.join('\t'), additions: Number(a) || 0, deletions: Number(d) || 0 };
    });
  return { patch, files };
}

/**
 * .claude/ は Claude Code の設定（hooks・権限）を置く場所。AI に書き換えさせると、後続の工程や
 * 利用者自身の Claude Code セッションでコードが実行され得るため変更させない。
 */
const DENY_SEGMENTS = new Set(['.git', 'node_modules', '.husky', '.circleci', '.claude']);
/** CI・git フックなど、変更すると利用者の環境やパイプラインでコードが実行される場所 */
const DENY_PREFIXES = ['.github/workflows/', '.gitlab-ci.yml', '.githooks/', '.pre-commit-config.yaml', 'lefthook.yml'];
const DENY_FILES = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|\.npmrc|\.netrc|credentials(\.json)?)$/i;
/** AI への指示・接続先として読み込まれるファイル（プロンプトインジェクションの持続化を防ぐ） */
const DENY_AGENT_FILES = /(^|\/)(CLAUDE(\.local)?\.md|\.mcp\.json)$/;

/**
 * Claude Code に渡す権限ルール（gitignore 形式。上の confine() と同じ範囲を表す）。
 * CLI 側の拒否は早めに止めるためのもので、最終的な判定は実行後の changedPaths() + confine() で行う。
 */
export const CLAUDE_CODE_DENY_RULES = [
  'Edit(.git/**)',
  'Edit(node_modules/**)',
  'Edit(.husky/**)',
  'Edit(.circleci/**)',
  'Edit(.claude/**)',
  'Edit(.github/workflows/**)',
  'Edit(.gitlab-ci.yml)',
  'Edit(.githooks/**)',
  'Edit(.pre-commit-config.yaml)',
  'Edit(lefthook.yml)',
  'Edit(CLAUDE.md)',
  'Edit(CLAUDE.local.md)',
  'Edit(.mcp.json)',
  'Read(.env)',
  'Read(.env.*)',
  'Read(*.pem)',
  'Read(*.key)',
  'Read(id_rsa*)',
  'Read(id_ed25519*)',
  'Read(.npmrc)',
  'Read(.netrc)',
  'Read(credentials)',
  'Read(credentials.json)',
];

/**
 * モデルが指定したパス（非信頼）を worktree 内に限定する。
 * `..`・絶対パス・.git・秘密値らしいファイル・worktree 外を指すシンボリックリンクを拒否する。
 */
export function confine(worktree: string, rel: string): { ok: true; abs: string; rel: string } | { ok: false; reason: string } {
  if (!rel || rel.includes('\0')) return { ok: false, reason: 'パスが空です' };
  if (isAbsolute(rel)) return { ok: false, reason: '絶対パスは使えません（リポジトリからの相対パスで指定）' };
  const abs = resolve(worktree, rel);
  const r = relative(worktree, abs);
  if (!r || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) return { ok: false, reason: 'リポジトリの外は操作できません' };
  const norm = r.split(sep).join('/');
  if (norm.split('/').some((seg) => DENY_SEGMENTS.has(seg))) return { ok: false, reason: '.git / node_modules / .claude などは操作できません' };
  if (DENY_FILES.test(norm)) return { ok: false, reason: '秘密情報を含む可能性のあるファイルは操作できません' };
  if (DENY_PREFIXES.some((p) => norm === p || norm.startsWith(p))) return { ok: false, reason: 'CI 設定・git フックは変更できません' };
  if (DENY_AGENT_FILES.test(norm)) return { ok: false, reason: 'AI エージェントの設定ファイル（CLAUDE.md / .mcp.json）は変更できません' };
  // 既存部分のシンボリックリンクが worktree 外を指していないか確認
  let probe = abs;
  while (!existsSync(probe) && probe !== worktree) probe = resolve(probe, '..');
  const realProbe = realpathSync(probe);
  const realRoot = realpathSync(worktree);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) return { ok: false, reason: 'リポジトリの外を指すリンクは操作できません' };
  return { ok: true, abs, rel: norm };
}
