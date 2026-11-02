import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSandbox, HostSandbox, type SandboxResult, type TestSandbox } from './agents/claude/testSandbox';
import { loadConfig } from './config';
import { createApp, createServices, startServices } from './app';
import { repositoryBindings, workspaces } from './db/schema';

const ok: SandboxResult = { code: 0, stdout: 'ok', stderr: '', timedOut: false };
const base = { worktree: '/var/lib/paw/worktrees/run_a', timeoutMs: 1000, image: null, runId: 'run_a', attempt: 1 };
const sig = () => new AbortController().signal;

afterEach(() => {
  delete process.env.PAW_SESSION_SECRET;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

function sandbox(spawn: (args: string[]) => Promise<SandboxResult>, defaultImage = 'node:22-bookworm') {
  return new DockerSandbox({ network: 'paw-test', defaultImage, spawnDocker: async (args) => spawn(args) });
}

describe('DockerSandbox', () => {
  it('worktree だけをマウントし、秘密の環境変数を渡さない', async () => {
    process.env.PAW_SESSION_SECRET = 'x';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'y';
    const calls: string[][] = [];
    await sandbox(async (a) => (calls.push(a), ok)).exec('pnpm', ['test'], { ...base, signal: sig() });
    const a = calls[0];
    expect(a.filter((x) => x === '-v' || x === '--mount')).toEqual(['--mount']);
    expect(a[a.indexOf('--mount') + 1]).toBe('type=bind,source=/var/lib/paw/worktrees/run_a,target=/work');
    expect(a[a.indexOf('--network') + 1]).toBe('paw-test');
    expect(a[a.indexOf('--name') + 1]).toMatch(/^paw-test-run_a-1-[0-9a-f]{8}$/);
    expect(a).toContain('--rm');
    expect(a).toContain('--init');
    expect(a).toContain('--cap-drop=ALL');
    expect(a).toContain('--security-opt=no-new-privileges');
    expect(a.some((x) => x.startsWith('--pids-limit='))).toBe(true);
    expect(a).toContain('HOME=/tmp');
    expect(a.join(' ')).not.toMatch(/SECRET|TOKEN|OAUTH/);
    expect(a.slice(-3)).toEqual(['node:22-bookworm', 'pnpm', 'test']);
  });

  it('同じ Run・試行でも名前は毎回変わる', async () => {
    const names: string[] = [];
    const sb = sandbox(async (a) => (names.push(a[a.indexOf('--name') + 1]), ok));
    await sb.exec('x', [], { ...base, signal: sig() });
    await sb.exec('x', [], { ...base, signal: sig() });
    expect(names[0]).not.toBe(names[1]);
  });

  it('Repo 別のイメージを優先する', async () => {
    const calls: string[][] = [];
    await sandbox(async (a) => (calls.push(a), ok)).exec('make', [], { ...base, image: 'python:3.13', signal: sig() });
    expect(calls[0].slice(-2)).toEqual(['python:3.13', 'make']);
  });

  it('- で始まるイメージ名は拒む（docker のオプションになるため）', async () => {
    const calls: string[][] = [];
    const sb = sandbox(async (a) => (calls.push(a), ok));
    await expect(sb.exec('x', [], { ...base, image: '--privileged', signal: sig() })).rejects.toMatchObject({ code: 'TEST_IMAGE_INVALID' });
    expect(calls).toHaveLength(0);
    expect(() => sandbox(async () => ok, '-v')).toThrow();
  });

  it('カンマを含む worktree パスは拒む', async () => {
    const sb = sandbox(async () => ok);
    await expect(sb.exec('x', [], { ...base, worktree: '/a,source=/etc', signal: sig() })).rejects.toMatchObject({ code: 'TEST_SANDBOX_UNAVAILABLE' });
  });

  it('Docker コマンドが無い（errno 付きの例外）と TEST_SANDBOX_UNAVAILABLE で失敗する', async () => {
    const sb = sandbox(async () => {
      throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    });
    await expect(sb.exec('pnpm', ['test'], { ...base, signal: sig() })).rejects.toMatchObject({ code: 'TEST_SANDBOX_UNAVAILABLE' });
  });

  it('docker 自身の失敗（exit 125・stdout 空・docker: で始まる stderr）は TEST_SANDBOX_UNAVAILABLE', async () => {
    const sb = sandbox(async (a) => (a[0] === 'run' ? { code: 125, stdout: '', stderr: 'docker: Cannot connect to the Docker daemon', timedOut: false } : ok));
    await expect(sb.exec('pnpm', ['test'], { ...base, signal: sig() })).rejects.toMatchObject({ code: 'TEST_SANDBOX_UNAVAILABLE' });
  });

  it('テスト自身の exit 125 や EACCES: を含む出力は、テストの失敗として返す', async () => {
    const r1 = await sandbox(async () => ({ code: 125, stdout: 'x', stderr: 'boom', timedOut: false })).exec('t', [], { ...base, signal: sig() });
    expect(r1.code).toBe(125);
    const r2 = await sandbox(async () => ({ code: 1, stdout: '', stderr: 'EACCES: permission denied, open', timedOut: false })).exec('t', [], { ...base, signal: sig() });
    expect(r2.code).toBe(1);
  });

  it('中止済みなら docker を呼ばない', async () => {
    const calls: string[][] = [];
    const ac = new AbortController();
    ac.abort();
    await sandbox(async (a) => (calls.push(a), ok)).exec('t', [], { ...base, signal: ac.signal });
    expect(calls).toHaveLength(0);
  });

  it('実行中に中止すると docker rm -f でコンテナを消す', async () => {
    const calls: string[][] = [];
    const ac = new AbortController();
    const sb = sandbox(async (a) => {
      calls.push(a);
      if (a[0] === 'run') {
        ac.abort();
        await new Promise((r) => setTimeout(r, 10));
        return { code: 137, stdout: '', stderr: '', timedOut: false };
      }
      return ok;
    });
    await sb.exec('t', [], { ...base, signal: ac.signal });
    const name = calls[0][calls[0].indexOf('--name') + 1];
    expect(calls.some((c) => c[0] === 'rm' && c[1] === '-f' && c[2] === name)).toBe(true);
  });

  it('タイムアウトでもコンテナを消す。正常終了では消す操作をしない', async () => {
    const calls: string[][] = [];
    await sandbox(async (a) => (calls.push(a), a[0] === 'run' ? { code: 137, stdout: '', stderr: '', timedOut: true } : ok)).exec('t', [], { ...base, signal: sig() });
    expect(calls.filter((c) => c[0] === 'rm')).toHaveLength(1);
    const calls2: string[][] = [];
    await sandbox(async (a) => (calls2.push(a), ok)).exec('t', [], { ...base, signal: sig() });
    expect(calls2.filter((c) => c[0] === 'rm')).toHaveLength(0);
  });

  it('rm -f が失敗したら 1 回だけ再試行する', async () => {
    const calls: string[][] = [];
    await sandbox(async (a) => {
      calls.push(a);
      if (a[0] === 'run') return { code: 137, stdout: '', stderr: '', timedOut: true };
      return { code: 1, stdout: '', stderr: 'daemon busy', timedOut: false };
    }).exec('t', [], { ...base, signal: sig() });
    expect(calls.filter((c) => c[0] === 'rm')).toHaveLength(2);
  });
});

describe('残ったコンテナの片付け', () => {
  /** docker ps -a の結果を返し、rm -f の対象を記録する偽の docker */
  function withContainers(names: string[]) {
    const calls: string[][] = [];
    const sb = sandbox(async (a) => {
      calls.push(a);
      if (a[0] === 'ps') return { code: 0, stdout: `${names.join('\n')}\n`, stderr: '', timedOut: false };
      return ok;
    });
    const removed = () => calls.filter((c) => c[0] === 'rm').map((c) => c[2]);
    return { sb, calls, removed };
  }

  it('起動時は paw-test- で始まるコンテナをすべて消し、他のコンテナには触らない', async () => {
    const { sb, calls, removed } = withContainers(['paw-test-run_a-1-0a0b0c0d', 'paw-test-run_b-2-11223344', 'my-paw-test-db', 'postgres']);
    expect(await sb.removeAllContainers()).toEqual(['paw-test-run_a-1-0a0b0c0d', 'paw-test-run_b-2-11223344']);
    expect(calls[0]).toEqual(['ps', '-a', '--filter', 'name=paw-test-', '--format', '{{.Names}}']);
    expect(removed()).toEqual(['paw-test-run_a-1-0a0b0c0d', 'paw-test-run_b-2-11223344']);
  });

  it('Run の片付けではその Run のコンテナだけを消す（runId の前方一致で別の Run を巻き込まない）', async () => {
    const { sb, removed } = withContainers(['paw-test-run_a-1-0a0b0c0d', 'paw-test-run_a-3-99887766', 'paw-test-run_ab-1-55667788', 'paw-test-run_b-1-12345678']);
    await sb.removeRunContainers('run_a');
    expect(removed()).toEqual(['paw-test-run_a-1-0a0b0c0d', 'paw-test-run_a-3-99887766']);
  });

  it('docker を呼べなければ TEST_SANDBOX_UNAVAILABLE', async () => {
    const sb = sandbox(async () => {
      throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    });
    await expect(sb.removeAllContainers()).rejects.toMatchObject({ code: 'TEST_SANDBOX_UNAVAILABLE' });
  });

  /** 片付けの呼び出しを記録する偽の Tester の実行場所 */
  function fakeSandbox(order: string[]): TestSandbox & { removeAllContainers: ReturnType<typeof vi.fn>; removeRunContainers: ReturnType<typeof vi.fn> } {
    return {
      exec: async () => ok,
      removeAllContainers: vi.fn(async () => (order.push('removeAllContainers'), [])),
      removeRunContainers: vi.fn(async (runId: string) => (order.push(`removeRunContainers:${runId}`), [])),
    };
  }

  it('startServices はエンジンが Run を復旧する前に、残ったコンテナを消す', async () => {
    const order: string[] = [];
    const testSandbox = fakeSandbox(order);
    const s = await createServices(loadConfig({ dataDir: 'memory', simSpeed: 0, seedDemo: false, logLevel: 'silent' }), { testSandbox });
    const start = s.engine.start.bind(s.engine);
    vi.spyOn(s.engine, 'start').mockImplementation(async () => {
      order.push('engine.start');
      await start();
    });
    try {
      await startServices(s);
      expect(order).toEqual(['removeAllContainers', 'engine.start']);
    } finally {
      await s.poller?.stop();
      s.dispatcher.stop();
      s.seats.stop();
      await s.engine.stop();
      await s.client.close();
    }
  });

  it('Docker が使えなくても起動は止めない', async () => {
    const testSandbox = fakeSandbox([]);
    testSandbox.removeAllContainers.mockRejectedValueOnce(new Error('docker down'));
    const s = await createServices(loadConfig({ dataDir: 'memory', simSpeed: 0, seedDemo: false, logLevel: 'silent' }), { testSandbox });
    try {
      await expect(startServices(s)).resolves.toBeUndefined();
      expect(s.engine.inflightCount()).toBe(0);
    } finally {
      s.dispatcher.stop();
      s.seats.stop();
      await s.engine.stop();
      await s.client.close();
    }
  });

  it('Claude の Run が終わると、その Run のコンテナを消す', async () => {
    const order: string[] = [];
    const testSandbox = fakeSandbox(order);
    const s = await createServices(
      loadConfig({ dataDir: 'memory', simSpeed: 0, seedDemo: false, logLevel: 'silent', agentRuntimeMode: 'claude_code', agentRuntime: 'claude_code' }),
      { testSandbox },
    );
    try {
      const app = createApp(s);
      const headers = { 'content-type': 'application/json', 'x-paw-client': 'web' };
      const r = await app.request('/v1/auth/signup', { method: 'POST', headers, body: JSON.stringify({ username: 'owner', displayName: 'Owner', password: 'password-1234' }) });
      const cookie = r.headers.get('set-cookie')!.split(';')[0];
      const p = await app.request('/v1/projects', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ name: 'Demo', color: '#38e1ff' }) });
      const projectId = ((await p.json()) as { id: string }).id;
      const [ws] = await s.db.select().from(workspaces);
      const dir = mkdtempSync(join(tmpdir(), 'paw-sbx-run-'));
      await s.db.insert(repositoryBindings).values({
        id: 'rb_sbx',
        workspaceId: ws.id,
        projectId,
        installationId: 0,
        repositoryId: 1,
        fullName: 'local/sbx',
        automationEnabled: false,
        verification: 'simulated',
        localPath: dir,
        policy: { triggerLabel: 'agents-office', events: ['issues.labeled'], maxRevisionAttempts: 3 },
      } as typeof repositoryBindings.$inferInsert);
      const run = await s.engine.createRun({ workspaceId: ws.id, projectId, title: 't', request: 'r', source: { type: 'manual' } as never, maxRevisionAttempts: 3, budgetLimitUsd: 1, runtime: 'claude_code' });
      await s.engine.transition(run.id, 'planning');
      await s.engine.failRun(run.id, 'TEST_FAILURE', '失敗させた');
      for (let i = 0; i < 100 && testSandbox.removeRunContainers.mock.calls.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
      expect(order).toEqual([`removeRunContainers:${run.id}`]);
    } finally {
      await s.engine.stop();
      await s.client.close();
    }
  });
});

describe('HostSandbox', () => {
  it('ホストでそのまま実行する', async () => {
    const r = await new HostSandbox().exec('node', ['-e', 'console.log(1)'], { ...base, worktree: process.cwd(), signal: sig() });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('1');
  });
});

// 実際の docker で動かす（PAW_TEST_DOCKER=1 のときだけ。イメージの取得が走る）
describe.skipIf(process.env.PAW_TEST_DOCKER !== '1')('DockerSandbox（実 docker）', () => {
  it('worktree だけが見え、書き込みが戻り、秘密の環境変数は見えない', async () => {
    process.env.PAW_SESSION_SECRET = 'leak-me';
    const dir = mkdtempSync(join(tmpdir(), 'paw-sbx-'));
    writeFileSync(join(dir, 'hello.txt'), 'hi');
    const sb = new DockerSandbox({ network: 'none', defaultImage: 'node:22-bookworm-slim' });
    const script = "const fs=require('fs');fs.writeFileSync('out.txt',fs.readFileSync('hello.txt','utf8')+'!');console.log(JSON.stringify({sec:process.env.PAW_SESSION_SECRET??null,etcPaw:fs.existsSync('/etc/paw'),home:process.env.HOME,uid:process.getuid()}))";
    const r = await sb.exec('node', ['-e', script], { ...base, worktree: dir, timeoutMs: 180_000, signal: sig() });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ sec: null, etcPaw: false, home: '/tmp', uid: process.getuid?.() });
    expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('hi!');
  }, 240_000);
});
