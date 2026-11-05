import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from './config';
import { assertSafeServerConfig } from './serverGuard';

const safe = {
  publicUrl: 'https://paw.tailnet.ts.net',
  signup: 'first_user',
  seedDemo: false,
  enableDevRoutes: false,
  agentRuntime: 'claude_code',
  testSandbox: 'docker',
  claudeCode: { restricted: true, detected: { supportsRestricted: true } },
  auth: 'alb_oidc',
  albArn: 'arn:aws:elasticloadbalancing:ap-northeast-1:111122223333:loadbalancer/app/agents-office/abc',
  allowedEmail: 't.arai@fenrir.co.jp',
};

/** loadConfig の結果に、テスト用の上書き（claudeCode は浅くマージ）を重ねる */
function cfg(patch: Record<string, unknown>): AppConfig {
  const base = loadConfig({ dataDir: 'memory', logLevel: 'silent' });
  const { claudeCode, ...rest } = patch as { claudeCode?: Record<string, unknown> };
  return { ...base, ...rest, claudeCode: { ...base.claudeCode, ...claudeCode } } as unknown as AppConfig;
}

describe('assertSafeServerConfig', () => {
  it('サーバーモードで安全な設定なら通す', () => expect(() => assertSafeServerConfig(cfg(safe))).not.toThrow());
  it('ローカル（publicUrl なし）は何でも通す', () =>
    expect(() => assertSafeServerConfig(cfg({ ...safe, publicUrl: null, signup: 'open', seedDemo: true }))).not.toThrow());
  it.each([
    [{ signup: 'open', auth: 'local' }, 'PAW_SIGNUP'],
    [{ seedDemo: true }, 'PAW_SEED_DEMO'],
    [{ enableDevRoutes: true }, 'PAW_DEV_ROUTES'],
    [{ testSandbox: 'host' }, 'PAW_TEST_SANDBOX'],
    [{ auth: 'local' }, 'PAW_AUTH'],
    [{ albArn: null }, 'PAW_ALB_ARN'],
    [{ allowedEmail: null }, 'PAW_ALLOWED_EMAIL'],
    [{ claudeCode: { restricted: false, detected: { supportsRestricted: true } } }, 'PAW_CLAUDE_CODE_RESTRICTED'],
    [{ claudeCode: { restricted: true, detected: { supportsRestricted: false } } }, '--restricted'],
  ])('%o は起動を拒む', (patch, word) => expect(() => assertSafeServerConfig(cfg({ ...safe, ...patch }))).toThrow(word));
  it('alb_oidc なら signup が open でも拒まない（登録の経路そのものが無い）', () =>
    expect(() => assertSafeServerConfig(cfg({ ...safe, signup: 'open' }))).not.toThrow());
  it('GitHub App があるのに実行基盤がシミュレーションなら起動を拒む', () => {
    const githubApp = { appId: '1', privateKeyPem: 'x', apiUrl: 'https://api.github.com', allowedUsers: ['toshipy'] };
    expect(() => assertSafeServerConfig(cfg({ ...safe, githubApp, agentRuntime: 'simulated', agentRuntimeReason: 'Claude Code にログインしていません' }))).toThrow(/GitHub App[\s\S]*シミュレーション[\s\S]*ログインしていません/);
    expect(() => assertSafeServerConfig(cfg({ ...safe, githubApp }))).not.toThrow();
  });
  it('複数の問題をまとめて返す', () =>
    expect(() => assertSafeServerConfig(cfg({ ...safe, auth: 'local', signup: 'open', seedDemo: true }))).toThrow(/PAW_SIGNUP[\s\S]*PAW_SEED_DEMO/));
  it('claude_code 以外の実行基盤では --restricted の 2 項目を見ない', () =>
    expect(() => assertSafeServerConfig(cfg({ ...safe, agentRuntime: 'simulated', claudeCode: { restricted: false, detected: null } }))).not.toThrow());
});

describe('GitHub の許可ユーザーの既定（PAW_GITHUB_ALLOWED_USERS）', () => {
  const keys = ['PAW_DATA_DIR', 'PAW_GITHUB_APP_ID', 'PAW_GITHUB_APP_PRIVATE_KEY', 'PAW_GITHUB_LOGIN', 'PAW_GITHUB_ALLOWED_USERS'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  function load(env: { login?: string; allowed?: string }) {
    process.env.PAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'paw-cfg-'));
    process.env.PAW_GITHUB_APP_ID = '1';
    process.env.PAW_GITHUB_APP_PRIVATE_KEY = pem;
    if (env.login === undefined) delete process.env.PAW_GITHUB_LOGIN;
    else process.env.PAW_GITHUB_LOGIN = env.login;
    if (env.allowed === undefined) delete process.env.PAW_GITHUB_ALLOWED_USERS;
    else process.env.PAW_GITHUB_ALLOWED_USERS = env.allowed;
    return loadConfig({ logLevel: 'silent' }).githubApp!.allowedUsers;
  }

  it('未設定で PAW_GITHUB_LOGIN があれば、自分だけを許す', () => expect(load({ login: 'ToshiPy' })).toEqual(['toshipy']));
  it('設定があればそれを使う', () => expect(load({ login: 'toshipy', allowed: 'Alice, bob' })).toEqual(['alice', 'bob']));
  it('どちらも無ければ空（Run を起動しない）', () => expect(load({})).toEqual([]));
});
