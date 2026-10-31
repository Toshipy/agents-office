/**
 * ローカル git リポジトリの操作（Run ごとの隔離 worktree）。
 * すべて execFile（シェルを介さない）で実行し、子プロセスには秘密値を含む環境変数を渡さない。
 */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
}

/** Run 用の worktree を作る（既にあれば再利用）。ブランチは ai/ で始まる専用ブランチ */
export async function ensureWorktree(repoPath: string, worktreesDir: string, runId: string, branch: string, signal?: AbortSignal): Promise<Worktree> {
  const path = resolve(worktreesDir, runId);
  const baseFile = `${path}.base`;
  if (existsSync(path) && existsSync(baseFile)) {
    return { path, branch, baseSha: (await readFile(baseFile, 'utf8')).trim() };
  }
  await mkdir(worktreesDir, { recursive: true });
  const baseSha = (await git(repoPath, ['rev-parse', 'HEAD'], signal)).trim();
  const exists = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath });
  if (exists.code === 0) await git(repoPath, ['worktree', 'add', path, branch], signal);
  else await git(repoPath, ['worktree', 'add', '-b', branch, path, baseSha], signal);
  await writeFile(baseFile, baseSha, 'utf8');
  return { path, branch, baseSha };
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
export async function commitAll(worktree: string, message: string): Promise<string | null> {
  await git(worktree, ['add', '-A']);
  const status = await git(worktree, ['status', '--porcelain']);
  if (!status.trim()) return null;
  await git(worktree, ['-c', 'user.name=Personal AI Workspace', '-c', 'user.email=agent@localhost', 'commit', '--no-verify', '-q', '-m', message]);
  return (await git(worktree, ['rev-parse', 'HEAD'])).trim();
}

export async function headSha(worktree: string): Promise<string> {
  return (await git(worktree, ['rev-parse', 'HEAD'])).trim();
}

export async function diffFromBase(worktree: string, baseSha: string): Promise<{ patch: string; files: { path: string; additions: number; deletions: number }[] }> {
  const patch = await git(worktree, ['diff', '--no-color', `${baseSha}..HEAD`]);
  const numstat = await git(worktree, ['diff', '--numstat', `${baseSha}..HEAD`]);
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...p] = l.split('\t');
      return { path: p.join('\t'), additions: Number(a) || 0, deletions: Number(d) || 0 };
    });
  return { patch, files };
}

const DENY_SEGMENTS = new Set(['.git', 'node_modules', '.husky', '.circleci']);
/** CI・git フックなど、変更すると利用者の環境やパイプラインでコードが実行される場所 */
const DENY_PREFIXES = ['.github/workflows/', '.gitlab-ci.yml', '.githooks/', '.pre-commit-config.yaml', 'lefthook.yml'];
const DENY_FILES = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|\.npmrc|\.netrc|credentials(\.json)?)$/i;

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
  if (norm.split('/').some((seg) => DENY_SEGMENTS.has(seg))) return { ok: false, reason: '.git / node_modules は操作できません' };
  if (DENY_FILES.test(norm)) return { ok: false, reason: '秘密情報を含む可能性のあるファイルは操作できません' };
  if (DENY_PREFIXES.some((p) => norm === p || norm.startsWith(p))) return { ok: false, reason: 'CI 設定・git フックは変更できません' };
  // 既存部分のシンボリックリンクが worktree 外を指していないか確認
  let probe = abs;
  while (!existsSync(probe) && probe !== worktree) probe = resolve(probe, '..');
  const realProbe = realpathSync(probe);
  const realRoot = realpathSync(worktree);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) return { ok: false, reason: 'リポジトリの外を指すリンクは操作できません' };
  return { ok: true, abs, rel: norm };
}
