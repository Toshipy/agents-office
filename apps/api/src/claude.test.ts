/**
 * Claude 実行基盤のテスト。Claude API の代わりに台本どおり応答する偽クライアントを注入し、
 * 実際の git リポジトリ（一時ディレクトリ）で worktree・ツール制限・成果物・利用量を検証する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config';
import { createApp, createServices, type Services } from './app';
import { runSteps, runs, stepLogs, usageRecords } from './db/schema';
import type { ClaudeMessagesClient } from './agents/claude/apiBackend';
import { decidePublish } from './testing/publishApproval';

const tmp = mkdtempSync(join(tmpdir(), 'paw-claude-'));
const repo = join(tmp, 'repo');
const dataRoot = join(tmp, 'data');

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
}

/* ------------------------------------------------------------------ */
/* 偽の Claude クライアント                                              */
/* ------------------------------------------------------------------ */

type Mode = { plan: 'ok' | 'clarify' | 'refuse' | 'throw'; devScript: Anthropic.Beta.BetaContentBlock[][] };
const mode: Mode = { plan: 'ok', devScript: [] };
const calls: { kind: 'parse' | 'stream'; params: Record<string, any> }[] = [];
let devTurn = 0;

function message(content: Anthropic.Beta.BetaContentBlock[], stop: string, extra: Record<string, unknown> = {}) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stop,
    stop_details: stop === 'refusal' ? { type: 'refusal', category: 'cyber', explanation: 'test' } : null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...extra,
  };
}

const PLAN = {
  summary: '挨拶文を変更し、テストを追加する',
  approach: ['src/greet.ts の文言を変更', 'テストを追加'],
  files_to_change: ['src/greet.ts'],
  acceptance_criteria: ['greet() が "Hello, world" を返す'],
  risks: [],
  needs_human_decision: false,
  questions: [],
  dangerous_operations: [],
};
const REVIEW = {
  verdict: 'ready_for_draft_pr',
  summary: '依頼どおりの変更です',
  blockers: [],
  nits: ['テスト名をより具体的に'],
  criteria: [{ criterion: 'greet() が "Hello, world" を返す', met: true, note: '' }],
};

const fakeClient: ClaudeMessagesClient = {
  beta: {
    messages: {
      parse: (async (params: Record<string, any>) => {
        calls.push({ kind: 'parse', params });
        const system = String(params.system);
        if (system.includes('Planner')) {
          if (mode.plan === 'refuse') return message([], 'refusal', { parsed_output: null });
          // 認証情報が無いとき SDK は HTTP 以前に素の Error を投げる
          if (mode.plan === 'throw') throw new Error('Could not resolve authentication method.');
          if (mode.plan === 'clarify' && !String(JSON.stringify(params.messages)).includes('人からの追加指示')) {
            return message([], 'end_turn', { parsed_output: { ...PLAN, needs_human_decision: true, questions: ['対象画面はどれですか？'] } });
          }
          return message([], 'end_turn', { parsed_output: PLAN });
        }
        return message([], 'end_turn', { parsed_output: REVIEW });
      }) as never,
      stream: ((params: Record<string, any>) => {
        calls.push({ kind: 'stream', params });
        const content = mode.devScript[devTurn++] ?? [{ type: 'text', text: '完了しました' }];
        const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
        return { finalMessage: async () => message(content, stop) };
      }) as never,
    },
  },
};

const toolUse = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2)}`, name, input }) as unknown as Anthropic.Beta.BetaContentBlock;
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as unknown as Anthropic.Beta.BetaContentBlock;

/* ------------------------------------------------------------------ */

let s: Services;
let app: ReturnType<typeof createApp>;
let cookie = '';

async function req(method: string, path: string, body?: unknown) {
  const r = await app.request(path, {
    method,
    headers: { cookie, 'x-paw-client': 'web', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as any };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await s.dispatcher.drain();
    await s.engine.tick();
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const runRow = async (id: string) => (await s.db.select().from(runs).where(eq(runs.id, id)))[0];
const waitStatus = (id: string, status: string) => waitFor(async () => ((await runRow(id)).status === status ? runRow(id) : null));
/** publish 承認（GitHub への書き込みの前の人の承認）を承認しながら、指定の状態まで待つ */
const waitStatusApproving = (id: string, status: string) =>
  waitFor(async () => {
    const r = await runRow(id);
    if (r.status === status) return r;
    if (r.status === 'needs_input') await decidePublish(s.db, req, id);
    return null;
  });

let projectId = '';

beforeAll(async () => {
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(join(repo, 'src/greet.ts'), "export const greet = () => 'Hello';\n");
  writeFileSync(join(tmp, 'outside.txt'), 'outside\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

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
      agentRuntime: 'claude',
      testTimeoutMs: 30_000,
    }),
    { claudeClient: fakeClient },
  );
  app = createApp(s);
  const r = await app.request('/v1/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paw-client': 'web' },
    body: JSON.stringify({ username: 'claudeuser', displayName: 'C', password: 'password-1234' }),
  });
  cookie = r.headers.get('set-cookie')!.split(';')[0];
  const p = await req('POST', '/v1/projects', { name: 'Local', color: '#38e1ff' });
  projectId = p.body.id;
  await req('POST', `/v1/projects/${projectId}/repositories`, { fullName: 'me/local-repo' });
});

afterAll(async () => {
  await s.engine.stop();
  await s.client.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('local repository settings', () => {
  it('rejects relative paths, missing dirs and non-git dirs, and accepts a git work tree', async () => {
    expect((await req('PUT', `/v1/projects/${projectId}/local-repo`, { localPath: 'relative/path', testCommand: null })).body.code).toBe('INVALID_LOCAL_REPO');
    expect((await req('PUT', `/v1/projects/${projectId}/local-repo`, { localPath: join(tmp, 'nope'), testCommand: null })).body.code).toBe('INVALID_LOCAL_REPO');
    expect((await req('PUT', `/v1/projects/${projectId}/local-repo`, { localPath: dataRoot, testCommand: null })).body.code).toBe('INVALID_LOCAL_REPO');
    const bad = await req('PUT', `/v1/projects/${projectId}/local-repo`, { localPath: repo, testCommand: 'npm test; rm -rf /' });
    expect(bad.status).toBe(400);
    const ok = await req('PUT', `/v1/projects/${projectId}/local-repo`, { localPath: repo, testCommand: 'git status --short' });
    expect(ok.status).toBe(200);
    expect(ok.body.repository.runtime).toBe('claude');
  });
});

describe('Claude runtime end-to-end (fake client)', () => {
  it('plans, edits only inside the worktree, commits on an ai/ branch, reviews and creates a local draft PR', async () => {
    mode.plan = 'ok';
    devTurn = 0;
    mode.devScript = [
      [text('ファイルを確認します'), toolUse('read_file', { path: 'src/greet.ts' }), toolUse('read_file', { path: '../outside.txt' }), toolUse('write_file', { path: '.env', content: 'SECRET=1' })],
      [
        toolUse('write_file', { path: '/etc/evil', content: 'x' }),
        toolUse('write_file', { path: '.github/workflows/ci.yml', content: 'on: push' }),
        toolUse('edit_file', { path: 'src/greet.ts', old_text: "'Hello'", new_text: "'Hello, world'" }),
      ],
      [toolUse('write_file', { path: 'tests/greet.test.ts', content: "import { greet } from '../src/greet';\n" })],
      [text('greet の文言を変更しテストを追加しました')],
    ];
    const created = await req('POST', '/v1/runs', { projectId, request: 'greet の文言を Hello, world に変更してテストを追加して' });
    expect(created.status).toBe(202);
    expect(created.body.runtime).toBe('claude');
    const runId = created.body.runId as string;
    const waiting = await waitStatusApproving(runId, 'waiting_review');

    // ブランチとコミット
    const branch = waiting.pr!.branch;
    expect(branch.startsWith('ai/run-')).toBe(true);
    expect(git(repo, 'show', `${branch}:src/greet.ts`)).toContain("'Hello, world'");
    expect(git(repo, 'show', `${branch}:tests/greet.test.ts`)).toContain('greet');
    expect(readFileSync(join(repo, 'src/greet.ts'), 'utf8')).toContain("'Hello'"); // main の作業ツリーは変わらない
    expect(waiting.pr!.headSha).toBe(git(repo, 'rev-parse', branch).trim());

    // worktree 外・秘密ファイルへのアクセスは拒否される
    expect(existsSync(join(dataRoot, 'worktrees', runId, '.env'))).toBe(false);
    const logs = (await s.db.select().from(stepLogs).where(eq(stepLogs.runId, runId))).map((l) => l.message);
    expect(logs.some((m) => m.includes('read_file') && m.includes('リポジトリの外'))).toBe(true);
    expect(logs.some((m) => m.includes('write_file') && m.includes('秘密情報'))).toBe(true);
    expect(logs.some((m) => m.includes('write_file') && m.includes('絶対パス'))).toBe(true);
    expect(logs.some((m) => m.includes('write_file') && m.includes('CI 設定'))).toBe(true);
    expect(git(repo, 'ls-tree', '-r', '--name-only', branch)).not.toContain('.github');
    expect(logs.some((m) => m.includes('git status --short'))).toBe(true);

    // 利用量は実測トークン × 単価
    const usage = await s.db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage.length).toBe(2 + 4); // plan + review + developer 4 turns
    expect(usage.every((u) => u.measurement === 'measured')).toBe(true);
    expect(usage[0].estimatedCostUsd).toBeCloseTo((1000 * 4 + 200 * 20) / 1e6, 8);

    // リクエストの形（モデル・フォールバック・構造化出力・ツール）
    const parseCall = calls.find((c) => c.kind === 'parse')!.params;
    expect(parseCall.model).toBe('claude-opus-5-5');
    expect(parseCall.fallbacks).toBe('default');
    expect(parseCall.betas).toContain('server-side-fallback-2026-07-01');
    expect(parseCall.output_config.format).toBeTruthy();
    const streamCall = calls.find((c) => c.kind === 'stream')!.params;
    expect(streamCall.tools.map((t: { name: string }) => t.name)).toEqual(['list_files', 'read_file', 'search_code', 'write_file', 'edit_file']);
    expect(streamCall.tools.every((t: { eager_input_streaming?: boolean }) => t.eager_input_streaming)).toBe(true);
    // 依頼本文は非信頼入力として区切って渡す
    expect(JSON.stringify(streamCall.messages[0])).toContain('<untrusted_request>');

    const detail = await req('GET', `/v1/runs/${runId}`);
    expect(detail.body.run.runtime).toBe('claude');
    expect(detail.body.usage.measurement).toBe('measured');
    const diffArtifact = detail.body.artifacts.find((a: { kind: string }) => a.kind === 'diff');
    const diff = await req('GET', `/v1/artifacts/${diffArtifact.id}`);
    expect(diff.body.content).toContain("+export const greet = () => 'Hello, world';");

    // 承認（GitHub レビューのシミュレート）で完了し、worktree は片付くがブランチは残る
    await req('POST', '/v1/dev/github/simulate', { kind: 'review', runId, state: 'approved', body: 'LGTM' });
    await waitStatus(runId, 'completed');
    await waitFor(async () => !existsSync(join(dataRoot, 'worktrees', runId)));
    expect(git(repo, 'branch', '--list', branch).trim()).toContain(branch.replace(/^ai\//, ''));
  });

  it('fails immediately without retry when Claude refuses', async () => {
    mode.plan = 'refuse';
    const created = await req('POST', '/v1/runs', { projectId, request: 'リファクタリングして' });
    const failed = await waitStatus(created.body.runId, 'failed');
    expect(failed.errorCode).toBe('MODEL_REFUSAL');
    const steps = await s.db.select().from(runSteps).where(eq(runSteps.runId, created.body.runId));
    expect(steps[0].attempt).toBe(1);
  });

  it('does not retry SDK failures such as missing credentials', async () => {
    mode.plan = 'throw';
    const created = await req('POST', '/v1/runs', { projectId, request: 'README を整えて' });
    const failed = await waitStatus(created.body.runId, 'failed');
    expect(failed.errorCode).toBe('CLAUDE_SDK_ERROR');
    const steps = await s.db.select().from(runSteps).where(eq(runSteps.runId, created.body.runId));
    expect(steps[0].attempt).toBe(1);
    // 変更の無い Run のブランチと作業用ファイルは片付けられる
    await waitFor(async () => !existsSync(join(dataRoot, 'worktrees', `${created.body.runId}.base`)));
    expect(git(repo, 'branch', '--list', `ai/run-${String(created.body.runId).slice(4, 14).toLowerCase()}`).trim()).toBe('');
  });

  it('asks for clarification and re-plans with the human answer', async () => {
    mode.plan = 'clarify';
    devTurn = 99; // 以降の Developer は即終了
    const created = await req('POST', '/v1/runs', { projectId, request: 'いい感じに直して' });
    const runId = created.body.runId as string;
    await waitStatus(runId, 'needs_input');
    const list = await req('GET', '/v1/approvals');
    const ap = list.body.items.find((x: { runId: string }) => x.runId === runId);
    expect(ap.actionType).toBe('clarification');
    expect(ap.payload.questions).toContain('対象画面はどれですか？');
    const r = await req('POST', `/v1/approvals/${ap.id}/decision`, {
      decision: 'request_changes',
      comment: 'ログイン画面です',
      expectedVersion: ap.version,
      confirmationDigest: ap.payloadDigest,
    });
    expect(r.status).toBe(200);
    // 変更が無いので Reviewer が blocker を出し、修正ループの後に失敗する（空の PR は出さない）
    const done = await waitFor(async () => {
      const row = await runRow(runId);
      return ['failed', 'waiting_review'].includes(row.status) ? row : null;
    });
    expect(done.status).toBe('failed');
    expect(done.errorCode).toBe('REVIEW_BLOCKED');
    expect(done.guidance).toBe('ログイン画面です');
  });

  it('runs simulated when no local repository is set', async () => {
    const p = await req('POST', '/v1/projects', { name: 'NoLocal', color: '#38e1ff' });
    await req('POST', `/v1/projects/${p.body.id}/repositories`, { fullName: 'me/no-local' });
    const created = await req('POST', '/v1/runs', { projectId: p.body.id, request: 'CSV エクスポートを追加' });
    expect(created.body.runtime).toBe('simulated');
  });
});
