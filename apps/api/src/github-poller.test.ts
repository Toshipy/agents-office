/**
 * GitHub ポーリング（Webhook の代わり）の検証。モックの GithubApp から合成配信を積み、
 * Dispatcher が Webhook と同じように処理することを確かめる。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadConfig } from './config';
import { createApp, createServices, type Services } from './app';
import { GithubPoller } from './github/poller';
import { IssueIntake } from './github/issueIntake';
import type { GithubApp } from './github/app';
import { repositoryBindings, runs, webhookDeliveries, workspaces } from './db/schema';
import { SimulatedRunner } from './agents/simulated';

const INSTALLATION_ID = 4242;
const REPO_ID = 777001;
const FULL_NAME = 'toshipy/demo';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let s: Services;
let workspaceId = '';
let projectId = '';
let newProject: () => Promise<string>;

/** 呼び出しごとに差し替えられるモック GitHub */
const gh = {
  issues: [] as any[],
  labeledAt: '2026-11-01T01:00:00Z',
  labeledBy: 'toshipy' as string | null,
  pull: { state: 'open' as 'open' | 'closed', merged: false, headSha: 'sha-1' },
  reviews: [] as any[],
  failFor: null as string | null,
  assigned: new Set<number>(),
};
const fakeGithub = {
  listIssuesWithLabel: vi.fn(async (_i: number, full: string) => {
    if (gh.failFor === full) throw new Error('boom');
    return gh.issues;
  }),
  lastLabeled: vi.fn(async () => (gh.labeledBy ? { login: gh.labeledBy, at: gh.labeledAt } : null)),
  getIssue: vi.fn(async (_i: number, _f: string, n: number) => ({ ...(gh.issues.find((i) => i.number === n) ?? { number: n, title: 't', body: 'b', htmlUrl: 'u', labels: ['agents-office'], updatedAt: 'x' }), assignees: gh.assigned.has(n) ? ['toshipy'] : [] })),
  listIssueComments: vi.fn(async () => []),
  addAssignees: vi.fn(async (_i: number, _f: string, n: number) => void gh.assigned.add(n)),
  removeAssignees: vi.fn(async () => undefined),
  addLabels: vi.fn(async () => undefined),
  removeLabel: vi.fn(async () => undefined),
  getPull: vi.fn(async () => gh.pull),
  listReviews: vi.fn(async () => gh.reviews),
} as unknown as GithubApp;

beforeAll(async () => {
  s = await createServices(
    loadConfig({
      dataDir: 'memory',
      simSpeed: 0,
      simRandomFailures: false,
      seedDemo: false,
      logLevel: 'silent',
      githubApp: { appId: '1', privateKeyPem: pem, apiUrl: 'http://127.0.0.1:1', allowedUsers: ['toshipy'] },
      // 実 Issue の Run はシミュレーションでは作らないため、実行基盤は claude_code にし、工程の中身だけシミュレーターで動かす
      agentRuntimeMode: 'claude_code',
      agentRuntime: 'claude_code',
    }),
    { runner: new SimulatedRunner({ randomFailures: false }) },
  );
  // 実 GitHub を向く IssueIntake を、モックの GithubApp を使うものに差し替える
  (s.dispatcher as unknown as { intake: IssueIntake }).intake = new IssueIntake(s.db, s.engine, fakeGithub, 'toshipy');
  const app = createApp(s);
  const r = await app.request('/v1/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paw-client': 'web' },
    body: JSON.stringify({ username: 'owner', displayName: 'Owner', password: 'password-1234' }),
  });
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  newProject = async () => {
    const p = await app.request('/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-paw-client': 'web', cookie },
      body: JSON.stringify({ name: 'Demo', color: '#38e1ff' }),
    });
    return ((await p.json()) as any).id as string;
  };
  projectId = await newProject();
  const [ws] = await s.db.select().from(workspaces);
  workspaceId = ws.id;
  await s.db.insert(repositoryBindings).values({
    id: 'rb_test',
    workspaceId,
    projectId,
    installationId: INSTALLATION_ID,
    repositoryId: REPO_ID,
    fullName: FULL_NAME,
    automationEnabled: true,
    verification: 'github_app',
    localPath: '/nonexistent/paw-managed/777001',
    policy: { triggerLabel: 'agents-office', events: ['issues.labeled'], maxRevisionAttempts: 3 },
  });
});

afterAll(async () => {
  await s.engine.stop();
  await s.client.close();
});

async function waitRun(id: string, status: string) {
  for (let i = 0; i < 100; i++) {
    const [r] = await s.db.select().from(runs).where(eq(runs.id, id));
    if (r?.status === status) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`run ${id} did not reach ${status}`);
}

describe('GithubPoller', () => {
  it('Webhook の受け口は既定では無い', async () => {
    const res = await createApp(s).request('/integrations/github/webhook', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('Issue は 2 回ポーリングしても配信が 1 件で、Run も 1 件', async () => {
    gh.issues = [{ number: 5, title: 'CSV 出力', body: '追加して', htmlUrl: 'https://github.com/toshipy/demo/issues/5', labels: ['agents-office'], assignees: [], updatedAt: 'x' }];
    const poller = new GithubPoller(s.db, fakeGithub, 60_000, 'toshipy');
    await poller.pollOnce();
    await poller.pollOnce();
    const ds = await s.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.provider, 'github_poll'));
    expect(ds).toHaveLength(1);
    expect(ds[0].deliveryId).toBe(`poll:issue:${REPO_ID}:5:2026-11-01T01:00:00Z`);
    expect(ds[0].eventType).toBe('issues');
    expect((ds[0].payload as any).sender.login).toBe('toshipy');
    await s.dispatcher.drain();
    const rs = await s.db.select().from(runs).where(eq(runs.issueKey, `${REPO_ID}#5`));
    expect(rs).toHaveLength(1);
    expect(rs[0].source.type).toBe('github_issue');
  });

  it('ログイン名が null なら Issue から Run を作らない', async () => {
    gh.issues = [{ number: 6, title: 't', body: '', htmlUrl: '', labels: ['agents-office'], assignees: [], updatedAt: 'x' }];
    await new GithubPoller(s.db, fakeGithub, 60_000, null).pollOnce();
    const ds = await s.db.select().from(webhookDeliveries);
    expect(ds.some((d) => d.deliveryId.includes(':6:'))).toBe(false);
  });

  it('1 つの Repo が失敗しても次の Repo に進む', async () => {
    // 後で処理される Repo を別 Project に紐づけておく
    await s.db.insert(repositoryBindings).values({
      id: 'rb_bad',
      workspaceId,
      projectId: await newProject(),
      installationId: 1,
      repositoryId: 999,
      fullName: 'x/other',
      automationEnabled: true,
      verification: 'github_app',
      policy: { triggerLabel: 'agents-office', events: ['issues.labeled'], maxRevisionAttempts: 3 },
    });
    gh.failFor = FULL_NAME; // 先に処理される（作成順）FULL_NAME が失敗する
    gh.issues = [{ number: 7, title: 't', body: '', htmlUrl: '', labels: ['agents-office'], assignees: [], updatedAt: 'x' }];
    await new GithubPoller(s.db, fakeGithub, 60_000, 'toshipy').pollOnce();
    gh.failFor = null;
    const ds = await s.db.select().from(webhookDeliveries);
    expect(ds.some((d) => d.deliveryId.startsWith('poll:issue:999:7:'))).toBe(true);
  });

  it('ラベルより後に作られた Run があれば（deliveryId が無くても）取り込まず、付け直せば取り込む', async () => {
    const run = await s.engine.createRun({
      workspaceId,
      projectId,
      title: 'old run',
      request: 'x',
      source: { type: 'github_issue', issueNumber: 8, repositoryId: REPO_ID },
      issueKey: `${REPO_ID}#8`,
      maxRevisionAttempts: 3,
      budgetLimitUsd: 2,
    });
    await s.db.update(runs).set({ status: 'completed' }).where(eq(runs.id, run.id));
    gh.issues = [{ number: 8, title: 't', body: '', htmlUrl: '', labels: ['agents-office'], assignees: [], updatedAt: 'a' }];
    gh.labeledAt = '2026-11-01T02:00:00Z'; // Run より前
    const poller = new GithubPoller(s.db, fakeGithub, 60_000, 'toshipy');
    await poller.pollOnce();
    const has8 = async () => (await s.db.select().from(webhookDeliveries)).filter((d) => d.deliveryId.startsWith(`poll:issue:${REPO_ID}:8:`));
    expect(await has8()).toHaveLength(0);
    // 付け直し（Run より新しい labeled.at）
    gh.issues = [{ ...gh.issues[0], updatedAt: 'b' }];
    gh.labeledAt = new Date(Date.now() + 60_000).toISOString();
    await poller.pollOnce();
    expect(await has8()).toHaveLength(1);
    gh.labeledAt = '2026-11-01T01:00:00Z';
  });

  it('レビューは waiting_review の Run を revising に進め、マージで completed になる', async () => {
    const run = await s.engine.createRun({
      workspaceId,
      projectId,
      title: 'review target',
      request: 'x',
      source: { type: 'github_issue', issueNumber: 50, repositoryId: REPO_ID },
      issueKey: `${REPO_ID}#50`,
      maxRevisionAttempts: 3,
      budgetLimitUsd: 2,
    });
    await s.db
      .update(runs)
      .set({ status: 'waiting_review', pr: { number: 12, url: 'u', branch: 'b', headSha: 'sha-1', draft: false } })
      .where(eq(runs.id, run.id));
    gh.pull = { state: 'open', merged: false, headSha: 'sha-1' };
    gh.reviews = [
      { id: 1, state: 'COMMENTED', body: '', user: 'toshipy', commitId: 'sha-1' },
      { id: 2, state: 'CHANGES_REQUESTED', body: '直して', user: 'toshipy', commitId: 'sha-1' },
      { id: 3, state: 'APPROVED', body: '', user: 'toshipy', commitId: 'old-sha' },
    ];
    const poller = new GithubPoller(s.db, fakeGithub, 60_000, 'toshipy');
    await poller.pollOnce();
    await poller.pollOnce();
    const ds = (await s.db.select().from(webhookDeliveries)).filter((d) => d.deliveryId.startsWith(`poll:review:${REPO_ID}:12:`));
    expect(ds.map((d) => d.deliveryId)).toEqual([`poll:review:${REPO_ID}:12:2`]);
    await s.dispatcher.drain();
    await waitRun(run.id, 'revising');

    // マージ
    await s.db.update(runs).set({ status: 'waiting_review' }).where(eq(runs.id, run.id));
    gh.pull = { state: 'closed', merged: true, headSha: 'sha-1' };
    await poller.pollOnce();
    await poller.pollOnce();
    const closed = (await s.db.select().from(webhookDeliveries)).filter((d) => d.deliveryId === `poll:pr:${REPO_ID}:12:closed:${run.id}`);
    expect(closed).toHaveLength(1);
    await s.dispatcher.drain();
    await waitRun(run.id, 'completed');
  });
});
