/**
 * Claude Code（サブスク）実行基盤の検証。本物の `claude` は呼ばず、公式ドキュメントの出力形式
 * （--output-format stream-json の init / assistant / rate_limit_event / result）を再現する偽 CLI を使う。
 * 本物の CLI・サブスクでの動作（ログイン・利用上限の実際の出力）はこのテストでは確認できない。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { defaultClaudeCodeConfig, loadConfig } from './config';
import { createApp, createServices, type Services } from './app';
import { approvals, artifacts, runSteps, runs, usageRecords } from './db/schema';
import { ClaudeCodeBackend } from './agents/claude/cliBackend';
import { probeClaudeCode, resolveAgentRuntime } from './agents/claude/detect';
import { RunnerError, type StepExecutionContext } from './agents/runner';
import { FAKE_CLAUDE_CLI } from './testing/fakeClaude';
import { decidePublish, pendingPublish, waitStatusApprovingWith } from './testing/publishApproval';

const tmp = mkdtempSync(join(tmpdir(), 'paw-cc-'));
const repo = join(tmp, 'repo');
const dataRoot = join(tmp, 'data');
const stubDir = join(tmp, 'stub');
const stub = join(stubDir, 'claude');

let s: Services;
let app: ReturnType<typeof createApp>;
let cookie = '';
let projectId = '';
const savedKey = process.env.ANTHROPIC_API_KEY;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
}

const STUB = FAKE_CLAUDE_CLI;

const PLAN = {
  summary: 'greet の文言を変更する',
  approach: ['src/greet.ts の文字列を変更する'],
  files_to_change: ['src/greet.ts'],
  acceptance_criteria: ['greet() が Hello, world を返す'],
  risks: [],
  needs_human_decision: false,
  questions: [],
  dangerous_operations: [],
  mode: 'implement',
  mode_reason: 'コードの変更で完了できる',
};
const REVIEW = { verdict: 'ready_for_draft_pr', summary: '問題なし', blockers: [], nits: [], criteria: [{ criterion: 'greet() が Hello, world を返す', met: true, note: '' }], needs_design_decision: false };
const GOOD_DEV = { writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Hello, world';\n" }], text: 'greet の文言を変更しました' };

function setScenario(sc: Record<string, unknown>) {
  writeFileSync(join(stubDir, 'scenario.json'), JSON.stringify(sc));
  rmSync(join(stubDir, 'counts.json'), { force: true });
  rmSync(join(stubDir, 'calls.jsonl'), { force: true });
}
const counts = () => (existsSync(join(stubDir, 'counts.json')) ? (JSON.parse(readFileSync(join(stubDir, 'counts.json'), 'utf8')) as Record<string, number>) : {});
const calls = () =>
  existsSync(join(stubDir, 'calls.jsonl'))
    ? readFileSync(join(stubDir, 'calls.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { purpose: string; args: string[]; cwd: string; stdin: string; envKeys: string[]; pid: number })
    : [];

async function req(method: string, path: string, body?: unknown) {
  const r = await app.request(path, {
    method,
    headers: { cookie, 'x-paw-client': 'web', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as any };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 20000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await s.engine.tick();
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const runRow = async (id: string) => (await s.db.select().from(runs).where(eq(runs.id, id)))[0];
const waitStatus = (id: string, ...status: string[]) => waitFor(async () => (status.includes((await runRow(id)).status) ? runRow(id) : null));
/** publish 承認（GitHub への書き込みの前の人の承認）を承認しながら、指定の状態まで待つ */
const waitStatusApproving = (id: string, ...status: string[]) => waitStatusApprovingWith(s.db, req, waitFor, runRow)(id, ...status);

async function startRun(request = 'greet の文言を Hello, world に変更して') {
  const created = await req('POST', '/v1/runs', { projectId, request });
  expect(created.status).toBe(202);
  expect(created.body.runtime).toBe('claude_code');
  return created.body.runId as string;
}

beforeAll(async () => {
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(join(repo, 'src/greet.ts'), "export const greet = () => 'Hello';\n");
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  // API キーがあっても Claude Code の子プロセスには渡さないことを確認する
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
  setScenario({});

  s = await createServices(
    loadConfig({
      dataDir: 'memory',
      dataRoot,
      worktreesDir: join(dataRoot, 'worktrees'),
      simSpeed: 0,
      simRandomFailures: false,
      seedDemo: false,
      enableDevRoutes: true,
      logLevel: 'silent',
      agentRuntimeMode: 'claude_code',
      agentRuntime: 'claude_code',
      claudeCode: { ...defaultClaudeCodeConfig(), bin: stub },
      testTimeoutMs: 30_000,
    }),
  );
  app = createApp(s);
  const r = await app.request('/v1/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paw-client': 'web' },
    body: JSON.stringify({ username: 'ccuser', displayName: 'CC', password: 'password-1234' }),
  });
  cookie = r.headers.get('set-cookie')!.split(';')[0];
  projectId = (await req('POST', '/v1/projects', { name: 'Local', color: '#38e1ff' })).body.id;
  await req('POST', `/v1/projects/${projectId}/repositories`, { fullName: 'me/local-repo' });
  const ok = await req('PUT', `/v1/projects/${projectId}/local-repo`, { localPath: repo, testCommand: 'git status --short' });
  expect(ok.status).toBe(200);
  expect(ok.body.repository.runtime).toBe('claude_code');
});

afterAll(async () => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  await s.engine.stop();
  await s.client.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => setScenario({}));

// publish 承認の往復が増えたため、並列実行で遅くなっても切れない上限にする
describe('Claude Code (subscription) runtime — fake CLI', { timeout: 30_000 }, () => {
  it('runs plan → implement → test → review → draft PR through `claude -p` with locked-down options', async () => {
    setScenario({ plan: [{ output: PLAN }], develop: [GOOD_DEV], review: [{ output: REVIEW }] });
    const runId = await startRun();
    const run = await waitStatusApproving(runId, 'waiting_review', 'failed');
    expect(run.status).toBe('waiting_review');

    // AI ブランチにコミットされ、元のリポジトリの main は変わっていない
    expect(git(repo, 'show', `${run.pr!.branch}:src/greet.ts`)).toContain('Hello, world');
    expect(readFileSync(join(repo, 'src/greet.ts'), 'utf8')).toContain("'Hello'");

    const cs = calls();
    expect(cs.map((c) => c.purpose)).toEqual(['plan', 'develop', 'review']);
    for (const c of cs) {
      const a = c.args;
      expect(a.slice(0, 1)).toEqual(['-p']);
      for (const flag of ['--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--verbose']) expect(a).toContain(flag);
      expect(a[a.indexOf('--output-format') + 1]).toBe('stream-json');
      expect(a[a.indexOf('--disallowedTools') + 1]).toBe('mcp__*');
      const settings = JSON.parse(a[a.indexOf('--settings') + 1]);
      expect(settings.disableAllHooks).toBe(true);
      expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
      expect(settings.permissions.deny).toEqual(expect.arrayContaining(['Edit(.github/workflows/**)', 'Edit(.claude/**)', 'Read(.env)']));
      // 作業は Run 専用の worktree で行う
      // macOS は /var が /private/var の実体パスになるため、両辺を実体パスにしてから比べる
      expect(realpathSync(c.cwd).startsWith(realpathSync(join(dataRoot, 'worktrees')))).toBe(true);
      // 依頼本文は標準入力（非信頼入力として囲む）
      expect(c.stdin).toContain('<untrusted_request>');
      // API キーや親の Claude Code セッションの環境変数は渡さない（渡すと API 課金になる）
      expect(c.envKeys).not.toContain('ANTHROPIC_API_KEY');
      expect(c.envKeys.some((k) => k.startsWith('ANTHROPIC_'))).toBe(false);
      expect(c.envKeys).not.toContain('CLAUDECODE');
    }
    const [plan, dev, review] = cs;
    expect(plan.args[plan.args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(JSON.parse(plan.args[plan.args.indexOf('--json-schema') + 1]).required).toContain('acceptance_criteria');
    expect(dev.args[dev.args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Edit,Write');
    expect(dev.args[dev.args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(dev.args).not.toContain('--json-schema');
    expect(review.stdin).toContain('Hello, world');

    // サブスク枠: トークン数は記録し、費用は 0（API の請求なし）
    const usage = await s.db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage.length).toBe(3);
    expect(usage.every((u) => u.measurement === 'subscription' && u.estimatedCostUsd === 0 && u.inputTokens === 115)).toBe(true);
    expect((await runRow(runId)).costUsd).toBe(0);
    const detail = await req('GET', `/v1/runs/${runId}`);
    expect(detail.body.run.runtime).toBe('claude_code');
    expect(detail.body.run.model).toBe('claude-test-model');
    // 工程の表示は実際に応答したモデル名（シミュレーション用の名前を出さない）
    expect(detail.body.steps.map((x: any) => `${x.key}:${x.model}`)).toEqual([
      'plan:claude-test-model',
      'implement:claude-test-model',
      'test:test-command',
      'review:claude-test-model',
      'draft_pr:policy-broker',
    ]);
    expect(detail.body.usage.measurement).toBe('subscription');
  });

  it('discards the attempt and fails when Claude Code changes CI config or Claude settings', async () => {
    setScenario({
      plan: [{ output: PLAN }],
      develop: [
        {
          writes: [
            { path: 'src/greet.ts', content: "export const greet = () => 'pwned';\n" },
            { path: '.github/workflows/evil.yml', content: 'on: push\n' },
            { path: '.claude/settings.json', content: '{"hooks":{}}' },
          ],
        },
      ],
      review: [{ output: REVIEW }],
    });
    const runId = await startRun();
    const run = await waitStatus(runId, 'failed', 'waiting_review');
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('FORBIDDEN_CHANGE');
    expect(run.errorMessage).toContain('.github/workflows/evil.yml');
    expect(counts().develop).toBe(1); // 再試行しない
    // 変更は取り込まれず、空のブランチは片付けられる
    const branchName = `ai/run-${run.id.slice(4, 14).toLowerCase()}`;
    await waitFor(async () => !existsSync(join(dataRoot, 'worktrees', runId)) && !git(repo, 'branch', '--list', branchName).trim());
    expect(existsSync(join(repo, '.github'))).toBe(false);
  });

  it('pauses the run as needs_input on the subscription usage limit and resumes the same step on approval', async () => {
    setScenario({ plan: [{ output: PLAN }], develop: [{ kind: 'usage_limit' }, GOOD_DEV], review: [{ output: REVIEW }] });
    const runId = await startRun();
    const paused = await waitStatus(runId, 'needs_input', 'failed');
    expect(paused.status).toBe('needs_input');
    const [impl] = await s.db.select().from(runSteps).where(and(eq(runSteps.runId, runId), eq(runSteps.key, 'implement')));
    expect(impl.status).toBe('needs_input');
    expect(impl.errorCode).toBe('CLAUDE_USAGE_LIMIT');
    expect(counts().develop).toBe(1); // 上限では再試行しない

    const list = await req('GET', '/v1/approvals');
    const ap = list.body.items.find((x: any) => x.runId === runId && x.status === 'pending');
    expect(ap.actionType).toBe('clarification');
    expect(ap.payload.reason).toBe('usage_limit');
    expect(ap.payload.stepKey).toBe('implement');
    expect(typeof ap.payload.resetsAt).toBe('string');
    expect(new Date(ap.payload.resetsAt).getTime()).toBeGreaterThan(Date.now());

    const d = await req('POST', `/v1/approvals/${ap.id}/decision`, { decision: 'approve', expectedVersion: ap.version, confirmationDigest: ap.payloadDigest });
    expect(d.status).toBe(200);
    const done = await waitStatusApproving(runId, 'waiting_review', 'failed');
    expect(done.status).toBe('waiting_review');
    // 計画はやり直さず、止まった Developer の工程から再開している
    expect(counts()).toEqual({ plan: 1, develop: 2, review: 1 });
    const steps = await s.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    expect(steps.filter((x) => x.key === 'implement').map((x) => x.status)).toEqual(['succeeded']);
  });

  it('fails without retry when Claude Code is not logged in', async () => {
    setScenario({ plan: [{ kind: 'auth' }] });
    const runId = await startRun();
    const run = await waitStatus(runId, 'failed', 'waiting_review');
    expect(run.errorCode).toBe('CLAUDE_AUTH_ERROR');
    expect(counts().plan).toBe(1);
  });

  it('stops instead of silently billing an API key when the CLI reports apiKeySource=ANTHROPIC_API_KEY', async () => {
    setScenario({ plan: [{ output: PLAN, apiKeySource: 'ANTHROPIC_API_KEY' }] });
    const runId = await startRun();
    const run = await waitStatus(runId, 'failed', 'waiting_review');
    expect(run.errorCode).toBe('CLAUDE_CODE_NOT_SUBSCRIPTION');
    expect(counts().plan).toBe(1);
    // 停止が結果の出力より先なら記録は無い。結果まで出ていた場合も、サブスク扱い（費用 0）にはしない
    const usage = await s.db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage.every((u) => u.measurement === 'estimated' && u.estimatedCostUsd === 0.0123)).toBe(true);
  });

  it('retries a CLI crash a bounded number of times and records stderr', async () => {
    setScenario({ plan: [{ kind: 'crash' }] });
    const runId = await startRun();
    const run = await waitStatus(runId, 'failed', 'waiting_review');
    expect(run.errorCode).toBe('CLAUDE_CODE_FAILED');
    expect(run.errorMessage).toContain('segfault-ish');
    expect(counts().plan).toBe(2); // maxAttempts = 2
  });

  it('kills the CLI process when the run is cancelled', async () => {
    setScenario({ plan: [{ kind: 'hang' }] });
    const runId = await startRun();
    await waitFor(async () => calls().length > 0);
    const pid = calls()[0].pid;
    const c = await req('POST', `/v1/runs/${runId}/cancel`);
    expect(c.status).toBe(200);
    await waitFor(async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 15000);
    expect((await runRow(runId)).status).toBe('cancelled');
  });
});

// 2 回の Developer を通すため、並列実行で遅くなっても切れない上限にする
describe('publish 承認（GitHub への書き込みの前の人の承認）', { timeout: 30_000 }, () => {
  const branchOf = (runId: string) => `ai/run-${runId.slice(4, 14).toLowerCase()}`;

  it('AI レビューが通ると needs_input で publish 承認を待ち、承認するまで PR を作らない', async () => {
    setScenario({ plan: [{ output: PLAN }], develop: [GOOD_DEV], review: [{ output: REVIEW }] });
    const runId = await startRun();
    const paused = await waitStatus(runId, 'needs_input', 'failed', 'waiting_review');
    expect(paused.status).toBe('needs_input');
    expect(paused.pr).toBeNull();
    const ap = await pendingPublish(s.db, runId);
    expect(ap).not.toBeNull();
    expect(ap!.actionType).toBe('publish');
    expect(ap!.payload).toMatchObject({
      kind: 'pull_request',
      headSha: git(repo, 'rev-parse', branchOf(runId)).trim(),
      title: paused.title,
      labels: { remove: [], add: [] },
      update: false,
    });
    expect(String(ap!.payload.diffSha256)).toMatch(/^[0-9a-f]{64}$/);
    // 承認カードが開く差分は、承認する差分と同じ中身の成果物
    const diffArts = (await s.db.select().from(artifacts).where(eq(artifacts.runId, runId))).filter((x) => x.kind === 'diff');
    expect(ap!.payload.diffArtifactId).toBe(diffArts.find((x) => x.checksum === `sha256:${ap!.payload.diffSha256}`)?.id);
    expect(ap!.payload.diffArtifactId).toEqual(expect.any(String));
    expect(String(ap!.payload.body)).toContain('この PR は agents-office が作りました。マージは人が行います。');
    // 画面からの指示の Run（Issue なし）は Closes 行を付けない
    expect(String(ap!.payload.body)).not.toContain('Closes #');
    // 期限は 72 時間（作成時刻は DB の既定値、期限はエンジンの時計なので数秒の誤差を許す）
    expect(Math.abs(ap!.expiresAt.getTime() - ap!.createdAt.getTime() - 72 * 3600_000)).toBeLessThan(5_000);
    const before = await s.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    expect(before.some((x) => x.key === 'draft_pr')).toBe(false);

    await decidePublish(s.db, req, runId);
    const done = await waitStatus(runId, 'waiting_review', 'failed');
    expect(done.status).toBe('waiting_review');
    expect(done.pr!.headSha).toBe(ap!.payload.headSha);
    const [decided] = await s.db.select().from(approvals).where(eq(approvals.id, ap!.id));
    expect(decided.status).toBe('approved');
  });

  it('差し戻すと指示を付けて implement が再び動き、新しい publish 承認の headSha が変わる', async () => {
    setScenario({
      plan: [{ output: PLAN }],
      develop: [GOOD_DEV, { writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Hello, world!';\n" }], text: '! を足しました' }],
      review: [{ output: REVIEW }],
    });
    const runId = await startRun();
    expect((await waitStatus(runId, 'needs_input', 'failed')).status).toBe('needs_input');
    const first = (await pendingPublish(s.db, runId))!;
    await decidePublish(s.db, req, runId, 'request_changes', '末尾に ! を付けて');
    const second = await waitFor(async () => {
      const ap = await pendingPublish(s.db, runId);
      return ap && ap.id !== first.id ? ap : null;
    });
    expect(counts().develop).toBe(2);
    expect(calls().filter((c) => c.purpose === 'develop')[1].stdin).toContain('末尾に ! を付けて');
    expect(second.payload.headSha).not.toBe(first.payload.headSha);
    expect(second.payload.headSha).toBe(git(repo, 'rev-parse', branchOf(runId)).trim());
    expect((await runRow(runId)).status).toBe('needs_input');
    expect((await runRow(runId)).pr).toBeNull();
    const [old] = await s.db.select().from(approvals).where(eq(approvals.id, first.id));
    expect(old.status).toBe('changes_requested');
  });

  it('却下すると PR を作らずに Run を中止する', async () => {
    setScenario({ plan: [{ output: PLAN }], develop: [GOOD_DEV], review: [{ output: REVIEW }] });
    const runId = await startRun();
    expect((await waitStatus(runId, 'needs_input', 'failed')).status).toBe('needs_input');
    await decidePublish(s.db, req, runId, 'reject');
    const run = await waitStatus(runId, 'cancelled', 'failed', 'waiting_review');
    expect(run.status).toBe('cancelled');
    expect(run.pr).toBeNull();
  });
});

describe('Claude Code cancel waits for exit', () => {
  it('CLI のプロセスが終わってから cancelRun が返る', async () => {
    // SIGINT を受けても 1 秒生き続ける偽 CLI
    setScenario({ plan: [{ kind: 'slow_exit', slowExitMs: 1000 }] });
    const runId = await startRun();
    await waitFor(async () => calls().length > 0);
    const pid = calls()[0].pid;
    await new Promise((r) => setTimeout(r, 200)); // SIGINT ハンドラの登録を待つ
    const row = await s.engine.cancelRun(runId, 'test');
    expect(row?.status).toBe('cancelled');
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code !== 'ESRCH';
    }
    expect(alive).toBe(false);
  });
});

describe('Claude Code kill switch', () => {
  it('実行中の Run が複数あっても、CLI の終了を直列に待たず同時に止める', async () => {
    const p2 = (await req('POST', '/v1/projects', { name: 'Local2', color: '#38e1ff' })).body.id as string;
    await req('POST', `/v1/projects/${p2}/repositories`, { fullName: 'me/local-repo2' });
    expect((await req('PUT', `/v1/projects/${p2}/local-repo`, { localPath: repo, testCommand: 'git status --short' })).status).toBe(200);
    const slowMs = 2000;
    setScenario({ plan: [{ kind: 'slow_exit', slowExitMs: slowMs }] });
    const r1 = await startRun();
    const created = await req('POST', '/v1/runs', { projectId: p2, request: '別の変更' });
    expect(created.status).toBe(202);
    await waitFor(async () => calls().length >= 2);
    await new Promise((r) => setTimeout(r, 200)); // SIGINT ハンドラの登録を待つ
    const t0 = Date.now();
    const k = await req('POST', '/v1/workspaces/me/kill-switch', { action: 'pause', cancelActive: true });
    const elapsed = Date.now() - t0;
    expect(k.status).toBe(200);
    expect(k.body.cancelled).toBeGreaterThanOrEqual(2);
    // 直列なら 2 × slowMs 以上かかる
    expect(elapsed).toBeLessThan(slowMs * 1.8);
    for (const c of calls()) {
      expect(() => process.kill(c.pid, 0)).toThrow();
    }
    expect((await runRow(r1)).status).toBe('cancelled');
    await req('POST', '/v1/workspaces/me/kill-switch', { action: 'resume', cancelActive: false });
  });
});

describe('Claude Code detection and errors', () => {
  const ctx = (signal = new AbortController().signal) =>
    ({
      signal,
      log: async () => undefined,
      tool: async () => ({ allowed: true, reason: '' }),
      usage: async () => undefined,
    }) as unknown as StepExecutionContext;

  it('reports a missing CLI as a non-retryable error', async () => {
    const b = new ClaudeCodeBackend({ ...defaultClaudeCodeConfig(), bin: join(tmp, 'no-such-claude') });
    const err = await b.develop(ctx(), { system: 's', user: 'u', worktree: repo }).catch((e) => e);
    expect(err).toBeInstanceOf(RunnerError);
    expect(err.code).toBe('CLAUDE_CODE_NOT_FOUND');
    expect(err.retryable).toBe(false);
  });

  it('auto mode prefers a logged-in subscription over an API key, and explains why it cannot use the CLI otherwise', async () => {
    setScenario({ auth: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' } });
    const p = await probeClaudeCode(stub);
    expect(p).toMatchObject({ version: '2.1.316', loggedIn: true, authMethod: 'claude.ai', subscription: true, problem: null });

    const auto = loadConfig({ dataDir: 'memory', agentRuntimeMode: 'auto', agentRuntime: 'claude', claudeCode: { ...defaultClaudeCodeConfig(), bin: stub } });
    await resolveAgentRuntime(auto);
    expect(auto.agentRuntime).toBe('claude_code');

    setScenario({ auth: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' } });
    const apiOnly = loadConfig({ dataDir: 'memory', agentRuntimeMode: 'auto', agentRuntime: 'claude', claudeCode: { ...defaultClaudeCodeConfig(), bin: stub } });
    await resolveAgentRuntime(apiOnly);
    expect(apiOnly.agentRuntime).toBe('claude');
    expect(apiOnly.claudeCode.detected?.subscription).toBe(false);

    setScenario({ auth: { loggedIn: false, authMethod: 'none' } });
    const none = loadConfig({ dataDir: 'memory', agentRuntimeMode: 'auto', agentRuntime: 'simulated', claudeCode: { ...defaultClaudeCodeConfig(), bin: stub } });
    await resolveAgentRuntime(none);
    expect(none.agentRuntime).toBe('simulated');
    expect(none.agentRuntimeReason).toContain('ログインしていません');

    setScenario({ version: '2.1.100 (Claude Code)' });
    expect((await probeClaudeCode(stub)).problem).toContain('古い');

    const missing = await probeClaudeCode(join(tmp, 'no-such-claude'));
    expect(missing.problem).toContain('見つかりません');
  });
});
