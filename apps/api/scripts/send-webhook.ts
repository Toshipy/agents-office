/**
 * 署名付き GitHub Webhook をローカル API に送る CLI（本番と同じ受信経路の確認用）。
 *
 *   pnpm webhook:send -- --repo alice/storefront-web --installation 12345 --title "CSV エクスポート" --label ai:ready
 *   pnpm webhook:send -- --repo alice/storefront-web --installation 12345 --forge   # 不正署名（401 になる）
 *
 * Installation ID は Projects 画面の Repo 欄に表示されます。
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config';
import { signGithubPayload } from '../src/github/webhook';
import { simulatedRepositoryId } from '../src/github/simulator';

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const repo = arg('repo');
const installation = Number(arg('installation'));
if (!repo || !Number.isSafeInteger(installation)) {
  console.error('usage: --repo owner/name --installation <id> [--title t] [--body b] [--label l] [--delivery id] [--forge]');
  process.exit(2);
}
const config = loadConfig();
const payload = {
  action: 'opened',
  issue: {
    number: Number(arg('number', String(Math.floor(Math.random() * 9000) + 1000))),
    title: arg('title', 'CLI から送信した Issue'),
    body: arg('body', 'scripts/send-webhook.ts から送信'),
    labels: (arg('label', 'ai:ready') ?? '').split(',').filter(Boolean).map((name) => ({ name })),
  },
  repository: { id: simulatedRepositoryId(repo), full_name: repo },
  installation: { id: installation },
  sender: { login: 'cli' },
};
const raw = JSON.stringify(payload);
const secret = process.argv.includes('--forge') ? 'forged-secret' : config.githubWebhookSecret;
const res = await fetch(`http://${config.host}:${config.port}/integrations/github/webhook`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-github-event': 'issues',
    'x-github-delivery': arg('delivery', randomUUID())!,
    'x-hub-signature-256': signGithubPayload(secret, raw),
  },
  body: raw,
});
console.log(res.status, await res.text());
