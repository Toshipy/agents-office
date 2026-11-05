/**
 * PAW_AUTH=alb_oidc: ALB が渡す JWT だけで入る認証モード。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig } from './config';
import { createApp, createServices, type Services } from './app';
import { users, workspaces } from './db/schema';
import { verifyPassword } from './lib/crypto';
import { log } from './lib/logger';
import { ALB_ARN, EMAIL, fetchKey, privateKey, signAlbJwt } from './testing/albJwt';

let s: Services;
let app: ReturnType<typeof createApp>;
const PUBLIC = 'https://agents-office.c.fnrr.biz';

// 署名の exp は固定の NOW を基準にするので、現在時刻でも切れない JWT を作る
const jwt = (o: Parameters<typeof signAlbJwt>[1] = {}) =>
  signAlbJwt(privateKey, { ...o, header: { exp: Math.floor(Date.now() / 1000) + 600, ...o.header } });
const get = (path: string, token?: string) => app.request(path, { headers: token ? { 'x-amzn-oidc-data': token } : {} });
const json = async (r: Response) => (await r.json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const post = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

beforeAll(async () => {
  s = await createServices(
    loadConfig({
      dataDir: 'memory',
      simSpeed: 0,
      seedDemo: false,
      enableDevRoutes: false,
      logLevel: 'silent',
      agentRuntime: 'simulated',
      publicUrl: PUBLIC,
      allowedOrigins: [PUBLIC],
      auth: 'alb_oidc',
      albArn: ALB_ARN,
      allowedEmail: EMAIL,
    }),
    { albKeyFetcher: fetchKey },
  );
  app = createApp(s);
});

afterAll(async () => {
  await s.engine.stop();
  await s.client.close();
});

describe('alb_oidc の認証', () => {
  it('ヘッダーが無い /v1 の要求は 401', async () => {
    expect((await get('/v1/me')).status).toBe(401);
  });

  it('許可していないメールは 401', async () => {
    expect((await get('/v1/me', jwt({ payload: { email: 'someone@fenrir.co.jp' } }))).status).toBe(401);
  });

  it('署名が違う JWT は 401', async () => {
    expect((await get('/v1/me', jwt({ tamper: true }))).status).toBe(401);
  });

  it('拒否したときは理由だけをログに残し、トークンやメールは出さない', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const token = jwt({ payload: { email: 'someone@fenrir.co.jp' } });
      expect((await get('/v1/me', token)).status).toBe(401);
      expect(warn).toHaveBeenCalledWith('alb_oidc rejected', { reason: 'not_allowed' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('someone@fenrir.co.jp');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
    } finally {
      warn.mockRestore();
    }
  });

  it('公開鍵を取得できないときは 401 ではなく 503（UNAVAILABLE）', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const saved = s.albKeyFetcher;
    s.albKeyFetcher = async () => {
      throw new Error('network');
    };
    try {
      const res = await get('/v1/me', jwt());
      expect(res.status).toBe(503);
      expect((await json(res)).code).toBe('UNAVAILABLE');
      expect(warn).toHaveBeenCalledWith('alb_oidc rejected', { reason: 'key_unavailable' });
    } finally {
      s.albKeyFetcher = saved;
      warn.mockRestore();
    }
  });

  it('セッション Cookie だけでは入れない', async () => {
    const res = await app.request('/v1/me', { headers: { cookie: 'paw_session=x' } });
    expect(res.status).toBe(401);
  });

  it('正しい JWT で初めて来た人のユーザーとワークスペースが作られ、2 回目は同じユーザー', async () => {
    const r1 = await get('/v1/me', jwt());
    expect(r1.status).toBe(200);
    const b1 = await json(r1);
    expect(b1.user.username).toBe(EMAIL);
    expect(b1.user.displayName).toBe('Arai');
    const b2 = await json(await get('/v1/me', jwt()));
    expect(b2.user.id).toBe(b1.user.id);
    expect(b2.workspace.id).toBe(b1.workspace.id);
    const rows = await s.db.select().from(users).where(eq(users.username, EMAIL));
    expect(rows).toHaveLength(1);
  });

  it('同時に 2 つの初回要求が来てもユーザーは 1 人', async () => {
    const email = 't.arai@fenrir.co.jp';
    const s2 = await createServices(
      loadConfig({ dataDir: 'memory', logLevel: 'silent', agentRuntime: 'simulated', seedDemo: false, enableDevRoutes: false, publicUrl: PUBLIC, allowedOrigins: [PUBLIC], auth: 'alb_oidc', albArn: ALB_ARN, allowedEmail: email }),
      { albKeyFetcher: fetchKey },
    );
    try {
      const app2 = createApp(s2);
      const t = jwt();
      const rs = await Promise.all([1, 2, 3].map(() => app2.request('/v1/me', { headers: { 'x-amzn-oidc-data': t } })));
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
      const ids = new Set((await Promise.all(rs.map((r) => json(r)))).map((b) => b.user.id));
      expect(ids.size).toBe(1);
      expect(await s2.db.select().from(users)).toHaveLength(1);
      expect(await s2.db.select().from(workspaces)).toHaveLength(1);
    } finally {
      await s2.engine.stop();
      await s2.client.close();
    }
  });

  it('作られたユーザーのパスワードではログインできない（passwordHash が使えない値）', async () => {
    await get('/v1/me', jwt());
    const [u] = await s.db.select().from(users).where(eq(users.username, EMAIL));
    expect(u.passwordHash).toBe('!alb_oidc');
    for (const pw of ['', '!alb_oidc', 'password', 'scrypt$00$00']) expect(await verifyPassword(pw, u.passwordHash)).toBe(false);
  });
});

describe('alb_oidc の認証まわりの経路', () => {
  it('/v1/auth/config は alb_oidc を返し、デモアカウントを返さない', async () => {
    const body = await json(await get('/v1/auth/config'));
    expect(body).toEqual({ mode: 'alb_oidc', devRoutes: false, signup: false, signupCodeRequired: false, devAccounts: [] });
  });

  it('login と signup は 404', async () => {
    const h = { 'x-paw-client': 'web', origin: PUBLIC };
    for (const p of ['/v1/auth/login', '/v1/auth/signup']) {
      const res = await post(p, h);
      expect(res.status).toBe(404);
      expect((await json(res)).code).toBe('AUTH_MODE_ALB');
    }
  });

  it('logout は ALB の Cookie を消す', async () => {
    const res = await post('/v1/auth/logout', { 'x-paw-client': 'web', origin: PUBLIC });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const cookies = res.headers.getSetCookie();
    for (let i = 0; i < 4; i++) {
      const c = cookies.find((x) => x.startsWith(`AWSELBAuthSessionCookie-${i}=;`));
      expect(c, `cookie ${i}`).toBeTruthy();
      expect(c).toMatch(/Max-Age=0/i);
      expect(c).toMatch(/Path=\//);
      expect(c).toMatch(/Secure/i);
    }
  });

  it('更新系は x-paw-client と Origin の検査が今までどおり効く', async () => {
    const token = jwt();
    const noHeader = await app.request('/v1/projects', { method: 'POST', headers: { 'x-amzn-oidc-data': token, 'content-type': 'application/json' }, body: '{}' });
    expect(noHeader.status).toBe(403);
    const badOrigin = await app.request('/v1/projects', { method: 'POST', headers: { 'x-amzn-oidc-data': token, 'x-paw-client': 'web', origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(badOrigin.status).toBe(403);
  });
});

