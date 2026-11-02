import { afterEach, describe, expect, it } from 'vitest';
import { DockerSandbox, HostSandbox, type DockerResult } from './agents/claude/testSandbox';

const ok: DockerResult = { code: 0, stdout: 'ok', stderr: '', timedOut: false };
const base = { worktree: '/var/lib/paw/worktrees/run_a', timeoutMs: 1000, image: null, runId: 'run_a', attempt: 1 };

afterEach(() => {
  delete process.env.PAW_SESSION_SECRET;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

describe('DockerSandbox', () => {
  it('worktree だけをマウントし、秘密の環境変数を渡さない', async () => {
    process.env.PAW_SESSION_SECRET = 'x';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'y';
    const calls: string[][] = [];
    const sb = new DockerSandbox({ network: 'paw-test', defaultImage: 'node:22-bookworm', spawnDocker: async (args) => { calls.push(args); return ok; } });
    await sb.exec('pnpm', ['test'], { ...base, signal: new AbortController().signal });
    const a = calls[0];
    expect(a.filter((x) => x === '-v')).toHaveLength(1);
    expect(a[a.indexOf('-v') + 1]).toBe('/var/lib/paw/worktrees/run_a:/work');
    expect(a[a.indexOf('--network') + 1]).toBe('paw-test');
    expect(a[a.indexOf('--name') + 1]).toBe('paw-test-run_a-1');
    expect(a).toContain('--rm');
    expect(a.join(' ')).not.toMatch(/SECRET|TOKEN|OAUTH/);
    expect(a.slice(-3)).toEqual(['node:22-bookworm', 'pnpm', 'test']);
  });

  it('Repo 別のイメージを優先する', async () => {
    const calls: string[][] = [];
    const sb = new DockerSandbox({ network: 'n', defaultImage: 'node:22-bookworm', spawnDocker: async (args) => { calls.push(args); return ok; } });
    await sb.exec('make', [], { ...base, image: 'python:3.13', signal: new AbortController().signal });
    expect(calls[0].slice(-2)).toEqual(['python:3.13', 'make']);
  });

  it('Docker が無いと TEST_SANDBOX_UNAVAILABLE で失敗する', async () => {
    const sb = new DockerSandbox({
      network: 'n',
      defaultImage: 'i',
      spawnDocker: async () => {
        throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
      },
    });
    await expect(sb.exec('pnpm', ['test'], { ...base, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'TEST_SANDBOX_UNAVAILABLE' });
  });

  it('docker が起動できず exit 125 なら TEST_SANDBOX_UNAVAILABLE で失敗する', async () => {
    const sb = new DockerSandbox({ network: 'n', defaultImage: 'i', spawnDocker: async () => ({ code: 125, stdout: '', stderr: 'Cannot connect to the Docker daemon', timedOut: false }) });
    await expect(sb.exec('pnpm', ['test'], { ...base, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'TEST_SANDBOX_UNAVAILABLE' });
  });

  it('中止すると docker kill でコンテナを止める', async () => {
    const calls: string[][] = [];
    const ac = new AbortController();
    const sb = new DockerSandbox({
      network: 'n',
      defaultImage: 'i',
      spawnDocker: async (args) => {
        calls.push(args);
        if (args[0] === 'run') {
          ac.abort();
          await new Promise((r) => setTimeout(r, 10));
          return { code: 137, stdout: '', stderr: '', timedOut: false };
        }
        return ok;
      },
    });
    await sb.exec('pnpm', ['test'], { ...base, signal: ac.signal });
    expect(calls.some((c) => c[0] === 'kill' && c[1] === 'paw-test-run_a-1')).toBe(true);
  });
});

describe('HostSandbox', () => {
  it('ホストでそのまま実行する', async () => {
    const r = await new HostSandbox().exec('node', ['-e', 'console.log(1)'], { ...base, worktree: process.cwd(), signal: new AbortController().signal });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('1');
  });
});
