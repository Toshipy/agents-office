import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../..');

export interface AppConfig {
  /** 'memory' の場合は PGlite をメモリ上に作る（テスト用） */
  dataDir: string | 'memory';
  /** .data のルート（PGlite・成果物・worktree・秘密値を置く） */
  dataRoot: string;
  artifactsDir: string;
  host: string;
  port: number;
  sessionSecret: string;
  githubWebhookSecret: string;
  /** Vite dev server など、状態更新 API を許可する Origin */
  allowedOrigins: string[];
  /** シミュレーション Runner の時間倍率（1 = 通常、0 = 待ち時間なし） */
  simSpeed: number;
  /** シミュレーションの確率的失敗（テストの失敗・レビュー指摘）を有効にするか */
  simRandomFailures: boolean;
  tickMs: number;
  stepTimeoutMs: number;
  enableDevRoutes: boolean;
  seedDemo: boolean;
  serveWebDist: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** AI 実行基盤。claude は Claude API、simulated はローカルシミュレーション */
  agentRuntime: 'claude' | 'simulated';
  agentRuntimeReason: string;
  claudeModel: string;
  claudeEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  worktreesDir: string;
  testTimeoutMs: number;
}

function resolveRuntime(): { runtime: 'claude' | 'simulated'; reason: string } {
  const mode = (process.env.PAW_AGENT_RUNTIME ?? 'auto').toLowerCase();
  const hasCredential = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (mode === 'simulated') return { runtime: 'simulated', reason: 'PAW_AGENT_RUNTIME=simulated が指定されています' };
  if (mode === 'claude') return { runtime: 'claude', reason: 'PAW_AGENT_RUNTIME=claude が指定されています' };
  return hasCredential
    ? { runtime: 'claude', reason: 'ANTHROPIC_API_KEY（または ANTHROPIC_AUTH_TOKEN）が設定されています' }
    : { runtime: 'simulated', reason: 'ANTHROPIC_API_KEY が未設定のためシミュレーションで動作しています' };
}

interface PersistedSecrets {
  sessionSecret: string;
  githubWebhookSecret: string;
}

/** ローカル用の秘密値。環境変数が無ければ .data/secrets.json に生成し 0600 で保存する */
function loadSecrets(dataDir: string): PersistedSecrets {
  const file = resolve(dataDir, 'secrets.json');
  let persisted: Partial<PersistedSecrets> = {};
  if (existsSync(file)) {
    persisted = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedSecrets>;
  }
  const secrets: PersistedSecrets = {
    sessionSecret:
      process.env.PAW_SESSION_SECRET ?? persisted.sessionSecret ?? randomBytes(32).toString('hex'),
    githubWebhookSecret:
      process.env.PAW_GITHUB_WEBHOOK_SECRET ??
      persisted.githubWebhookSecret ??
      randomBytes(24).toString('hex'),
  };
  if (!process.env.PAW_SESSION_SECRET || !process.env.PAW_GITHUB_WEBHOOK_SECRET) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          sessionSecret: persisted.sessionSecret ?? secrets.sessionSecret,
          githubWebhookSecret: persisted.githubWebhookSecret ?? secrets.githubWebhookSecret,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);
  }
  return secrets;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const root = resolve(process.env.PAW_DATA_DIR ?? resolve(REPO_ROOT, '.data'));
  const isMemory = overrides.dataDir === 'memory';
  const secrets: PersistedSecrets = isMemory
    ? { sessionSecret: 'test-session-secret', githubWebhookSecret: 'test-webhook-secret' }
    : loadSecrets(root);
  const port = Number(process.env.PAW_API_PORT ?? 8787);
  const runtime = resolveRuntime();
  const effort = (process.env.PAW_CLAUDE_EFFORT ?? 'high') as AppConfig['claudeEffort'];
  return {
    dataDir: isMemory ? 'memory' : resolve(root, 'pglite'),
    dataRoot: root,
    artifactsDir: resolve(root, 'artifacts'),
    host: process.env.PAW_API_HOST ?? '127.0.0.1',
    port,
    sessionSecret: secrets.sessionSecret,
    githubWebhookSecret: secrets.githubWebhookSecret,
    allowedOrigins: (
      process.env.PAW_ALLOWED_ORIGINS ??
      `http://localhost:5173,http://127.0.0.1:5173,http://localhost:${port},http://127.0.0.1:${port}`
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    simSpeed: Number(process.env.PAW_SIM_SPEED ?? 1),
    simRandomFailures: (process.env.PAW_SIM_RANDOM_FAILURES ?? '1') !== '0',
    tickMs: 400,
    stepTimeoutMs: Number(process.env.PAW_STEP_TIMEOUT_MS ?? 120_000),
    enableDevRoutes: (process.env.PAW_DEV_ROUTES ?? '1') !== '0',
    seedDemo: (process.env.PAW_SEED_DEMO ?? '1') !== '0',
    serveWebDist: null,
    logLevel: (process.env.PAW_LOG_LEVEL as AppConfig['logLevel']) ?? 'info',
    agentRuntime: runtime.runtime,
    agentRuntimeReason: runtime.reason,
    claudeModel: process.env.PAW_CLAUDE_MODEL ?? 'claude-opus-5-5',
    claudeEffort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : 'high',
    worktreesDir: resolve(root, 'worktrees'),
    testTimeoutMs: Number(process.env.PAW_TEST_TIMEOUT_MS ?? 600_000),
    ...overrides,
  };
}
