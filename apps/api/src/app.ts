/**
 * Hono API（ADR-003）。createServices() で依存を組み立て、createApp() でルートを登録する。
 * テストでは PGlite をメモリで起動し、app.request() で検証する。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { PGlite } from '@electric-sql/pglite';
import type { AppConfig } from './config';
import { openDb, type Db } from './db/client';
import { EventBus } from './events/bus';
import { AppError } from './lib/errors';
import { log, setLogLevel } from './lib/logger';
import { ArtifactStore } from './workflow/artifactStore';
import { WorkflowEngine } from './workflow/engine';
import { SimulatedRunner } from './agents/simulated';
import type { AgentRunner } from './agents/runner';
import { RunnerRouter } from './agents/router';
import { ClaudeRunner } from './agents/claude/runner';
import { DockerSandbox, HostSandbox, type TestSandbox } from './agents/claude/testSandbox';
import { ClaudeApiBackend, type ClaudeMessagesClient } from './agents/claude/apiBackend';
import { ClaudeCodeBackend } from './agents/claude/cliBackend';
import { removeWorktree } from './agents/claude/git';
import { GithubApp } from './github/app';
import { GithubRepoHost } from './github/repoHost';
import { Dispatcher } from './github/dispatcher';
import { GithubPoller } from './github/poller';
import { IssueIntake } from './github/issueIntake';
import { IssueCleanup } from './github/issueCleanup';
import { MAX_WEBHOOK_BYTES, receiveGithubWebhook } from './github/webhook';
import { SeatWatcher } from './services/office';
import { csrfGuard, requireAuth, type AuthContext } from './auth/session';
import { registerAuthRoutes } from './routes/auth';
import { registerWorkspaceRoutes } from './routes/workspace';
import { registerProjectRoutes } from './routes/projects';
import { registerRunRoutes } from './routes/runs';
import { registerIssueRoutes } from './routes/issues';
import { registerApprovalRoutes } from './routes/approvals';
import { registerEventRoutes } from './routes/events';
import { registerDevRoutes } from './routes/dev';

export interface Services {
  db: Db;
  client: PGlite;
  config: AppConfig;
  bus: EventBus;
  store: ArtifactStore;
  engine: WorkflowEngine;
  dispatcher: Dispatcher;
  issueIntake: IssueIntake;
  seats: SeatWatcher;
  /** GitHub App 連携（未設定なら null = シミュレーターのみ） */
  github: GithubApp | null;
  /** GitHub のポーリング（GitHub App 未設定なら null） */
  poller: GithubPoller | null;
  /** Tester の実行場所（起動時・Run の終わりに残ったコンテナを片付ける） */
  testSandbox: TestSandbox;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    auth: AuthContext | undefined;
  };
};

export async function createServices(
  config: AppConfig,
  opts: { runner?: AgentRunner; claudeClient?: ClaudeMessagesClient; githubFetch?: typeof fetch; testSandbox?: TestSandbox } = {},
): Promise<Services> {
  setLogLevel(config.logLevel);
  const github = config.githubApp ? new GithubApp(config.githubApp, opts.githubFetch) : null;
  if (github && github.cfg.allowedUsers.length === 0) {
    log.warn('PAW_GITHUB_ALLOWED_USERS も PAW_GITHUB_LOGIN も未設定のため、GitHub の Issue・レビューからは Run を起動しません');
  }
  const remoteHost = github ? new GithubRepoHost(github, config.dataRoot, config.githubLogin) : null;
  const testSandbox: TestSandbox = opts.testSandbox ?? (config.testSandbox === 'docker' ? new DockerSandbox({ network: config.testNetwork, defaultImage: config.testImage }) : new HostSandbox());
  const common = { worktreesDir: config.worktreesDir, testTimeoutMs: config.testTimeoutMs, testSandbox, remoteHost };
  const runner =
    opts.runner ??
    new RunnerRouter(
      new SimulatedRunner({ randomFailures: config.simRandomFailures }),
      {
        api:
          config.agentRuntime === 'claude'
            ? new ClaudeRunner({ ...common, backend: new ClaudeApiBackend({ model: config.claudeModel, effort: config.claudeEffort, client: opts.claudeClient }) })
            : null,
        code:
          config.agentRuntime === 'claude_code'
            ? new ClaudeRunner({
                ...common,
                backend: new ClaudeCodeBackend({
                  bin: config.claudeCode.bin,
                  model: config.claudeCode.model,
                  effort: config.claudeCode.effort,
                  restricted: config.claudeCode.restricted,
                  allowApiBilling: config.claudeCode.allowApiBilling,
                  maxTurns: config.claudeCode.maxTurns,
                }),
              })
            : null,
      },
      async (runId, localRepoPath, branch) => {
        // worktree を消す前に、その Run のコンテナを消す（残ったコンテナが worktree を書き換え続けないように）
        await testSandbox.removeRunContainers?.(runId).catch((err) => log.warn('test container cleanup failed', { runId, err: String(err) }));
        await removeWorktree(localRepoPath, resolve(config.worktreesDir, runId), branch).catch(() => undefined);
      },
    );
  const { db, client } = await openDb(config.dataDir);
  const bus = new EventBus(db);
  const store = new ArtifactStore(db, config.dataDir === 'memory' ? 'memory' : config.artifactsDir);
  const engine = new WorkflowEngine(db, bus, store, runner, config);
  const issueIntake = new IssueIntake(db, engine, github, config.githubLogin);
  if (github) engine.setIssueCleanup(new IssueCleanup(db, github, config.githubLogin));
  const dispatcher = new Dispatcher(db, bus, engine, github, issueIntake);
  const seats = new SeatWatcher(db, bus);
  const poller = github ? new GithubPoller(db, github, config.githubPollMs, config.githubLogin) : null;
  return { db, client, config, bus, store, engine, dispatcher, issueIntake, seats, github, poller, testSandbox };
}

/**
 * 常駐の処理（エンジン・Dispatcher・ポーリング・席）を動かす。
 * エンジンが Run を復旧する前に、前のプロセスが残した Tester のコンテナを消す
 * （再起動・更新で止めきれなかったコンテナが、復旧した試行と同じ worktree を書き換えないように）
 */
export async function startServices(s: Services) {
  try {
    const removed = (await s.testSandbox.removeAllContainers?.()) ?? [];
    if (removed.length > 0) log.info('removed leftover test containers', { count: removed.length });
  } catch (err) {
    // Docker が使えなければ、テストの工程が TEST_SANDBOX_UNAVAILABLE で失敗する。起動は止めない
    log.warn('leftover test container cleanup failed', { err: String(err) });
  }
  await s.engine.start();
  s.dispatcher.start();
  s.poller?.start();
  s.seats.start();
}

export function createApp(s: Services) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const requestId = randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    const started = Date.now();
    await next();
    if (!c.req.path.startsWith('/v1/events/stream')) {
      log.debug('request', { requestId, method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
    }
  });
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? 'unknown';
    if (err instanceof AppError) {
      return c.json({ code: err.code, message: err.message, requestId, ...(err.details ? { details: err.details } : {}) }, err.status);
    }
    log.error('unhandled error', { requestId, path: c.req.path, err: String(err), stack: (err as Error).stack });
    return c.json({ code: 'INTERNAL', message: 'サーバー内部でエラーが発生しました', requestId }, 500);
  });
  app.notFound((c) => {
    if (c.req.path.startsWith('/v1') || c.req.path.startsWith('/integrations')) {
      return c.json({ code: 'NOT_FOUND', message: 'エンドポイントが見つかりません', requestId: c.get('requestId') }, 404);
    }
    return c.text('Not Found', 404);
  });

  app.get('/v1/health', (c) =>
    c.json({ ok: true, mode: 'local', inflightSteps: s.engine.inflightCount(), sseClients: s.bus.subscriberCount() }),
  );

  /** GitHub Webhook（ユーザー API とは分離: 基本設計書 6.1）。既定は無効（ポーリングで代える）。PAW_GITHUB_WEBHOOK=1 のときだけ受ける */
  if (s.config.githubWebhookEnabled) app.post('/integrations/github/webhook', async (c) => {
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_WEBHOOK_BYTES) return c.json({ status: 'rejected', code: 'PAYLOAD_TOO_LARGE' }, 413);
    const raw = Buffer.from(await c.req.arrayBuffer());
    const res = await receiveGithubWebhook(s.db, s.config, raw, { get: (n) => c.req.header(n) ?? null });
    if (res.status === 202) void s.dispatcher.drain();
    return c.json(res.body, res.status as 200);
  });

  app.use('/v1/*', csrfGuard(s));
  registerAuthRoutes(app, s);
  app.use('/v1/*', async (c, next) => {
    if (c.req.path.startsWith('/v1/auth/') || c.req.path === '/v1/health') return next();
    return requireAuth(s)(c, next);
  });
  registerWorkspaceRoutes(app, s);
  registerProjectRoutes(app, s);
  registerRunRoutes(app, s);
  registerIssueRoutes(app, s);
  registerApprovalRoutes(app, s);
  registerEventRoutes(app, s);
  if (s.config.enableDevRoutes) registerDevRoutes(app, s);

  // ビルド済み SPA の配信（pnpm start）。/v1 と /integrations 以外は index.html にフォールバック
  if (s.config.serveWebDist && existsSync(resolve(s.config.serveWebDist, 'index.html'))) {
    const dist = s.config.serveWebDist;
    const indexHtml = readFileSync(resolve(dist, 'index.html'), 'utf8');
    const types: Record<string, string> = {
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.json': 'application/json',
      '.ico': 'image/x-icon',
    };
    app.get('*', (c) => {
      const path = decodeURIComponent(new URL(c.req.url).pathname);
      if (path.startsWith('/v1') || path.startsWith('/integrations')) return c.notFound();
      const file = resolve(dist, `.${path}`);
      if (file.startsWith(resolve(dist)) && path !== '/' && existsSync(file)) {
        const ext = file.slice(file.lastIndexOf('.'));
        c.header('Content-Type', types[ext] ?? 'application/octet-stream');
        if (path.startsWith('/assets/')) c.header('Cache-Control', 'public, max-age=31536000, immutable');
        return c.body(readFileSync(file));
      }
      return c.html(indexHtml);
    });
  }

  return app;
}
