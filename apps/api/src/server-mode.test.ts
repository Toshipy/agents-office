/**
 * サーバー公開時の設定（Tailscale Funnel などで URL がインターネットから見える場合）。
 * 新規登録は最初の 1 人だけ・登録コード必須、Cookie は Secure、許可 Origin に公開 URL が入ること。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createApp, createServices, type Services } from './app';

let s: Services;
let app: ReturnType<typeof createApp>;
const CODE = 'b7c1f0e2a9d84c3e9a1b2c3d4e5f6a7b';
const PUBLIC = 'https://paw.example-tailnet.ts.net';

const signup = (body: Record<string, unknown>, origin = PUBLIC) =>
  app.request('/v1/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paw-client': 'web', origin },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  s = await createServices(
    loadConfig({
      dataDir: 'memory',
      simSpeed: 0,
      seedDemo: false,
      enableDevRoutes: false,
      logLevel: 'silent',
      agentRuntime: 'simulated',
      signup: 'first_user',
      signupCode: CODE,
      publicUrl: PUBLIC,
      cookieSecure: true,
      allowedOrigins: [PUBLIC],
    }),
  );
  app = createApp(s);
});

afterAll(async () => {
  await s.engine.stop();
  await s.client.close();
});

describe('server mode signup', () => {
  it('requires the signup code, allows only the first user, and issues Secure cookies', async () => {
    const cfg = await (await app.request('/v1/auth/config')).json();
    expect(cfg).toMatchObject({ mode: 'server', signup: true, signupCodeRequired: true, devAccounts: [] });

    const base = { username: 'owner', displayName: 'Owner', password: 'long-password-1234' };
    const noCode = await signup(base);
    expect(noCode.status).toBe(403);
    expect(((await noCode.json()) as { code: string }).code).toBe('SIGNUP_CODE_INVALID');
    expect((await signup({ ...base, signupCode: 'wrong' })).status).toBe(403);

    const ok = await signup({ ...base, signupCode: CODE });
    expect(ok.status).toBe(201);
    const cookie = ok.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');

    // コードを知っていても 2 人目は登録できない
    const second = await signup({ ...base, username: 'intruder', signupCode: CODE });
    expect(second.status).toBe(403);
    expect(((await second.json()) as { code: string }).code).toBe('SIGNUP_DISABLED');
    expect(((await (await app.request('/v1/auth/config')).json()) as { signup: boolean }).signup).toBe(false);

    // 公開 URL 以外の Origin からの更新リクエストは拒否
    const foreign = await signup({ ...base, username: 'other', signupCode: CODE }, 'https://evil.example.com');
    expect(foreign.status).toBe(403);
  });
});
