/**
 * GitHub Webhook 受信（基本設計書 10.1）。
 * 1. raw body に対し X-Hub-Signature-256（HMAC-SHA256）を定数時間比較で検証
 * 2. サイズ・Content-Type・イベント種別・Delivery ID の基本チェック
 * 3. provider + delivery_id の一意制約で冪等化し、永続キュー（SQS 代替）へ保存して即 202
 * 処理（Run 作成など）は Dispatcher が非同期に行う。
 */
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import { webhookDeliveries } from '../db/schema';
import { hmacSha256Hex, safeEqual } from '../lib/crypto';
import { log } from '../lib/logger';

export const MAX_WEBHOOK_BYTES = 1024 * 1024;
const SUPPORTED_EVENTS = new Set(['issues', 'pull_request_review', 'pull_request', 'ping']);

export interface WebhookResult {
  status: number;
  body: { status: string; deliveryId?: string; code?: string; message?: string };
}

export function signGithubPayload(secret: string, raw: Buffer | string): string {
  return `sha256=${hmacSha256Hex(secret, raw)}`;
}

export async function receiveGithubWebhook(
  db: Db,
  config: AppConfig,
  raw: Buffer,
  headers: { get(name: string): string | null | undefined },
): Promise<WebhookResult> {
  const contentType = headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return { status: 415, body: { status: 'rejected', code: 'UNSUPPORTED_MEDIA_TYPE' } };
  }
  if (raw.byteLength > MAX_WEBHOOK_BYTES) {
    return { status: 413, body: { status: 'rejected', code: 'PAYLOAD_TOO_LARGE' } };
  }
  const signature = headers.get('x-hub-signature-256') ?? '';
  const expected = signGithubPayload(config.githubWebhookSecret, raw);
  if (!signature || !safeEqual(signature, expected)) {
    log.warn('webhook rejected: bad HMAC', { present: Boolean(signature) });
    return { status: 401, body: { status: 'rejected', code: 'INVALID_SIGNATURE' } };
  }
  const event = headers.get('x-github-event') ?? '';
  const deliveryId = headers.get('x-github-delivery') ?? '';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(deliveryId) || !/^[a-z_]{2,40}$/.test(event)) {
    return { status: 400, body: { status: 'rejected', code: 'INVALID_HEADERS' } };
  }
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(raw.toString('utf8')) as Record<string, any>;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('not an object');
  } catch {
    return { status: 400, body: { status: 'rejected', code: 'INVALID_JSON' } };
  }
  const supported = SUPPORTED_EVENTS.has(event);
  const inserted = await db
    .insert(webhookDeliveries)
    .values({
      provider: 'github',
      deliveryId,
      eventType: event,
      action: typeof payload.action === 'string' ? payload.action.slice(0, 40) : null,
      installationId: Number.isSafeInteger(payload.installation?.id) ? payload.installation.id : null,
      repositoryId: Number.isSafeInteger(payload.repository?.id) ? payload.repository.id : null,
      payload,
      ...(supported ? {} : { processedAt: sql`now()`, outcome: 'unsupported_event' }),
    })
    .onConflictDoNothing()
    .returning({ deliveryId: webhookDeliveries.deliveryId });
  if (inserted.length === 0) {
    return { status: 200, body: { status: 'duplicate', deliveryId } };
  }
  return { status: 202, body: { status: supported ? 'accepted' : 'ignored', deliveryId } };
}
