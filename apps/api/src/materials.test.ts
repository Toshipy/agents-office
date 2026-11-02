/**
 * 資料モード（人が決める Issue には、コードを変えずに判断材料を Issue コメントに書く）の検証。
 *  - decideFromComments / validateMaterials の表形式テスト
 *  - 偽の claude CLI・メモリ上の GitHub API モック・リモート代わりの bare リポジトリで、
 *    計画の振り分け → 資料 → publish 承認 → コメント・ラベル・アサインの操作 → completed を通す
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { defaultClaudeCodeConfig, loadConfig } from './config';
import { createApp, createServices, type Services } from './app';
import { approvals, repositoryBindings, runSteps, runs, workspaces } from './db/schema';
import { decideFromComments, MATERIALS_HEADINGS, MATERIALS_MARKER, validateMaterials } from './agents/claude/materials';
import type { GithubComment } from './github/app';
import { installFakeClaude } from './testing/fakeClaude';
import { decidePublish, pendingPublish } from './testing/publishApproval';

/* ------------------------------------------------------------------ */
/* 純粋関数                                                             */
/* ------------------------------------------------------------------ */

const MAT = (extra = '') => [MATERIALS_MARKER, '## 決めること', '何を決めるか', '## 現状', '今の姿', '## 選択肢', '| 案 | 良い点 | 悪い点 | 作業量 |', '## 会議で確かめる問い', '- 問い', extra].join('\n');
const cm = (id: number, body: string, userType: 'User' | 'Bot' = 'User'): GithubComment => ({
  id,
  body,
  user: userType === 'Bot' ? 'agents-office[bot]' : 'toshipy',
  userType,
  createdAt: `2026-11-01T00:00:${String(id).padStart(2, '0')}Z`,
});

describe('decideFromComments', () => {
  it.each([
    ['コメントが無い', null, []],
    ['資料コメントが無い', null, [cm(1, '補足です')]],
    ['資料の後に人のコメントがある', 'implement', [cm(1, MAT(), 'Bot'), cm(2, 'A 案で進めます')]],
    ['資料の後は Bot のコメントだけ', null, [cm(1, MAT(), 'Bot'), cm(2, 'CI が通りました', 'Bot')]],
    ['資料の後は印付きのコメントだけ', null, [cm(1, MAT(), 'Bot'), cm(2, `${MATERIALS_MARKER}\n## 決めること`, 'User')]],
    ['人のコメントは資料より前だけ', null, [cm(1, '補足です'), cm(2, MAT(), 'Bot')]],
    ['人のコメントの後に新しい資料がある', null, [cm(1, MAT(), 'Bot'), cm(2, 'A 案で'), cm(3, MAT(), 'Bot')]],
    ['新しい資料の後にまた人のコメントがある', 'implement', [cm(1, MAT(), 'Bot'), cm(2, 'A 案で'), cm(3, MAT(), 'Bot'), cm(4, 'B 案に変更')]],
    ['2 行目以降に印があるだけのコメントは資料ではない', null, [cm(1, `前置き\n${MATERIALS_MARKER}`), cm(2, '人のコメント')]],
  ] as const)('%s → %s', (_n, expected, comments) => {
    expect(decideFromComments([...comments])).toBe(expected);
  });
});

describe('validateMaterials', () => {
  it('印と見出しの順が正しければ問題なし', () => {
    expect(validateMaterials(MAT())).toEqual([]);
    expect(MATERIALS_HEADINGS).toEqual(['## 決めること', '## 現状', '## 選択肢', '## 会議で確かめる問い']);
  });
  it.each([
    ['1 行目に印が無い', MAT().replace(`${MATERIALS_MARKER}\n`, ''), /1 行目/],
    ['見出しが足りない', MAT().replace('## 現状\n', ''), /## 現状/],
    ['見出しの順が違う', [MATERIALS_MARKER, '## 現状', 'x', '## 決めること', 'x', '## 選択肢', 'x', '## 会議で確かめる問い', 'x'].join('\n'), /順/],
    ['## 推奨 がある', MAT('## 推奨\nA 案がよい'), /推奨/],
    ['### 結論 がある', MAT('### 結論\nA 案'), /結論/],
  ])('%s は問題', (_n, md, pattern) => {
    const problems = validateMaterials(md);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(pattern);
  });
});

/* ------------------------------------------------------------------ */
/* 流れ（偽 CLI + GitHub モック + bare リポジトリ）                       */
/* ------------------------------------------------------------------ */

const tmp = mkdtempSync(join(tmpdir(), 'paw-mat-'));
const dataRoot = join(tmp, 'data');
const origin = join(tmp, 'origin.git');
const INSTALLATION_ID = 5151;
const REPO_ID = 880011;
const FULL_NAME = 'toshipy/mat';
const LOGIN = 'toshipy';
const fake = installFakeClaude(join(tmp, 'stub'));
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

type MockIssue = { number: number; title: string; body: string; labels: string[]; assignees: string[]; comments: { id: number; body: string; login: string; type: 'User' | 'Bot'; createdAt: string }[] };
const gh = {
  issues: new Map<number, MockIssue>(),
  calls: [] as { method: string; path: string; body: any }[],
  /** `${method} ${path}` → 次の 1 回だけ返すステータス（失敗の注入） */
  failOnce: new Map<string, number>(),
  nextCommentId: 100,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ghFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const path = url.pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  gh.calls.push({ method, path, body });
  const injected = gh.failOnce.get(`${method} ${path}`);
  if (injected) {
    gh.failOnce.delete(`${method} ${path}`);
    return json(injected, { message: 'injected failure' });
  }
  if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
    return json(201, { token: 'ghs_materials_test', expires_at: new Date(Date.now() + 3600_000).toISOString() });
  }
  const m = path.match(/^\/repos\/toshipy\/mat\/issues\/(\d+)(\/.*)?$/);
  const issue = m ? gh.issues.get(Number(m[1])) : undefined;
  if (!m || !issue) return json(404, { message: 'Not Found' });
  const rest = m[2] ?? '';
  if (method === 'GET' && rest === '') {
    return json(200, {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      html_url: `https://github.com/${FULL_NAME}/issues/${issue.number}`,
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login })),
      updated_at: '2026-11-01T00:00:00Z',
      state: 'open',
    });
  }
  if (method === 'GET' && rest === '/comments') {
    const page = Number(url.searchParams.get('page') ?? '1');
    return json(200, page === 1 ? issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.login, type: c.type }, created_at: c.createdAt })) : []);
  }
  if (method === 'POST' && rest === '/comments') {
    const id = gh.nextCommentId++;
    // App のトークンで書いたコメントは Bot として残る
    issue.comments.push({ id, body: body.body, login: 'agents-office[bot]', type: 'Bot', createdAt: new Date().toISOString() });
    return json(201, { id });
  }
  if (method === 'POST' && rest === '/labels') {
    issue.labels = [...new Set([...issue.labels, ...body.labels])];
    return json(200, issue.labels.map((name) => ({ name })));
  }
  if (method === 'DELETE' && rest.startsWith('/labels/')) {
    const name = decodeURIComponent(rest.slice('/labels/'.length));
    if (!issue.labels.includes(name)) return json(404, { message: 'Label does not exist' });
    issue.labels = issue.labels.filter((l) => l !== name);
    return json(200, []);
  }
  if (method === 'POST' && rest === '/assignees') {
    issue.assignees = [...new Set([...issue.assignees, ...body.assignees])];
    return json(201, {});
  }
  if (method === 'DELETE' && rest === '/assignees') {
    issue.assignees = issue.assignees.filter((a) => !body.assignees.includes(a));
    return json(200, {});
  }
  return json(404, { message: 'Not Found' });
}) as typeof fetch;

let s: Services;
let app: ReturnType<typeof createApp>;
let cookie = '';
let binding: typeof repositoryBindings.$inferSelect;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
}

async function req(method: string, path: string, body?: unknown) {
  const r = await app.request(path, {
    method,
    headers: { cookie, 'x-paw-client': 'web', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as any };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 25_000): Promise<T> {
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
const waitStatus = (id: string, ...st: string[]) => waitFor(async () => (st.includes((await runRow(id)).status) ? runRow(id) : null));
const stepsOf = async (id: string) => s.db.select().from(runSteps).where(eq(runSteps.runId, id)).orderBy(runSteps.seq);
const commentPosts = (n: number) => gh.calls.filter((c) => c.method === 'POST' && c.path === `/repos/${FULL_NAME}/issues/${n}/comments`).length;

function addIssue(number: number, extra: Partial<MockIssue> = {}) {
  gh.issues.set(number, { number, title: `Issue ${number}`, body: '一覧の並び順をどうするか検討したい', labels: [], assignees: [], comments: [], ...extra });
}

async function startIssue(number: number) {
  const r = await s.issueIntake.start(binding, number, { via: 'ui', labeledBy: null, guidance: null });
  if (!('runId' in r)) throw new Error(`Run を作れません: ${JSON.stringify(r)}`);
  return r.runId;
}

const PLAN = (mode: 'implement' | 'materials') => ({
  summary: mode === 'materials' ? '並び順は人が決める' : 'greet の文言を変更する',
  approach: ['src/greet.ts を変更する'],
  files_to_change: ['src/greet.ts'],
  acceptance_criteria: ['greet() が Hello, world を返す'],
  risks: [],
  needs_human_decision: false,
  questions: [],
  dangerous_operations: [],
  mode,
  mode_reason: mode === 'materials' ? '「検討」とあり、方針を人が決める必要がある' : 'コードの変更で完了できる',
});

beforeAll(async () => {
  const seed = join(tmp, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  writeFileSync(join(seed, 'README.md'), '# mat\n');
  writeFileSync(join(seed, 'src/greet.ts'), "export const greet = () => 'Hello';\n");
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin]);

  s = await createServices(
    loadConfig({
      dataDir: 'memory',
      dataRoot,
      worktreesDir: join(dataRoot, 'worktrees'),
      simSpeed: 0,
      simRandomFailures: false,
      seedDemo: false,
      enableDevRoutes: false,
      logLevel: 'silent',
      agentRuntimeMode: 'claude_code',
      agentRuntime: 'claude_code',
      claudeCode: { ...defaultClaudeCodeConfig(), bin: fake.bin },
      githubApp: { appId: '1', privateKeyPem: pem, apiUrl: 'https://api.github.test', allowedUsers: [LOGIN] },
      githubLogin: LOGIN,
      testTimeoutMs: 30_000,
    }),
    { githubFetch: ghFetch },
  );
  app = createApp(s);
  const r = await app.request('/v1/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paw-client': 'web' },
    body: JSON.stringify({ username: 'owner', displayName: 'Owner', password: 'password-1234' }),
  });
  cookie = r.headers.get('set-cookie')!.split(';')[0];
  const projectId = (await req('POST', '/v1/projects', { name: 'Mat', color: '#38e1ff' })).body.id;
  const [ws] = await s.db.select().from(workspaces);
  await s.db.insert(repositoryBindings).values({
    id: 'rb_materials',
    workspaceId: ws.id,
    projectId,
    installationId: INSTALLATION_ID,
    repositoryId: REPO_ID,
    fullName: FULL_NAME,
    automationEnabled: false,
    verification: 'github_app',
    defaultBranch: 'main',
    cloneUrl: origin,
    localPath: join(dataRoot, 'repos', String(REPO_ID)),
    policy: { triggerLabel: 'agents-office', events: ['issues.labeled'], maxRevisionAttempts: 3 },
  });
  [binding] = await s.db.select().from(repositoryBindings).where(eq(repositoryBindings.id, 'rb_materials'));
});

afterAll(async () => {
  await s.engine.stop();
  await s.client.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('資料モード（偽 CLI + GitHub モック）', { timeout: 60_000 }, () => {
  it('計画が materials なら、資料 → publish 承認 → コメント 1 件・agents-office を外す・needs-human を付ける・自分のアサインを外す → completed。post_materials が 2 回動いてもコメントは 1 件', async () => {
    fake.setScenario({
      plan: [{ output: PLAN('materials') }],
      // 1 回目は推奨の見出しを含むので作り直させる
      materials: [{ output: { markdown: MAT('## 推奨\nA 案') } }, { output: { markdown: MAT() } }],
    });
    addIssue(21);
    const runId = await startIssue(21);
    expect(gh.issues.get(21)!.labels).toContain('agents-office');
    expect(gh.issues.get(21)!.assignees).toEqual([LOGIN]);

    const ap = await waitFor(() => pendingPublish(s.db, runId));
    expect(fake.counts()).toMatchObject({ plan: 1, materials: 2 });
    expect(fake.counts().develop).toBeUndefined();
    // 作り直しの指示に、前回の問題が入る
    const secondMaterials = fake.calls().filter((c) => c.purpose === 'materials')[1];
    expect(secondMaterials.stdin).toContain('推奨');
    // 資料の工程は読み取り専用のツールだけ
    expect(secondMaterials.args[secondMaterials.args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(ap.payload).toMatchObject({ kind: 'materials', labels: { remove: ['agents-office'], add: ['needs-human'] }, unassign: true });
    const comment = String(ap.payload.comment);
    expect(comment.split('\n')[0]).toBe(MATERIALS_MARKER);
    expect(comment).toContain(`run: ${runId}`);
    expect(validateMaterials(comment)).toEqual([]);
    // 承認の前は何も書かない
    expect(commentPosts(21)).toBe(0);
    expect(gh.issues.get(21)!.labels).toContain('agents-office');

    // コメントの投稿は通るが、ラベルの取り外しが 1 回だけ失敗する（投稿の後で落ちた post_materials がもう一度動く）
    gh.failOnce.set(`DELETE /repos/${FULL_NAME}/issues/21/labels/agents-office`, 502);
    await decidePublish(s.db, req, runId, 'approve');
    const done = await waitStatus(runId, 'completed', 'failed', 'cancelled');
    expect(done.status).toBe('completed');

    const issue = gh.issues.get(21)!;
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0].body).toBe(comment);
    expect(commentPosts(21)).toBe(1);
    expect(issue.labels).not.toContain('agents-office');
    expect(issue.labels).toContain('needs-human');
    expect(issue.assignees).toEqual([]);
    const post = (await stepsOf(runId)).filter((st) => st.key === 'post_materials');
    expect(post).toHaveLength(1);
    expect(post[0].attempt).toBe(2);
    // ブランチも PR も作らない
    expect(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/ai/')).toBe('');
    expect(done.pr).toBeNull();
  });

  it('publish の差し戻しはコメントを指示にして資料を作り直し、却下で中止する', async () => {
    fake.setScenario({ plan: [{ output: PLAN('materials') }], materials: [{ output: { markdown: MAT() } }] });
    addIssue(22, { assignees: [LOGIN] });
    const runId = await startIssue(22);
    const first = await waitFor(() => pendingPublish(s.db, runId));
    // もともと自分が担当なら、アサインは外さない
    expect(first.payload.unassign).toBe(false);
    await decidePublish(s.db, req, runId, 'request_changes', '選択肢に「何もしない」を足して');
    const second = await waitFor(async () => {
      const ap = await pendingPublish(s.db, runId);
      return ap && ap.id !== first.id ? ap : null;
    });
    expect(second.payload.kind).toBe('materials');
    const calls = fake.calls().filter((c) => c.purpose === 'materials');
    expect(calls).toHaveLength(2);
    expect(calls[1].stdin).toContain('選択肢に「何もしない」を足して');
    expect(fake.counts().develop).toBeUndefined();
    await decidePublish(s.db, req, runId, 'reject');
    expect((await waitStatus(runId, 'cancelled', 'failed', 'completed')).status).toBe('cancelled');
    expect(gh.issues.get(22)!.comments).toHaveLength(0);
  });

  it('資料が 2 回とも形式に合わなければ失敗にし、Issue には何も書かない', async () => {
    fake.setScenario({ plan: [{ output: PLAN('materials') }], materials: [{ output: { markdown: '## 決めること\nだけ' } }] });
    addIssue(23);
    const runId = await startIssue(23);
    const done = await waitStatus(runId, 'failed', 'completed', 'cancelled', 'needs_input');
    expect(done.status).toBe('failed');
    expect(done.errorCode).toBe('MATERIALS_INVALID');
    expect(fake.counts().materials).toBe(2);
    expect(gh.issues.get(23)!.comments).toHaveLength(0);
  });

  it('前の資料の後に人のコメントがある Issue は、計画が materials でも実装に進む', async () => {
    fake.setScenario({
      plan: [{ output: PLAN('materials') }],
      develop: [{ kind: 'hang' }],
    });
    addIssue(24, {
      comments: [
        { id: 1, body: MAT(), login: 'agents-office[bot]', type: 'Bot', createdAt: '2026-10-01T00:00:00Z' },
        { id: 2, body: 'A 案で進めることにしました', login: 'toshipy', type: 'User', createdAt: '2026-10-02T00:00:00Z' },
      ],
    });
    const runId = await startIssue(24);
    expect((await runRow(runId)).source.modeFromComments).toBe('implement');
    await waitFor(async () => (await stepsOf(runId)).some((st) => st.key === 'implement'));
    expect((await stepsOf(runId)).some((st) => st.key === 'materials')).toBe(false);
    await s.engine.cancelRun(runId, 'test');
  });

  it('Developer が NEEDS_DESIGN_DECISION を返したら、変更を捨てて資料に切り替える', async () => {
    fake.setScenario({
      plan: [{ output: PLAN('implement') }],
      develop: [{ writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Hi';\n" }], text: '途中まで変えました\nNEEDS_DESIGN_DECISION: 文言を誰が決めるかが決まっていない' }],
      materials: [{ output: { markdown: MAT() } }],
    });
    addIssue(25);
    const runId = await startIssue(25);
    const ap = await waitFor(() => pendingPublish(s.db, runId));
    expect(ap.payload.kind).toBe('materials');
    const mat = fake.calls().filter((c) => c.purpose === 'materials');
    expect(mat).toHaveLength(1);
    expect(mat[0].stdin).toContain('文言を誰が決めるかが決まっていない');
    // 変更は捨てた（作業コピーは元のまま・コミットも無い）
    const wt = join(dataRoot, 'worktrees', runId);
    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(git(wt, 'show', 'HEAD:src/greet.ts')).toBe("export const greet = () => 'Hello';");
    expect((await stepsOf(runId)).some((st) => st.key === 'test')).toBe(false);
    await decidePublish(s.db, req, runId, 'reject');
    await waitStatus(runId, 'cancelled');
  });

  it('Reviewer が needs_design_decision を返したら資料に切り替える', async () => {
    fake.setScenario({
      plan: [{ output: PLAN('implement') }],
      develop: [{ writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Hello, world';\n" }], text: '変更しました' }],
      review: [{ output: { verdict: 'needs_fix', summary: '方針が決まっていない', blockers: ['仕様が未決'], nits: [], criteria: [], needs_design_decision: true } }],
      materials: [{ output: { markdown: MAT() } }],
    });
    addIssue(26);
    const runId = await startIssue(26);
    const ap = await waitFor(() => pendingPublish(s.db, runId));
    expect(ap.payload.kind).toBe('materials');
    expect(fake.counts()).toMatchObject({ develop: 1, review: 1, materials: 1 });
    // PR の無い Run は、コミット済みの変更も捨てて起点に戻す（資料の「現状」を AI の途中の変更で書かない）
    const wt = join(dataRoot, 'worktrees', runId);
    expect(git(wt, 'show', 'HEAD:src/greet.ts')).toBe("export const greet = () => 'Hello';");
    expect(git(wt, 'status', '--porcelain')).toBe('');
    await decidePublish(s.db, req, runId, 'reject');
    await waitStatus(runId, 'cancelled');
  });

  it('Issue の無い Run は、計画が materials でも実装し、設計の判断が要れば needs_input にする', async () => {
    fake.setScenario({
      plan: [{ output: PLAN('materials') }],
      develop: [{ writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Hi';\n" }], text: 'NEEDS_DESIGN_DECISION: 文言が決まっていない' }],
    });
    const [ws] = await s.db.select().from(workspaces);
    const run = await s.engine.createRun({
      workspaceId: ws.id,
      projectId: binding.projectId,
      title: '手で頼んだ依頼',
      request: '一覧の並び順をどうするか検討したい',
      source: { type: 'manual' },
      maxRevisionAttempts: 3,
      budgetLimitUsd: 5,
      runtime: 'claude_code',
    });
    const r = await waitStatus(run.id, 'needs_input', 'failed', 'completed');
    expect(r.status).toBe('needs_input');
    const [ap] = await s.db.select().from(approvals).where(and(eq(approvals.runId, run.id), eq(approvals.status, 'pending')));
    expect(ap.actionType).toBe('clarification');
    expect(ap.payload.reason).toBe('needs_design_decision');
    expect(fake.counts().materials).toBeUndefined();
    expect((await stepsOf(run.id)).map((st) => st.key)).toEqual(['plan', 'implement']);
    await s.engine.cancelRun(run.id, 'test');
  });
});
