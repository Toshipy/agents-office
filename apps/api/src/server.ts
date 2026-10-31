import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { loadConfig, REPO_ROOT } from './config';
import { createApp, createServices } from './app';
import { DemoTraffic } from './demo/traffic';
import { log, setLogLevel } from './lib/logger';
import { seedIfEmpty } from './seed';
import { resolveAgentRuntime } from './agents/claude/detect';

async function main() {
  const isStart = process.env.npm_lifecycle_event === 'start';
  const config = loadConfig({
    serveWebDist: isStart ? resolve(REPO_ROOT, 'apps/web/dist') : null,
  });
  setLogLevel(config.logLevel);
  await resolveAgentRuntime(config);
  log.info('agent runtime', { runtime: config.agentRuntime, reason: config.agentRuntimeReason });
  const services = await createServices(config);
  const app = createApp(services);
  if (config.seedDemo) await seedIfEmpty(services);
  await services.engine.start();
  services.dispatcher.start();
  services.seats.start();
  const demo = new DemoTraffic(services);
  if (config.enableDevRoutes) demo.start();

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    log.info('api listening', { url: `http://${info.address}:${info.port}`, dataDir: config.dataDir, serveWeb: Boolean(config.serveWebDist) });
    if (config.serveWebDist) {
      process.stdout.write(`\n  ▸ Personal AI Workspace (local): http://localhost:${info.port}\n\n`);
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    demo.stop();
    services.dispatcher.stop();
    services.seats.stop();
    await services.engine.stop();
    server.close();
    await services.client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('fatal', { err: String(err), stack: (err as Error).stack });
  process.exit(1);
});
