/**
 * Tester（AI が書き換えたリポジトリのコードを動かす工程）の実行場所。
 *
 *  - DockerSandbox: Run の worktree だけを見えるようにした使い捨てコンテナで実行する（サーバーモードの既定）。
 *    管理クローン・worktreesDir・git の共通ディレクトリ・/etc/paw/paw.env・GitHub App の鍵・Claude のログインは
 *    マウントも環境変数渡しもしない。テストコードが push 先を書き換えたり秘密を読んだりできないようにするため。
 *  - HostSandbox: ホストでそのまま実行する（ローカル利用の既定。秘密は safeEnv で除く）。
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { RunnerError } from '../runner';
import { run, safeEnv } from './git';

export interface SandboxResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

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
  /**
   * 前のプロセスが残したコンテナ（名前が paw-test- で始まるもの）をすべて消す。起動時、エンジンを動かす前に呼ぶ。
   * 再起動・更新で止めきれなかったコンテナが、次の試行と同じ worktree を書き換え続けないようにするため
   */
  removeAllContainers?(): Promise<string[]>;
  /** その Run のコンテナ（paw-test-<runId>-）をすべて消す。Run の終わりの片付けで呼ぶ */
  removeRunContainers?(runId: string): Promise<string[]>;
}

/** コンテナ名の先頭（すべての Tester のコンテナに共通） */
export const CONTAINER_PREFIX = 'paw-test-';

/** その Run のコンテナ名の先頭。runId の後ろに - を付け、別の Run（run_a と run_ab）を巻き込まない */
export function runContainerPrefix(runId: string): string {
  return `${CONTAINER_PREFIX}${runId.replace(/[^A-Za-z0-9_.-]/g, '_')}-`;
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
  /**
   * docker の実行。テストで差し替える。未指定なら実際の docker CLI。
   * docker コマンド自体を起動できないとき（ENOENT など）は errno 付きの Error を reject する。
   */
  spawnDocker?: (args: string[], opts: { timeoutMs: number }) => Promise<SandboxResult>;
  /** コンテナの資源上限（既定: pids 512・メモリ 4g・CPU 2） */
  limits?: { pids?: number; memory?: string; cpus?: string };
}

/** docker CLI に通す環境変数（接続先の指定。秘密は含まない） */
const DOCKER_CLI_ENV = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR'];

const defaultSpawnDocker: NonNullable<DockerSandboxOptions['spawnDocker']> = (args, opts) =>
  new Promise((resolvePromise, reject) => {
    const env = safeEnv();
    for (const k of DOCKER_CLI_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    execFile('docker', args, { timeout: opts.timeoutMs, maxBuffer: 20 * 1024 * 1024, env, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      // コマンドを起動できなかった（errno が文字列 = ENOENT / EACCES など）は結果ではなく例外で返す
      if (e && typeof e.code === 'string') return reject(e);
      resolvePromise({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: Boolean(e?.killed) });
    });
  });

/** イメージ参照の形（先頭が - だと docker のオプションとして解釈されるため、英数字始まりに限る） */
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,254}$/;

export function assertImageRef(image: string): void {
  if (!IMAGE_REF.test(image)) throw new RunnerError(`テスト用のイメージ名が正しくありません: ${image.slice(0, 80)}`, 'TEST_IMAGE_INVALID', false);
}

/** コンテナに渡す環境変数（CI・HOME・ロケール・端末だけ。PATH などホストの値は渡さない） */
function containerEnv(): string[] {
  const env = safeEnv({ CI: '1' });
  const out = ['--env', 'CI=1', '--env', 'HOME=/tmp'];
  for (const k of ['LANG', 'LC_ALL', 'TERM']) {
    const v = env[k];
    if (v !== undefined) out.push('--env', `${k}=${v}`);
  }
  return out;
}

const unavailable = (msg: string) => new RunnerError(msg, 'TEST_SANDBOX_UNAVAILABLE', false);

export class DockerSandbox implements TestSandbox {
  private readonly spawnDocker: NonNullable<DockerSandboxOptions['spawnDocker']>;

  constructor(private readonly opts: DockerSandboxOptions) {
    // 既定イメージ（PAW_TEST_IMAGE）の不正は起動時に気づけるようにする
    assertImageRef(opts.defaultImage);
    this.spawnDocker = opts.spawnDocker ?? defaultSpawnDocker;
  }

  async exec(cmd: string, args: string[], o: TestSandboxExecOptions): Promise<SandboxResult> {
    // 中止済みなら、コンテナを作らない
    if (o.signal.aborted) return { code: 130, stdout: '', stderr: '中止されました', timedOut: false };
    const image = o.image ?? this.opts.defaultImage;
    assertImageRef(image);
    // --mount の値はカンマ区切りなので、これらを含むパスはオプションの差し込みになり得る
    if (/[,"\n\r]/.test(o.worktree)) throw unavailable('worktree のパスに使えない文字が含まれているため、コンテナを起動しません');
    // 前回の残りと名前が衝突しないよう、ランダムな接尾辞を付ける
    const name = `${runContainerPrefix(o.runId)}${o.attempt}-${randomBytes(4).toString('hex')}`;
    // API プロセスと同じ uid:gid で動かし、worktree に書いたファイルの所有者を API ユーザーのままにする
    const user = typeof process.getuid === 'function' && typeof process.getgid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
    const lim = this.opts.limits ?? {};
    const dockerArgs = [
      'run',
      '--rm',
      '--init', // PID 1 が SIGTERM を無視する node でも、止められるようにする
      '--name', name,
      '--network', this.opts.network,
      '--mount', `type=bind,source=${o.worktree},target=/work`,
      '--tmpfs', '/tmp:rw,exec,nosuid,size=1g',
      '-w', '/work',
      ...user,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      `--pids-limit=${lim.pids ?? 512}`,
      `--memory=${lim.memory ?? '4g'}`,
      `--cpus=${lim.cpus ?? '2'}`,
      ...containerEnv(),
      image,
      cmd,
      ...args,
    ];

    // docker CLI を殺してもコンテナは残るため、コンテナ名で強制削除する（SIGKILL）
    const remove = () => this.removeContainer(name);
    const onAbort = () => void remove();
    o.signal.addEventListener('abort', onAbort, { once: true });
    let normal = false;
    try {
      let r: SandboxResult;
      try {
        r = await this.spawnDocker(dockerArgs, { timeoutMs: o.timeoutMs });
      } catch (err) {
        throw unavailable(`Docker を実行できません（テストを安全に動かせないため中止します）: ${(err as Error).message}`);
      }
      // 125 = docker 自体の失敗。テスト側が exit 125 を返した場合と区別するため、stdout が空で stderr が docker のメッセージのときだけ扱う
      if (r.code === 125 && !r.timedOut && r.stdout === '' && r.stderr.startsWith('docker: ')) {
        throw unavailable(`Docker でテストを起動できませんでした: ${r.stderr.trim().slice(-500)}`);
      }
      normal = !r.timedOut && !o.signal.aborted;
      return r;
    } finally {
      o.signal.removeEventListener('abort', onAbort);
      // 正常終了なら --rm で消えている。それ以外（タイムアウト・中止・起動失敗）は残りを確実に消す
      if (!normal) await remove();
    }
  }

  async removeAllContainers(): Promise<string[]> {
    return this.removeByPrefix(CONTAINER_PREFIX);
  }

  async removeRunContainers(runId: string): Promise<string[]> {
    return this.removeByPrefix(runContainerPrefix(runId));
  }

  /** 名前が prefix で始まるコンテナを（止まっているものも含めて）強制削除し、消した名前を返す */
  private async removeByPrefix(prefix: string): Promise<string[]> {
    let r: SandboxResult;
    try {
      // name フィルタは部分一致なので、先頭一致は結果の側で確かめる
      r = await this.spawnDocker(['ps', '-a', '--filter', `name=${prefix}`, '--format', '{{.Names}}'], { timeoutMs: 30_000 });
    } catch (err) {
      throw unavailable(`Docker のコンテナ一覧を取得できません: ${(err as Error).message}`);
    }
    if (r.code !== 0) throw unavailable(`Docker のコンテナ一覧を取得できません: ${r.stderr.trim().slice(-300)}`);
    const names = r.stdout
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n.startsWith(prefix));
    for (const n of names) await this.removeContainer(n);
    return names;
  }

  private async removeContainer(name: string): Promise<void> {
    for (let i = 0; i < 2; i++) {
      const r = await this.spawnDocker(['rm', '-f', name], { timeoutMs: 15_000 }).catch(() => null);
      if (r && (r.code === 0 || /No such container/i.test(r.stderr))) return;
      await new Promise((res) => setTimeout(res, 300));
    }
  }
}
