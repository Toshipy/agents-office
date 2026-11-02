import { describe, expect, it } from 'vitest';
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
    [{ signup: 'open' }, 'PAW_SIGNUP'],
    [{ seedDemo: true }, 'PAW_SEED_DEMO'],
    [{ enableDevRoutes: true }, 'PAW_DEV_ROUTES'],
    [{ testSandbox: 'host' }, 'PAW_TEST_SANDBOX'],
    [{ claudeCode: { restricted: false, detected: { supportsRestricted: true } } }, 'PAW_CLAUDE_CODE_RESTRICTED'],
    [{ claudeCode: { restricted: true, detected: { supportsRestricted: false } } }, '--restricted'],
  ])('%o は起動を拒む', (patch, word) => expect(() => assertSafeServerConfig(cfg({ ...safe, ...patch }))).toThrow(word));
  it('複数の問題をまとめて返す', () =>
    expect(() => assertSafeServerConfig(cfg({ ...safe, signup: 'open', seedDemo: true }))).toThrow(/PAW_SIGNUP[\s\S]*PAW_SEED_DEMO/));
  it('claude_code 以外の実行基盤では --restricted の 2 項目を見ない', () =>
    expect(() => assertSafeServerConfig(cfg({ ...safe, agentRuntime: 'simulated', claudeCode: { restricted: false, detected: null } }))).not.toThrow());
});
