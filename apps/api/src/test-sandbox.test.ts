import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSandbox, HostSandbox, type SandboxResult } from './agents/claude/testSandbox';

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
