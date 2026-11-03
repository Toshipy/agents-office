import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRuntime } from '@paw/contracts';
import { log } from './lib/logger';

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
  /** PAW_AGENT_RUNTIME の指定（auto は起動時に検出して agentRuntime を決める） */
  agentRuntimeMode: 'auto' | AgentRuntime;
  /** AI 実行基盤。claude = Claude API、claude_code = Claude Code CLI（サブスク）、simulated = ローカルシミュレーション */
  agentRuntime: AgentRuntime;
  agentRuntimeReason: string;
  claudeModel: string;
  claudeEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  claudeCode: ClaudeCodeConfig;
  /** Claude で実行する Run の工程タイムアウト（シミュレーションより長い） */
  claudeStepTimeoutMs: number;
  worktreesDir: string;
  testTimeoutMs: number;
  /** Tester の実行場所。docker = 使い捨てコンテナ（サーバーモードの既定）/ host = ホストで直接（ローカルの既定） */
  testSandbox: 'docker' | 'host';
  /** Repo 別のイメージ指定が無いときに使うイメージ。コンテナは非 root・HOME=/tmp のため、pnpm は testCommand に `corepack pnpm test` のように書く（`corepack enable` は使えない） */
  testImage: string;
  /** Tester のコンテナを繋ぐ docker ネットワーク */
  testNetwork: string;
  /** GitHub App 連携（未設定ならローカルの GitHub シミュレーターのみ） */
  githubApp: { appId: string; privateKeyPem: string; apiUrl: string; allowedUsers: string[] } | null;
  /** GitHub のポーリング間隔（ミリ秒。PAW_GITHUB_POLL_MS、既定 60 秒） */
  githubPollMs: number;
  /** ポーリングで Issue を拾うときの自分の GitHub ログイン名（PAW_GITHUB_LOGIN、無ければ許可ユーザーの先頭、無ければ null） */
  githubLogin: string | null;
  /** 受信 Webhook を有効にする（PAW_GITHUB_WEBHOOK=1）。既定は無効 = サーバーをインターネットに出さなくてよい */
  githubWebhookEnabled: boolean;
  /** サーバーで公開する URL（例 https://paw.example.com）。Cookie の Secure・許可 Origin に使う */
  publicUrl: string | null;
  cookieSecure: boolean;
  /** 新規登録: open = 誰でも / first_user = 最初の 1 人だけ / closed = 不可 */
  signup: 'open' | 'first_user' | 'closed';
  /** 設定すると、新規登録にこのコードが必要（公開 URL で第三者に先に登録されないようにする） */
  signupCode: string | null;
}

/**
 * GitHub App の設定（PAW_GITHUB_APP_ID と秘密鍵の両方があれば有効）。
 * 秘密鍵は PAW_GITHUB_APP_PRIVATE_KEY_FILE（推奨・パーミッション 600 のファイル）か PAW_GITHUB_APP_PRIVATE_KEY。
 */
function loadGithubApp(): AppConfig['githubApp'] {
  const appId = process.env.PAW_GITHUB_APP_ID?.trim();
  const keyFile = process.env.PAW_GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  const inlineKey = process.env.PAW_GITHUB_APP_PRIVATE_KEY;
  if (!appId && !keyFile && !inlineKey) return null;
  if (!appId) throw new Error('PAW_GITHUB_APP_ID が未設定です（GitHub App の秘密鍵だけが設定されています）');
  const pem = keyFile ? readFileSync(keyFile, 'utf8') : (inlineKey ?? '').replace(/\\n/g, '\n');
  if (!pem.includes('PRIVATE KEY')) throw new Error('GitHub App の秘密鍵（PEM）を読み込めません: PAW_GITHUB_APP_PRIVATE_KEY_FILE を確認してください');
  // Webhook を受ける場合だけ、App に設定した secret と同じ値が要る（自動生成の値では実 GitHub の署名を検証できない）。ポーリング運用では不要
  if (process.env.PAW_GITHUB_WEBHOOK === '1' && (!nonEmpty(process.env.PAW_GITHUB_WEBHOOK_SECRET) || process.env.PAW_GITHUB_WEBHOOK_SECRET!.trim().length < 16)) {
    throw new Error('PAW_GITHUB_WEBHOOK=1 の場合は PAW_GITHUB_WEBHOOK_SECRET（16 文字以上。App の Webhook secret と同じ値）を設定してください');
  }
  const listed = (process.env.PAW_GITHUB_ALLOWED_USERS ?? '')
    .split(',')
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
  // 未設定なら自分（PAW_GITHUB_LOGIN）だけを許す。自分が付けたラベル・レビューで動くようにするため
  const login = nonEmpty(process.env.PAW_GITHUB_LOGIN)?.toLowerCase();
  const allowedUsers = listed.length === 0 && login ? [login] : listed;
  return { appId, privateKeyPem: pem, apiUrl: process.env.PAW_GITHUB_API_URL?.trim() || 'https://api.github.com', allowedUsers };
}

function parsePollMs(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 10_000 ? Math.floor(n) : 60_000;
}

function parseSignup(v: string | undefined): AppConfig['signup'] {
  const m = (v ?? 'open').trim().toLowerCase().replace('-', '_');
  return m === 'first_user' || m === 'closed' ? m : 'open';
}

/** 未指定ならサーバーモード（publicUrl あり）は docker、ローカルは host */
function parseTestSandbox(v: string | undefined, publicUrl: string | null): AppConfig['testSandbox'] {
  const m = (v ?? '').trim().toLowerCase();
  if (m === 'docker' || m === 'host') return m;
  return publicUrl ? 'docker' : 'host';
}

export interface ClaudeCodeConfig {
  /** claude コマンド（PATH 上の名前または絶対パス） */
  bin: string;
  /** null = CLI の既定モデル（サブスクのプランで使えるモデルは CLI 側が決める） */
  model: string | null;
  effort: string | null;
  /** --restricted で起動する（利用者・リポジトリの設定を読まず、ファイル操作を作業ディレクトリに限定） */
  restricted: boolean;
  /** API キー課金で動く構成を許可する（既定は許可しない = サブスク以外では止める） */
  allowApiBilling: boolean;
  maxTurns: { plan: number; review: number; develop: number };
  /** 起動時の検出結果（バージョン・ログイン方法）。未検出なら null */
  detected: { version: string | null; loggedIn: boolean; authMethod: string | null; subscription: boolean; problem: string | null; supportsRestricted: boolean } | null;
}

export function parseRuntimeMode(v: string | undefined): 'auto' | AgentRuntime {
  const m = (v ?? 'auto').trim().toLowerCase().replace('-', '_');
  if (m === 'claude' || m === 'claude_api' || m === 'api') return 'claude';
  if (m === 'claude_code' || m === 'subscription') return 'claude_code';
  if (m === 'simulated') return 'simulated';
  return 'auto';
}

function positiveInt(v: string | undefined, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function defaultClaudeCodeConfig(): ClaudeCodeConfig {
  return {
    bin: process.env.PAW_CLAUDE_CODE_BIN?.trim() || 'claude',
    model: process.env.PAW_CLAUDE_CODE_MODEL?.trim() || null,
    effort: process.env.PAW_CLAUDE_CODE_EFFORT?.trim() || null,
    restricted: (process.env.PAW_CLAUDE_CODE_RESTRICTED ?? '1') !== '0',
    allowApiBilling: process.env.PAW_CLAUDE_CODE_ALLOW_API_BILLING === '1',
    maxTurns: {
      plan: positiveInt(process.env.PAW_CLAUDE_CODE_PLAN_MAX_TURNS, 30),
      review: positiveInt(process.env.PAW_CLAUDE_CODE_REVIEW_MAX_TURNS, 30),
      develop: positiveInt(process.env.PAW_CLAUDE_CODE_MAX_TURNS, 60),
    },
    detected: null,
  };
}

/**
 * 起動前（同期）に決められる範囲の実行基盤。auto の場合の最終決定は、Claude Code CLI の
 * ログイン状態を調べる resolveAgentRuntime()（非同期・server 起動時のみ）で行う。
 */
function provisionalRuntime(mode: 'auto' | AgentRuntime): { runtime: AgentRuntime; reason: string } {
  const hasCredential = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (mode === 'simulated') return { runtime: 'simulated', reason: 'PAW_AGENT_RUNTIME=simulated が指定されています' };
  if (mode === 'claude') return { runtime: 'claude', reason: 'PAW_AGENT_RUNTIME=claude（Claude API）が指定されています' };
  if (mode === 'claude_code') return { runtime: 'claude_code', reason: 'PAW_AGENT_RUNTIME=claude-code（Claude Code CLI）が指定されています' };
  return hasCredential
    ? { runtime: 'claude', reason: 'ANTHROPIC_API_KEY（または ANTHROPIC_AUTH_TOKEN）が設定されています' }
    : { runtime: 'simulated', reason: 'Claude の実行手段が見つからないためシミュレーションで動作しています' };
}

function nonEmpty(v: string | undefined | null): string | undefined {
  return v && v.trim().length > 0 ? v.trim() : undefined;
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
  // 空文字（`PAW_SESSION_SECRET=` のまま）は未設定として扱う。空の鍵で署名・検証させない
  const envSession = nonEmpty(process.env.PAW_SESSION_SECRET);
  const envWebhook = nonEmpty(process.env.PAW_GITHUB_WEBHOOK_SECRET);
  const secrets: PersistedSecrets = {
    sessionSecret: envSession ?? nonEmpty(persisted.sessionSecret) ?? randomBytes(32).toString('hex'),
    githubWebhookSecret: envWebhook ?? nonEmpty(persisted.githubWebhookSecret) ?? randomBytes(24).toString('hex'),
  };
  if (!envSession || !envWebhook) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          sessionSecret: nonEmpty(persisted.sessionSecret) ?? secrets.sessionSecret,
          githubWebhookSecret: nonEmpty(persisted.githubWebhookSecret) ?? secrets.githubWebhookSecret,
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
  const publicUrl = process.env.PAW_PUBLIC_URL?.trim().replace(/\/$/, '') || null;
  const mode = parseRuntimeMode(process.env.PAW_AGENT_RUNTIME);
  const runtime = provisionalRuntime(mode);
  const effort = (process.env.PAW_CLAUDE_EFFORT ?? 'high') as AppConfig['claudeEffort'];
  const githubApp = isMemory ? null : loadGithubApp();
  if (githubApp && !nonEmpty(process.env.PAW_GITHUB_LOGIN) && githubApp.allowedUsers.length === 0) {
    log.warn('PAW_GITHUB_LOGIN も PAW_GITHUB_ALLOWED_USERS も未設定のため、GitHub のポーリングでは Run を作りません');
  }
  return {
    dataDir: isMemory ? 'memory' : resolve(root, 'pglite'),
    dataRoot: root,
    artifactsDir: resolve(root, 'artifacts'),
    host: process.env.PAW_API_HOST ?? '127.0.0.1',
    port,
    sessionSecret: secrets.sessionSecret,
    githubWebhookSecret: secrets.githubWebhookSecret,
    allowedOrigins: [
      ...(
        process.env.PAW_ALLOWED_ORIGINS ??
        `http://localhost:5173,http://127.0.0.1:5173,http://localhost:${port},http://127.0.0.1:${port}`
      )
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      ...(publicUrl ? [new URL(publicUrl).origin] : []),
    ],
    simSpeed: Number(process.env.PAW_SIM_SPEED ?? 1),
    simRandomFailures: (process.env.PAW_SIM_RANDOM_FAILURES ?? '1') !== '0',
    tickMs: 400,
    stepTimeoutMs: Number(process.env.PAW_STEP_TIMEOUT_MS ?? 120_000),
    enableDevRoutes: (process.env.PAW_DEV_ROUTES ?? '1') !== '0',
    seedDemo: (process.env.PAW_SEED_DEMO ?? '1') !== '0',
    serveWebDist: null,
    logLevel: (process.env.PAW_LOG_LEVEL as AppConfig['logLevel']) ?? 'info',
    agentRuntimeMode: mode,
    agentRuntime: runtime.runtime,
    agentRuntimeReason: runtime.reason,
    claudeModel: process.env.PAW_CLAUDE_MODEL ?? 'claude-opus-5-5',
    claudeEffort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : 'high',
    claudeCode: defaultClaudeCodeConfig(),
    claudeStepTimeoutMs: positiveInt(process.env.PAW_CLAUDE_STEP_TIMEOUT_MS, 30 * 60_000),
    worktreesDir: resolve(root, 'worktrees'),
    testTimeoutMs: Number(process.env.PAW_TEST_TIMEOUT_MS ?? 600_000),
    testSandbox: parseTestSandbox(process.env.PAW_TEST_SANDBOX, publicUrl),
    testImage: nonEmpty(process.env.PAW_TEST_IMAGE) ?? 'node:22-bookworm',
    testNetwork: nonEmpty(process.env.PAW_TEST_NETWORK) ?? 'paw-test',
    githubApp,
    githubPollMs: parsePollMs(process.env.PAW_GITHUB_POLL_MS),
    githubLogin: nonEmpty(process.env.PAW_GITHUB_LOGIN) ?? githubApp?.allowedUsers[0] ?? null,
    githubWebhookEnabled: process.env.PAW_GITHUB_WEBHOOK === '1',
    publicUrl,
    cookieSecure: publicUrl?.startsWith('https://') ?? false,
    signup: parseSignup(process.env.PAW_SIGNUP),
    signupCode: nonEmpty(process.env.PAW_SIGNUP_CODE) ?? null,
    ...overrides,
  };
}
