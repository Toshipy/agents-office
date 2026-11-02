/**
 * Tester（AI が書き換えたリポジトリのコードを動かす工程）の実行場所。
 *
 *  - DockerSandbox: Run の worktree だけを見えるようにした使い捨てコンテナで実行する（サーバーモードの既定）。
 *    管理クローン・worktreesDir・git の共通ディレクトリ・/etc/paw/paw.env・GitHub App の鍵・Claude のログインは
 *    マウントも環境変数渡しもしない。テストコードが push 先を書き換えたり秘密を読んだりできないようにするため。
 *  - HostSandbox: ホストでそのまま実行する（ローカル利用の既定。秘密は safeEnv で除く）。
 */
import { RunnerError } from '../runner';
import { run, safeEnv } from './git';

export interface SandboxResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type DockerResult = SandboxResult;

export interface TestSandboxExecOptions {
  /** Run の worktree の絶対パス（コンテナには、ここだけをマウントする） */
  worktree: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Repo 別のイメージ。null なら既定のイメージ */
  image: string | null;
  /** コンテナ名 paw-test-<runId>-<attempt> に使う（中止時の docker kill 用） */
  runId: string;
  attempt: number;
}

export interface TestSandbox {
  exec(cmd: string, args: string[], opts: TestSandboxExecOptions): Promise<SandboxResult>;
}

export class HostSandbox implements TestSandbox {
  exec(cmd: string, args: string[], opts: TestSandboxExecOptions): Promise<SandboxResult> {
    return run(cmd, args, { cwd: opts.worktree, timeoutMs: opts.timeoutMs, signal: opts.signal, env: safeEnv({ CI: '1' }) });
  }
}

export interface DockerSandboxOptions {
  /** コンテナを繋ぐ docker ネットワーク（PAW_TEST_NETWORK） */
  network: string;
  defaultImage: string;
  /** docker の実行。テストで差し替える。未指定なら実際の docker CLI */
  spawnDocker?: (args: string[], opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<SandboxResult>;
}

const defaultSpawnDocker: NonNullable<DockerSandboxOptions['spawnDocker']> = (args, opts) =>
  run('docker', args, { cwd: process.cwd(), timeoutMs: opts.timeoutMs, signal: opts.signal, env: safeEnv() });

/** コンテナに渡す環境変数（CI と、ロケール・端末だけ。PATH や HOME などホストの値は渡さない） */
function containerEnv(): string[] {
  const env = safeEnv({ CI: '1' });
  const out: string[] = [];
  for (const k of ['CI', 'LANG', 'LC_ALL', 'TERM']) {
    const v = env[k];
    if (v !== undefined) out.push('--env', `${k}=${v}`);
  }
  return out;
}

export class DockerSandbox implements TestSandbox {
  private readonly spawnDocker: NonNullable<DockerSandboxOptions['spawnDocker']>;

  constructor(private readonly opts: DockerSandboxOptions) {
    this.spawnDocker = opts.spawnDocker ?? defaultSpawnDocker;
  }

  async exec(cmd: string, args: string[], o: TestSandboxExecOptions): Promise<SandboxResult> {
    const name = `paw-test-${o.runId}-${o.attempt}`;
    const image = o.image ?? this.opts.defaultImage;
    // API プロセスと同じ uid:gid で動かし、worktree に書いたファイルの所有者を API ユーザーのままにする
    const user = typeof process.getuid === 'function' && typeof process.getgid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
    const dockerArgs = [
      'run',
      '--rm',
      '--name', name,
      '--network', this.opts.network,
      '-v', `${o.worktree}:/work`,
      '-w', '/work',
      ...user,
      ...containerEnv(),
      image,
      cmd,
      ...args,
    ];

    const kill = () => this.spawnDocker(['kill', name], { timeoutMs: 10_000 }).catch(() => undefined);
    const onAbort = () => void kill();
    // docker CLI を殺してもコンテナは残るため、中止はコンテナ名で止める
    if (o.signal.aborted) onAbort();
    o.signal.addEventListener('abort', onAbort, { once: true });
    let r: SandboxResult;
    try {
      // signal は run に渡さない（CLI だけ先に死ぬと、コンテナの終了を待てない）。止めるのは docker kill
      r = await this.spawnDocker(dockerArgs, { timeoutMs: o.timeoutMs });
    } catch (err) {
      throw new RunnerError(`Docker を実行できません（テストを安全に動かせないため中止します）: ${(err as Error).message}`, 'TEST_SANDBOX_UNAVAILABLE', false);
    } finally {
      o.signal.removeEventListener('abort', onAbort);
    }
    if (r.timedOut) await kill();
    // 125 = docker 自体の失敗（デーモン未起動・イメージ取得不可・オプション不正）。テストの失敗とは区別する
    // run() は spawn 失敗（docker コマンドが無い）を例外にせず stderr に残すため、そこも拾う
    const spawnFailed = /^(ENOENT|EACCES): /m.test(r.stderr);
    if ((r.code === 125 || spawnFailed) && !r.timedOut) {
      throw new RunnerError(`Docker でテストを起動できませんでした: ${r.stderr.trim().slice(-500)}`, 'TEST_SANDBOX_UNAVAILABLE', false);
    }
    return r;
  }
}
