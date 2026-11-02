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
import { approvals, artifacts, runSteps, runs, webhookDeliveries } from './db/schema';
import { signGithubPayload } from './github/webhook';
import { installFakeClaude } from './testing/fakeClaude';
import { decidePublish, pendingPublish, waitStatusApprovingWith } from './testing/publishApproval';

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
/** 'flaky' のとき、1 回目の PR 作成は PR を作ってから 502 を返し、以降は 422（既存 PR あり）を返す */
const prMock = { mode: 'normal' as 'normal' | 'flaky', posts: 0 };


/* 操作系（Issue・ラベル・アサイン・PR・レビュー）のモック。状態は ops.* に持つ */
const ops = {
  issues: [] as any[],
  labelEvents: [] as any[],
  openPulls: [] as any[],
  /** アサインされた Issue 番号（取り直した Issue に自分の担当を反映する） */
  assigned: new Set<number>(),
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
      const n = Number(m![1]);
      const i = ops.issues.find((x) => x.number === n);
      // Webhook から来る Issue は ops.issues に無いので、IssueIntake が取り直す分は同じ内容を返す
      send(200, i ?? { number: n, title: 'greet の文言を変更', body: 'greet() が Hello, world を返すようにしてください', html_url: `https://github.com/${FULL_NAME}/issues/${n}`, labels: [{ name: 'agents-office' }], assignees: ops.assigned.has(n) ? [{ login: 'toshipy' }] : [], updated_at: '2026-01-01T00:00:00Z' });
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
      if (path.endsWith('/assignees')) ops.assigned.add(Number(path.match(/\/issues\/(\d+)\//)![1]));
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
      prMock.posts += 1;
      if (prMock.mode === 'flaky' && prMock.posts > 1) {
        return send(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for toshipy:' + body.head }] });
      }
      const number = 12 + pulls.length;
      pulls.push({ ...body, number });
      if (prMock.mode === 'flaky') {
        ops.openPulls.push({ number, html_url: `https://github.com/${FULL_NAME}/pull/${number}`, head: { label: `toshipy:${body.head}`, sha }, draft: false });
        return send(502, { message: 'Bad Gateway' });
      }
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
/** publish 承認（GitHub への書き込みの前の人の承認）を承認しながら、指定の状態まで待つ */
const waitStatusApproving = (id: string, ...st: string[]) => waitStatusApprovingWith(s.db, req, waitFor, runRow)(id, ...st);
const branchOf = (runId: string) => `ai/run-${runId.slice(4, 14).toLowerCase()}`;
/** bare リポジトリ（GitHub の代わり）にそのブランチが push されているか */
const remoteHasBranch = (branch: string) => git(origin, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`) !== '';
/** Issue から agents-office ラベルを外す要求の数 */
const labelRemovals = (n: number) => requests.filter((r) => r.method === 'DELETE' && r.path === `/repos/${FULL_NAME}/issues/${n}/labels/agents-office`).length;
const assigneeRemovals = (n: number) => requests.filter((r) => r.method === 'DELETE' && r.path === `/repos/${FULL_NAME}/issues/${n}/assignees`).length;
const pullPosts = () => requests.filter((r) => r.method === 'POST' && r.path === `/repos/${FULL_NAME}/pulls`).length;

const repository = { id: REPO_ID, full_name: FULL_NAME };
const installation = { id: INSTALLATION_ID };
const issuePayload = (sender: string, number = 5) => ({
  action: 'labeled',
  label: { name: 'agents-office' },
  issue: {
    number,
    title: 'greet の文言を変更',
    body: 'greet() が Hello, world を返すようにしてください',
    labels: [{ name: 'agents-office' }],
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
  mode: 'implement',
  mode_reason: 'コードの変更で完了できる',
};
const REVIEW = { verdict: 'ready_for_draft_pr', summary: '問題なし', blockers: [], nits: [], criteria: [], needs_design_decision: false };

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
      githubWebhookEnabled: true,
      githubApp: { appId: APP_ID, privateKeyPem: pem, apiUrl, allowedUsers: ['toshipy'] },
      githubLogin: 'toshipy',
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

// publish 承認を挟むぶん長くなるため、並列実行で遅くなっても切れない上限にする
describe('GitHub App integration (mock GitHub API + bare repo)', { timeout: 30_000 }, () => {
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
    const auto = await req('PUT', `/v1/projects/${projectId}/automation-policy`, { enabled: true, triggerLabel: 'agents-office', events: ['issues.opened', 'issues.labeled'], maxRevisionAttempts: 3 });
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

    // AI レビューが通っても、publish 承認の前は GitHub に書かない（push も PR 作成もしない）
    const paused = await waitStatus(created.id, 'needs_input', 'failed', 'waiting_review');
    expect(paused.status).toBe('needs_input');
    expect(pullPosts()).toBe(0);
    expect(remoteHasBranch(branchOf(created.id))).toBe(false);
    const ap = await pendingPublish(s.db, created.id);
    expect(ap!.payload).toMatchObject({ kind: 'pull_request', title: '#5 greet の文言を変更', update: false });
    expect(String(ap!.payload.body).split('\n')[0]).toBe('Closes #5');
    // 終わりのラベル操作は承認に載せ、承認の前には外さない
    expect(ap!.payload.labels).toEqual({ remove: ['agents-office'], add: [] });
    expect(labelRemovals(5)).toBe(0);
    await decidePublish(s.db, req, created.id);

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
    expect(pulls[0].body.split('\n')[0]).toBe('Closes #5');
    expect(pulls[0].body).toContain('この PR は agents-office が作りました。マージは人が行います。');
    expect(run.pr!.url).toBe(`https://github.com/${FULL_NAME}/pull/12`);
    // PR を作った後に agents-office だけ外す（アサインは残す）
    expect(labelRemovals(5)).toBe(1);
    expect(assigneeRemovals(5)).toBe(0);

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
      // 修正後の PR 更新も publish 承認を通る
      if (r.status === 'needs_input') await decidePublish(s.db, req, run.id);
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
    // PR の更新では何も変えず、マージで完了した Run は片付け直さない
    expect(labelRemovals(5)).toBe(1);
    expect(assigneeRemovals(5)).toBe(0);
  });

  it('PR 作成の再試行で既存の PR を使い、422 で失敗しない', async () => {
    fake.setScenario({ plan: [{ output: PLAN }], develop: [{ writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Hey';\n" }] }], review: [{ output: REVIEW }] });
    const before = pulls.length;
    prMock.mode = 'flaky';
    prMock.posts = 0;
    try {
      await webhook('issues', issuePayload('toshipy', 8));
      const run = await waitStatusApproving((await waitFor(async () => (await s.db.select().from(runs)).find((r) => r.issueKey === `${REPO_ID}#8`))).id, 'waiting_review', 'failed');
      expect(run.status).toBe('waiting_review');
      expect(pulls.length - before).toBe(1);
      const made = pulls[pulls.length - 1];
      expect(made.draft).toBe(false);
      expect(made.body.split('\n')[0]).toBe('Closes #8');
      expect(run.pr!.number).toBe(made.number);
      expect(run.pr!.draft).toBe(false);
    } finally {
      prMock.mode = 'normal';
      // flaky の PR 作成が積んだ open PR を残さない（後続のテストを決定的にする）
      ops.openPulls = [];
    }
  });

  /** 人が GitHub の ai/ ブランチに 1 コミット足す（bare リポジトリへ plain git で push） */
  function humanPush(branch: string, file: string, content: string) {
    const work = join(tmp, `human-${randomUUID()}`);
    execFileSync('git', ['clone', '-q', '-b', branch, origin, work]);
    writeFileSync(join(work, file), content);
    git(work, 'add', '-A');
    git(work, '-c', 'user.name=Human', '-c', 'user.email=human@example.com', 'commit', '-q', '-m', 'human fix');
    git(work, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
    return git(work, 'rev-parse', 'HEAD');
  }

  async function runToReview(issue: number) {
    await webhook('issues', issuePayload('toshipy', issue));
    const created = await waitFor(async () => (await s.db.select().from(runs)).find((r) => r.issueKey === `${REPO_ID}#${issue}`));
    return waitStatusApproving(created.id, 'waiting_review', 'failed');
  }

  it('人が ai/ ブランチに足したコミットを取り込んでから修正し、PR を更新する', async () => {
    fake.setScenario({
      plan: [{ output: PLAN }],
      develop: [
        { writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Yo';\n" }] },
        { writes: [{ path: 'src/greet2.ts', content: "export const greet2 = () => 'Yo!';\n" }] },
      ],
      review: [{ output: REVIEW }],
    });
    const run = await runToReview(9);
    expect(run.status).toBe('waiting_review');
    const branch = run.pr!.branch;
    const humanSha = humanPush(branch, 'src/human.ts', 'export const human = 1;\n');
    expect((await webhook('pull_request_review', reviewPayload('toshipy', 'changes_requested', run.pr!.headSha, run.pr!.number, '追加して'))).outcome).toBe('revision_started');
    const revised = await waitFor(async () => {
      const r = await runRow(run.id);
      if (r.status === 'needs_input') await decidePublish(s.db, req, run.id);
      return r.status === 'waiting_review' && r.revisionCount === 1 ? r : (r.status === 'failed' ? r : null);
    });
    expect(revised.status).toBe('waiting_review');
    const newSha = git(origin, 'rev-parse', `refs/heads/${branch}`);
    expect(revised.pr!.headSha).toBe(newSha);
    expect(git(origin, 'rev-parse', `${newSha}^`)).toBe(humanSha);
    expect(git(origin, 'show', `${branch}:src/human.ts`)).toContain('human');
    expect(git(origin, 'show', `${branch}:src/greet2.ts`)).toContain('Yo!');
  });

  it('人のコミットと worktree のコミットが分岐したら、Run を needs_input にして判断を求める', async () => {
    fake.setScenario({
      plan: [{ output: PLAN }],
      develop: [{ writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Sup';\n" }] }],
      review: [{ output: REVIEW }],
    });
    const run = await runToReview(10);
    expect(run.status).toBe('waiting_review');
    const branch = run.pr!.branch;
    // 人が履歴を書き換えた（ai/ の先頭を main から作り直して別のコミットを置く）→ AI の履歴とは分岐する
    const work = join(tmp, `human-${randomUUID()}`);
    execFileSync('git', ['clone', '-q', '-b', 'main', origin, work]);
    writeFileSync(join(work, 'other.txt'), 'diverged\n');
    git(work, 'add', '-A');
    git(work, '-c', 'user.name=Human', '-c', 'user.email=human@example.com', 'commit', '-q', '-m', 'diverge');
    git(work, 'push', '-q', '--force', 'origin', `HEAD:refs/heads/${branch}`);
    const headBefore = git(origin, 'rev-parse', `refs/heads/${branch}`);
    expect((await webhook('pull_request_review', reviewPayload('toshipy', 'changes_requested', run.pr!.headSha, run.pr!.number, '直して'))).outcome).toBe('revision_started');
    const paused = await waitStatus(run.id, 'needs_input', 'failed', 'waiting_review');
    expect(paused.status).toBe('needs_input');
    const [ap] = (await s.db.select().from(approvals)).filter((a) => a.runId === run.id && a.status === 'pending');
    expect(ap.actionType).toBe('clarification');
    expect(ap.payload.reason).toBe('branch_diverged');
    // 人のブランチは壊していない
    expect(git(origin, 'rev-parse', `refs/heads/${branch}`)).toBe(headBefore);

    // 回復: 人が GitHub 側を Run の履歴から早送りできる形に直して「続行」→ 同じ工程から再開して waiting_review に戻る
    const work2 = join(tmp, `human-${randomUUID()}`);
    execFileSync('git', ['clone', '-q', origin, work2]);
    git(work2, 'fetch', '-q', 'origin', run.pr!.headSha);
    git(work2, 'checkout', '-q', '-B', 'fix', run.pr!.headSha);
    writeFileSync(join(work2, 'recovered.txt'), 'ok\n');
    git(work2, 'add', '-A');
    git(work2, '-c', 'user.name=Human', '-c', 'user.email=human@example.com', 'commit', '-q', '-m', 'recover');
    git(work2, 'push', '-q', '--force', 'origin', `HEAD:refs/heads/${branch}`);
    const recoveredSha = git(work2, 'rev-parse', 'HEAD');
    const done = await req('POST', `/v1/approvals/${ap.id}/decision`, { decision: 'approve', expectedVersion: ap.version, confirmationDigest: ap.payloadDigest });
    expect(done.status).toBe(200);
    const after = await waitStatusApproving(run.id, 'waiting_review', 'failed');
    expect(after.status).toBe('waiting_review');
    // 人の直した履歴を土台にしたまま（取りこぼし・force push なし）
    expect(git(origin, 'show', `${branch}:recovered.txt`)).toContain('ok');
    expect(git(origin, 'merge-base', '--is-ancestor', recoveredSha, `refs/heads/${branch}`)).toBe('');
  });

  it('承認待ちの間に worktree の HEAD が動いたら、PR の工程は push せず、テストと AI レビューを通してから publish 承認を作り直す', async () => {
    fake.setScenario({ plan: [{ output: PLAN }], develop: [{ writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Howdy';\n" }] }], review: [{ output: REVIEW }] });
    await webhook('issues', issuePayload('toshipy', 11));
    const created = await waitFor(async () => (await s.db.select().from(runs)).find((r) => r.issueKey === `${REPO_ID}#11`));
    expect((await waitStatus(created.id, 'needs_input', 'failed', 'waiting_review')).status).toBe('needs_input');
    const first = (await pendingPublish(s.db, created.id))!;
    const branch = branchOf(created.id);
    // 承認待ちの間に HEAD が動いた状況を作る（承認する前に worktree へ 1 コミット足す）
    const wt = join(dataRoot, 'worktrees', created.id);
    writeFileSync(join(wt, 'late.txt'), 'late\n');
    git(wt, 'add', 'late.txt');
    git(wt, 'commit', '-q', '-m', 'late change');
    const moved = git(wt, 'rev-parse', 'HEAD');
    expect(first.payload.headSha).not.toBe(moved);
    const postsBefore = pullPosts();
    const stepsBefore = await s.db.select().from(runSteps).where(eq(runSteps.runId, created.id));
    const reviewsBefore = fake.counts().review ?? 0;

    await decidePublish(s.db, req, created.id);
    const second = await waitFor(async () => {
      const ap = await pendingPublish(s.db, created.id);
      return ap && ap.id !== first.id ? ap : null;
    });
    // push も PR 作成もせず、動いた後の HEAD でテスト → AI レビューを通してから承認を作り直す（Run は失敗にしない）
    expect(second.payload.headSha).toBe(moved);
    expect((await runRow(created.id)).status).toBe('needs_input');
    expect(remoteHasBranch(branch)).toBe(false);
    expect(pullPosts()).toBe(postsBefore);
    const stepsAfter = await s.db.select().from(runSteps).where(eq(runSteps.runId, created.id));
    const stale = stepsAfter.filter((x) => x.key === 'draft_pr');
    expect(stale.map((x) => x.errorCode)).toEqual(['PUBLISH_STALE']);
    const rerun = stepsAfter.filter((x) => !stepsBefore.some((b) => b.id === x.id) && x.seq > stale[0].seq).sort((a, b) => a.seq - b.seq);
    expect(rerun.map((x) => `${x.key}:${x.status}`)).toEqual(['test:succeeded', 'review:succeeded']);
    expect(fake.counts().review).toBe(reviewsBefore + 1);
    // 作り直した AI レビューは動いた HEAD を見ている
    expect(fake.calls().filter((c) => c.purpose === 'review').at(-1)!.stdin).toContain('late.txt');
    // 作り直した承認にも、承認する差分の成果物が結び付く（人が差分を見ずに承認できないように）
    const diffArtifactId = (second.payload as { diffArtifactId: string | null }).diffArtifactId;
    expect(diffArtifactId).not.toBeNull();
    const [diffRow] = await s.db.select().from(artifacts).where(eq(artifacts.id, diffArtifactId!));
    expect(diffRow.kind).toBe('diff');
    expect(await s.store.read(diffRow)).toContain('late.txt');

    // 作り直した承認を承認すると、その HEAD を push して PR を作る
    await decidePublish(s.db, req, created.id);
    const run = await waitStatus(created.id, 'waiting_review', 'failed');
    expect(run.status).toBe('waiting_review');
    expect(run.pr!.headSha).toBe(moved);
    expect(git(origin, 'rev-parse', `refs/heads/${branch}`)).toBe(moved);
  });

  it('更新の publish 承認待ちの間に人が ai/ ブランチへ push しても、Run を失敗にせず needs_input で判断を求める', async () => {
    fake.setScenario({
      plan: [{ output: PLAN }],
      develop: [
        { writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Hey';\n" }] },
        { writes: [{ path: 'src/greet3.ts', content: "export const greet3 = () => 'Hey!';\n" }] },
      ],
      review: [{ output: REVIEW }],
    });
    const run = await runToReview(12);
    expect(run.status).toBe('waiting_review');
    const branch = run.pr!.branch;
    expect((await webhook('pull_request_review', reviewPayload('toshipy', 'changes_requested', run.pr!.headSha, run.pr!.number, '足して'))).outcome).toBe('revision_started');
    // 修正が終わり、更新の publish 承認を待っている
    const pending = await waitFor(async () => {
      const r = await runRow(run.id);
      if (r.status === 'failed') return r;
      return r.status === 'needs_input' && (await pendingPublish(s.db, run.id)) ? r : null;
    });
    expect(pending.status).toBe('needs_input');
    // その間に人が同じブランチへ push した（前の PR の head の上）
    const humanSha = humanPush(branch, 'src/late-human.ts', 'export const late = 1;\n');
    await decidePublish(s.db, req, run.id);
    const paused = await waitFor(async () => {
      const r = await runRow(run.id);
      if (r.status === 'failed' || r.status === 'waiting_review') return r;
      const ap = (await s.db.select().from(approvals)).find((a) => a.runId === run.id && a.status === 'pending' && a.actionType === 'clarification');
      return r.status === 'needs_input' && ap ? r : null;
    });
    expect(paused.status).toBe('needs_input');
    const [ap] = (await s.db.select().from(approvals)).filter((a) => a.runId === run.id && a.status === 'pending');
    expect(ap.payload.reason).toBe('branch_diverged');
    // 人の push は消していない（強制 push しない）
    expect(git(origin, 'rev-parse', `refs/heads/${branch}`)).toBe(humanSha);
  });

  it('cancels the run when the PR is closed without merging, and rejects forged webhooks', async () => {
    fake.setScenario({ plan: [{ output: PLAN }], develop: [{ writes: [{ path: 'src/greet.ts', content: "export const greet = () => 'Hi';\n" }] }], review: [{ output: REVIEW }] });
    await webhook('issues', issuePayload('toshipy', 6));
    const created = await waitFor(async () => (await s.db.select().from(runs)).find((r) => r.issueKey === `${REPO_ID}#6`));
    const run = await waitStatusApproving(created.id, 'waiting_review');
    const closed = await webhook('pull_request', { action: 'closed', pull_request: { number: run.pr!.number, merged: false }, repository, installation, sender: { login: 'toshipy' } });
    expect(closed.outcome).toBe('run_cancelled_pr_closed');
    expect((await runRow(run.id)).status).toBe('cancelled');
    // PR 作成で 1 回、マージされずに閉じて中止になったときにもう 1 回外す（Issue にコメントは書かない）
    await waitFor(async () => labelRemovals(6) >= 2);
    expect(requests.some((r) => r.method === 'POST' && r.path === `/repos/${FULL_NAME}/issues/6/comments`)).toBe(false);

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
