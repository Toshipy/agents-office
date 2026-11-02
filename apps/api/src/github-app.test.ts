/**
 * GitHub App 連携の検証。本物の GitHub の代わりに、
 *  - GitHub REST API のモック（JWT の RS256 署名と Installation token を検証する HTTP サーバー）
 *  - リモートとして使う git の bare リポジトリ（clone_url をこのパスにする）
 *  - 偽の claude CLI（サブスク実行基盤）
 * を使い、実際の GitHub と同じ形式の署名付き Webhook から Draft PR・レビュー・マージまでを通す。
 * 本物の GitHub での動作（App の権限設定・Draft PR がプランで使えるか等）はこのテストでは確認できない。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createVerify, generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { defaultClaudeCodeConfig, loadConfig } from './config';
import { createApp, createServices, type Services } from './app';
import { runs, webhookDeliveries } from './db/schema';
import { signGithubPayload } from './github/webhook';
import { installFakeClaude } from './testing/fakeClaude';

const tmp = mkdtempSync(join(tmpdir(), 'paw-gh-'));
const dataRoot = join(tmp, 'data');
const origin = join(tmp, 'origin.git');
const WEBHOOK_SECRET = 'gh-test-webhook-secret';
const APP_ID = '123456';
const INSTALLATION_ID = 4242;
const REPO_ID = 777001;
const FULL_NAME = 'toshipy/demo';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let s: Services;
let app: ReturnType<typeof createApp>;
let cookie = '';
let projectId = '';
let api: Server;
let apiUrl = '';
const fake = installFakeClaude(join(tmp, 'stub'));

/* ------------------------------------------------------------------ */
/* GitHub REST API のモック                                             */
/* ------------------------------------------------------------------ */

const requests: { method: string; path: string; auth: string; body: any }[] = [];
const issuedTokens = new Set<string>();
const pulls: any[] = [];


/* 操作系（Issue・ラベル・アサイン・PR・レビュー）のモック。状態は ops.* に持つ */
const ops = {
  issues: [] as any[],
  labelEvents: [] as any[],
  openPulls: [] as any[],
  handle(method: string, path: string, rawUrl: string, body: any, send: (s: number, j: unknown) => void, needInstallation: () => boolean): boolean {
    const q = new URL(rawUrl, 'http://x').searchParams;
    const page = Number(q.get('page') ?? '1');
    const per = Number(q.get('per_page') ?? '30');
    const slice = (a: any[]) => a.slice((page - 1) * per, page * per);
    const base = `/repos/${FULL_NAME}`;
    let m: RegExpMatchArray | null;
    if (method === 'GET' && path === `${base}/issues`) {
      if (!needInstallation()) return true;
      const label = q.get('labels');
      send(200, slice(ops.issues.filter((i) => !label || i.labels.some((l: any) => l.name === label))));
      return true;
    }
    if (method === 'GET' && (m = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/))) {
      if (!needInstallation()) return true;
      const i = ops.issues.find((x) => x.number === Number(m![1]));
      send(i ? 200 : 404, i ?? { message: 'Not Found' });
      return true;
    }
    if (method === 'GET' && (m = path.match(/\/issues\/(\d+)\/comments$/))) {
      if (!needInstallation()) return true;
      send(200, slice([{ id: 1, body: 'c', user: { login: 'toshipy', type: 'User' }, created_at: '2026-01-01T00:00:00Z' }, { id: 2, body: 'b', user: { login: 'bot[bot]', type: 'Bot' }, created_at: '2026-01-02T00:00:00Z' }]));
      return true;
    }
    if (method === 'GET' && (m = path.match(/\/issues\/(\d+)\/events$/))) {
      if (!needInstallation()) return true;
      send(200, slice(ops.labelEvents));
      return true;
    }
    if (method === 'POST' && /\/issues\/\d+\/(labels|assignees)$/.test(path)) {
      if (!needInstallation()) return true;
      send(200, {});
      return true;
    }
    if (method === 'DELETE' && /\/issues\/\d+\/labels\/not-there$/.test(path)) {
      if (!needInstallation()) return true;
      send(404, { message: 'Label does not exist' });
      return true;
    }
    if (method === 'DELETE' && /\/issues\/\d+\/(labels\/[^/]+|assignees)$/.test(path)) {
      if (!needInstallation()) return true;
      send(200, {});
      return true;
    }
    if (method === 'GET' && path === `${base}/pulls`) {
      if (!needInstallation()) return true;
      const head = q.get('head');
      send(200, ops.openPulls.filter((p) => p.head.label === head));
      return true;
    }
    if (method === 'GET' && (m = path.match(/\/pulls\/(\d+)$/))) {
      if (!needInstallation()) return true;
      send(200, { state: 'closed', merged: true, head: { sha: 'abc123' } });
      return true;
    }
    if (method === 'GET' && /\/pulls\/\d+\/reviews$/.test(path)) {
      if (!needInstallation()) return true;
      send(200, slice([{ id: 9, state: 'APPROVED', body: 'ok', user: { login: 'toshipy' }, commit_id: 'abc123' }]));
      return true;
    }
    return false;
  },
};

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
}

function verifyAppJwt(auth: string): boolean {
  const token = auth.replace(/^Bearer /, '');
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return false;
  const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'));
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  return ok && payload.iss === APP_ID && payload.exp > now && payload.iat <= now;
}

async function readBody(req: IncomingMessage) {
  let raw = '';
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : null;
}

function startMockGithub(): Promise<void> {
  api = createServer(async (req, res) => {
    const body = await readBody(req);
    const auth = String(req.headers.authorization ?? '');
    const path = (req.url ?? '').replace(/\?.*$/, '');
    requests.push({ method: req.method!, path, auth, body });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    const needApp = () => (verifyAppJwt(auth) ? true : (send(401, { message: 'Bad credentials' }), false));
    const needInstallation = () => (issuedTokens.has(auth.replace(/^Bearer /, '')) ? true : (send(401, { message: 'Bad credentials' }), false));
    if (req.method === 'POST' && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      if (!needApp()) return;
      const token = `ghs_${randomUUID().replace(/-/g, '')}`;
      issuedTokens.add(token);
      return send(201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (req.method === 'GET' && path === `/repos/${FULL_NAME}/installation`) {
      if (!needApp()) return;
      return send(200, { id: INSTALLATION_ID, account: { login: 'toshipy' } });
    }
    if (req.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) {
      if (!needApp()) return;
      return send(404, { message: 'Not Found' });
    }
    if (req.method === 'GET' && path === '/app/installations') {
      if (!needApp()) return;
      return send(200, [{ id: INSTALLATION_ID, account: { login: 'toshipy' } }]);
    }
    if (req.method === 'GET' && path === '/installation/repositories') {
      if (!needInstallation()) return;
      return send(200, { repositories: [{ id: REPO_ID, full_name: FULL_NAME, private: true }] });
    }
    if (req.method === 'GET' && path === `/repos/${FULL_NAME}`) {
      if (!needInstallation()) return;
      return send(200, { id: REPO_ID, full_name: FULL_NAME, default_branch: 'main', clone_url: origin, html_url: `https://github.com/${FULL_NAME}`, private: true });
    }
    if (path.startsWith(`/repos/${FULL_NAME}/issues`) || path.startsWith(`/repos/${FULL_NAME}/pulls`)) {
      const handled = ops.handle(req.method!, path, req.url ?? '', body, send, needInstallation);
      if (handled) return;
    }
    if (req.method === 'POST' && path === `/repos/${FULL_NAME}/pulls`) {
      if (!needInstallation()) return;
      // push 済みのブランチだけ PR にできる（実 GitHub と同じく、無ければ 422）
      let sha = '';
      try {
        sha = git(origin, 'rev-parse', `refs/heads/${body.head}`);
      } catch {
        return send(422, { message: 'Validation Failed', errors: [{ message: `head ${body.head} not found` }] });
      }
      const number = 12 + pulls.length;
      pulls.push({ ...body, number });
      return send(201, { number, html_url: `https://github.com/${FULL_NAME}/pull/${number}`, draft: body.draft === true, head: { sha } });
    }
    send(404, { message: 'Not Found' });
  });
  return new Promise((resolve) => api.listen(0, '127.0.0.1', () => {
    const a = api.address();
    apiUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    resolve();
  }));
}

/* ------------------------------------------------------------------ */

async function req(method: string, path: string, body?: unknown) {
  const r = await app.request(path, {
    method,
    headers: { cookie, 'x-paw-client': 'web', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as any };
}

async function webhook(event: string, payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  const deliveryId = randomUUID();
  const r = await app.request('/integrations/github/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signGithubPayload(WEBHOOK_SECRET, raw),
    },
    body: raw,
  });
  // 受信 API は受け付け後に非同期で Dispatcher を動かすため、処理済みになるまで待つ
  const d = r.status === 202
    ? await waitFor(async () => {
        const [row] = await s.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, deliveryId));
        return row?.processedAt ? row : null;
      })
    : null;
  return { status: r.status, outcome: d?.outcome ?? null };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 25000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await s.dispatcher.drain();
    await s.engine.tick();
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const runRow = async (id: string) => (await s.db.select().from(runs).where(eq(runs.id, id)))[0];
const waitStatus = (id: string, ...st: string[]) => waitFor(async () => (st.includes((await runRow(id)).status) ? runRow(id) : null));

const repository = { id: REPO_ID, full_name: FULL_NAME };
const installation = { id: INSTALLATION_ID };
const issuePayload = (sender: string, number = 5) => ({
  action: 'labeled',
  label: { name: 'ai:ready' },
  issue: {
    number,
    title: 'greet の文言を変更',
    body: 'greet() が Hello, world を返すようにしてください',
    labels: [{ name: 'ai:ready' }],
    html_url: `https://github.com/${FULL_NAME}/issues/${number}`,
    user: { login: sender },
  },
  repository,
  installation,
  sender: { login: sender },
});
const reviewPayload = (login: string, state: string, commitId: string, prNumber: number, body = '') => ({
  action: 'submitted',
  review: { state, body, commit_id: commitId, user: { login } },
  pull_request: { number: prNumber, head: { sha: commitId } },
  repository,
  installation,
  sender: { login },
});

const PLAN = {
  summary: 'greet の文言を変更する',
  approach: ['src/greet.ts を変更する'],
  files_to_change: ['src/greet.ts'],
  acceptance_criteria: ['greet() が Hello, world を返す'],
  risks: [],
  needs_human_decision: false,
  questions: [],
  dangerous_operations: [],
};
const REVIEW = { verdict: 'ready_for_draft_pr', summary: '問題なし', blockers: [], nits: [], criteria: [] };

beforeAll(async () => {
  // リモート（GitHub の代わり）の bare リポジトリ
  const seed = join(tmp, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  writeFileSync(join(seed, 'README.md'), '# demo\n');
  writeFileSync(join(seed, 'src/greet.ts'), "export const greet = () => 'Hello';\n");
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin]);
  await startMockGithub();

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
      githubWebhookSecret: WEBHOOK_SECRET,
      githubApp: { appId: APP_ID, privateKeyPem: pem, apiUrl, allowedUsers: ['toshipy'] },
      testTimeoutMs: 30_000,
    }),
  );
  app = createApp(s);
  const r = await app.request('/v1/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paw-client': 'web' },
    body: JSON.stringify({ username: 'owner', displayName: 'Owner', password: 'password-1234' }),
  });
  cookie = r.headers.get('set-cookie')!.split(';')[0];
  projectId = (await req('POST', '/v1/projects', { name: 'Demo', color: '#38e1ff' })).body.id;
});

afterAll(async () => {
  await s.engine.stop();
  await s.client.close();
  await new Promise((r) => api.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

describe('GitHub App integration (mock GitHub API + bare repo)', () => {
  it('connects only repositories where the App is installed, using the real repository id and default branch', async () => {
    const missing = await req('POST', `/v1/projects/${projectId}/repositories`, { fullName: 'someone/else' });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('GITHUB_APP_NOT_INSTALLED');

    const ok = await req('POST', `/v1/projects/${projectId}/repositories`, { fullName: FULL_NAME });
    expect(ok.status).toBe(201);
    expect(ok.body.repository).toMatchObject({
      fullName: FULL_NAME,
      installationId: INSTALLATION_ID,
      repositoryId: REPO_ID,
      verification: 'github_app',
      defaultBranch: 'main',
      managedCheckout: true,
      localPath: null,
      runtime: 'claude_code',
      automationEnabled: false,
    });
    // パスは指定できない（サーバーの管理クローンを使う）。テストコマンドだけ設定できる
    expect((await req('PUT', `/v1/projects/${projectId}/local-repo`, { localPath: tmp, testCommand: null })).body.code).toBe('MANAGED_CHECKOUT');
    expect((await req('PUT', `/v1/projects/${projectId}/local-repo`, { localPath: null, testCommand: 'git status --short' })).status).toBe(200);

    const inst = await req('GET', '/v1/integrations/github/installations');
    expect(inst.body.mode).toBe('github_app');
    expect(inst.body.installations[0].repositories[0]).toMatchObject({ fullName: FULL_NAME, projectId });

    // App の JWT は RS256 で署名され、モック側で公開鍵による検証に通っている
    expect(requests.some((r) => r.path === `/repos/${FULL_NAME}/installation` && verifyAppJwt(r.auth))).toBe(true);
  });

  it('starts a run only from allowed users, pushes an ai/ branch and opens a Draft PR, then handles review and merge', async () => {
    const auto = await req('PUT', `/v1/projects/${projectId}/automation-policy`, { enabled: true, triggerLabel: 'ai:ready', events: ['issues.opened', 'issues.labeled'], maxRevisionAttempts: 3 });
    expect(auto.status).toBe(200);
    fake.setScenario({
      plan: [{ output: PLAN }],
      develop: [
        { writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Hello, world';\n" }], text: 'greet を変更しました' },
        { writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Hello, world!';\n" }], text: '指摘に合わせて ! を追加しました' },
      ],
      review: [{ output: REVIEW }],
    });

    // 許可していない GitHub ユーザーの Issue では動かない（公開リポジトリ対策）
    expect((await webhook('issues', issuePayload('stranger', 4))).outcome).toBe('sender_not_allowed');
    expect((await s.db.select().from(runs)).length).toBe(0);

    const accepted = await webhook('issues', issuePayload('toshipy'));
    expect(accepted.status).toBe(202);
    expect(accepted.outcome).toBe('run_created');
    const [created] = await s.db.select().from(runs);
    expect(created.runtime).toBe('claude_code');
    const run = await waitStatus(created.id, 'waiting_review', 'failed');
    expect(run.status).toBe('waiting_review');

    // GitHub（bare リポジトリ）に ai/ ブランチが push され、Draft PR が作られている
    const branch = run.pr!.branch;
    expect(branch).toMatch(/^ai\/run-/);
    const remoteSha = git(origin, 'rev-parse', `refs/heads/${branch}`);
    expect(run.pr!.headSha).toBe(remoteSha);
    expect(git(origin, 'show', `${branch}:src/greet.ts`)).toContain('Hello, world');
    expect(git(origin, 'show', 'main:src/greet.ts')).toContain("'Hello'"); // main は変更しない
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ head: branch, base: 'main', draft: false, title: '#5 greet の文言を変更' });
    expect(pulls[0].body).toContain('関連 Issue: #5');
    expect(run.pr!.url).toBe(`https://github.com/${FULL_NAME}/pull/12`);

    // トークンを残さない: 管理クローンの remote URL・git 設定に資格情報が無い。Claude Code には GitHub のトークンを渡さない
    const managed = join(dataRoot, 'repos', String(REPO_ID));
    const gitConfig = readFileSync(join(managed, '.git', 'config'), 'utf8');
    for (const t of issuedTokens) expect(gitConfig).not.toContain(t);
    expect(gitConfig).not.toContain('x-access-token');
    expect(statSync(join(dataRoot, 'git-askpass.sh')).mode & 0o777).toBe(0o700);
    for (const c of fake.calls()) {
      expect(c.envKeys).not.toContain('PAW_GIT_ASKPASS_TOKEN');
      expect(c.envKeys).not.toContain('GIT_ASKPASS');
    }

    // 許可していないユーザーのレビューは無視
    expect((await webhook('pull_request_review', reviewPayload('stranger', 'changes_requested', remoteSha, 12, 'やり直して'))).outcome).toBe('reviewer_not_allowed');
    expect((await runRow(run.id)).status).toBe('waiting_review');

    // 所有者の Request changes → 同じ PR を修正（新しい PR は作らない）
    expect((await webhook('pull_request_review', reviewPayload('toshipy', 'changes_requested', remoteSha, 12, '末尾に ! を付けて'))).outcome).toBe('revision_started');
    const revised = await waitFor(async () => {
      const r = await runRow(run.id);
      return r.status === 'waiting_review' && r.revisionCount === 1 ? r : null;
    });
    const newSha = git(origin, 'rev-parse', `refs/heads/${branch}`);
    expect(newSha).not.toBe(remoteSha);
    expect(revised.pr!.headSha).toBe(newSha);
    expect(revised.pr!.number).toBe(12);
    expect(pulls).toHaveLength(1);
    expect(git(origin, 'show', `${branch}:src/greet.ts`)).toContain('Hello, world!');

    // 人が GitHub でマージ → Run は完了（AI はマージしない）
    const merged = await webhook('pull_request', { action: 'closed', pull_request: { number: 12, merged: true }, repository, installation, sender: { login: 'toshipy' } });
    expect(merged.outcome).toBe('run_completed_merged');
    expect((await runRow(run.id)).status).toBe('completed');
    expect(requests.some((r) => r.path.includes('/merge'))).toBe(false);
  });

  it('cancels the run when the PR is closed without merging, and rejects forged webhooks', async () => {
    fake.setScenario({ plan: [{ output: PLAN }], develop: [{ writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Hi';\n" }] }], review: [{ output: REVIEW }] });
    await webhook('issues', issuePayload('toshipy', 6));
    const run = await waitFor(async () => (await s.db.select().from(runs)).find((r) => r.issueKey === `${REPO_ID}#6` && r.status === 'waiting_review'));
    const closed = await webhook('pull_request', { action: 'closed', pull_request: { number: run.pr!.number, merged: false }, repository, installation, sender: { login: 'toshipy' } });
    expect(closed.outcome).toBe('run_cancelled_pr_closed');
    expect((await runRow(run.id)).status).toBe('cancelled');

    const raw = JSON.stringify(issuePayload('toshipy', 7));
    const forged = await app.request('/integrations/github/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signGithubPayload('wrong-secret', raw) },
      body: raw,
    });
    expect(forged.status).toBe(401);
  });

  it('keeps the managed clone fetched from GitHub and never uses a token in argv-visible remote URLs', () => {
    const managed = join(dataRoot, 'repos', String(REPO_ID));
    expect(existsSync(join(managed, '.git'))).toBe(true);
    expect(git(managed, 'remote', 'get-url', 'origin')).toBe(origin);
  });
});

describe('GitHubApp の操作系 API', () => {
  const gh = () => s.github!;
  const mkIssue = (n: number, extra: Record<string, unknown> = {}) => ({
    number: n, title: `t${n}`, body: null, html_url: `https://github.com/${FULL_NAME}/issues/${n}`,
    labels: [{ name: 'agents-office' }], assignees: [{ login: 'toshipy' }], updated_at: '2026-01-01T00:00:00Z', ...extra,
  });

  it('Issue 一覧は 2 ページ分を集め、PR を除く', async () => {
    ops.issues = [...Array.from({ length: 150 }, (_, i) => mkIssue(i + 1)), mkIssue(999, { pull_request: { url: 'x' } })];
    const all = await gh().listOpenIssues(INSTALLATION_ID, FULL_NAME);
    expect(all.length).toBe(150);
    expect(all[0]).toMatchObject({ number: 1, body: '', labels: ['agents-office'], assignees: ['toshipy'], updatedAt: '2026-01-01T00:00:00Z' });
    expect((await gh().listIssuesWithLabel(INSTALLATION_ID, FULL_NAME, 'agents-office')).length).toBe(150);
    expect((await gh().getIssue(INSTALLATION_ID, FULL_NAME, 3)).number).toBe(3);
  });

  it('コメント・最新の labeled・ラベル/アサイン操作', async () => {
    const comments = await gh().listIssueComments(INSTALLATION_ID, FULL_NAME, 7);
    expect(comments.map((c) => c.userType)).toEqual(['User', 'Bot']);
    ops.labelEvents = [
      { event: 'labeled', label: { name: 'agents-office' }, actor: { login: 'old' }, created_at: '2026-01-01T00:00:00Z' },
      { event: 'labeled', label: { name: 'other' }, actor: { login: 'x' }, created_at: '2026-01-02T00:00:00Z' },
      { event: 'labeled', label: { name: 'agents-office' }, actor: { login: 'toshipy' }, created_at: '2026-01-03T00:00:00Z' },
      { event: 'commented', actor: { login: 'y' }, created_at: '2026-01-04T00:00:00Z' },
    ];
    expect((await gh().lastLabeled(INSTALLATION_ID, FULL_NAME, 7, 'agents-office'))?.login).toBe('toshipy');
    expect(await gh().lastLabeled(INSTALLATION_ID, FULL_NAME, 7, 'none')).toBeNull();
    await gh().addLabels(INSTALLATION_ID, FULL_NAME, 7, ['needs-human']);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', body: { labels: ['needs-human'] } });
    await gh().removeLabel(INSTALLATION_ID, FULL_NAME, 7, 'not-there'); // 404 でも投げない
    await gh().addAssignees(INSTALLATION_ID, FULL_NAME, 7, ['toshipy']);
    expect(requests.at(-1)!.body).toEqual({ assignees: ['toshipy'] });
    await gh().removeAssignees(INSTALLATION_ID, FULL_NAME, 7, ['toshipy']);
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', body: { assignees: ['toshipy'] } });
  });

  it('PR の作成は通常 PR。既存 PR の検索・取得・レビュー一覧', async () => {
    // push 済みブランチが無いと 422（モックの仕様）なので、先に bare にブランチを作る
    git(origin, 'branch', 'ai/run-x', 'main');
    const made = await gh().createPullRequest(INSTALLATION_ID, FULL_NAME, { title: 't', head: 'ai/run-x', base: 'main', body: 'b' });
    expect(requests.at(-1)!.body.draft).toBe(false);
    ops.openPulls = [{ number: made.number, html_url: made.htmlUrl, head: { label: 'toshipy:ai/run-x', sha: made.headSha }, draft: false }];
    expect(await gh().findOpenPullByHead(INSTALLATION_ID, FULL_NAME, 'ai/run-x')).toMatchObject({ number: made.number });
    expect(await gh().findOpenPullByHead(INSTALLATION_ID, FULL_NAME, 'ai/none')).toBeNull();
    expect(await gh().getPull(INSTALLATION_ID, FULL_NAME, made.number)).toEqual({ state: 'closed', merged: true, headSha: 'abc123' });
    expect(await gh().listReviews(INSTALLATION_ID, FULL_NAME, made.number)).toEqual([{ id: 9, state: 'APPROVED', body: 'ok', user: 'toshipy', commitId: 'abc123' }]);
  });
});
