/**
 * リアルタイム更新（基本設計書 5.3 / FR-015）。
 * - SSE: 認可済み Workspace のイベントのみ配信。Last-Event-ID（または ?after=）以降を再送してからライブ配信
 * - 差分が大きすぎる場合は resync を送り、クライアントにスナップショット再取得を促す
 * - ポーリング: GET /v1/events?after=N（SSE が使えない環境向けフォールバック）
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { eq } from 'drizzle-orm';
import type { WorkspaceEvent } from '@paw/contracts';
import type { AppEnv, Services } from '../app';
import { workspaces } from '../db/schema';
import { auth } from './helpers';

const REPLAY_LIMIT = 500;

function parseAfter(v: string | undefined | null): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function registerEventRoutes(app: Hono<AppEnv>, s: Services) {
  app.get('/v1/events', async (c) => {
    const a = auth(c);
    const after = parseAfter(c.req.query('after')) ?? 0;
    const [ws] = await s.db.select({ seq: workspaces.eventSequence }).from(workspaces).where(eq(workspaces.id, a.workspaceId));
    const events = await s.bus.since(a.workspaceId, after, REPLAY_LIMIT + 1);
    const resync = events.length > REPLAY_LIMIT;
    return c.json({ events: resync ? [] : events, sequence: ws.seq, resync });
  });

  app.get('/v1/events/stream', async (c) => {
    const a = auth(c);
    const after = parseAfter(c.req.header('last-event-id')) ?? parseAfter(c.req.query('after'));
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const queue: WorkspaceEvent[] = [];
      let wake: (() => void) | null = null;
      let replaying = true;
      const buffered: WorkspaceEvent[] = [];
      const unsubscribe = s.bus.subscribe(a.workspaceId, (e) => {
        if (replaying) buffered.push(e);
        else queue.push(e);
        wake?.();
      });
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wake?.();
      });
      const send = async (e: WorkspaceEvent) => {
        await stream.writeSSE({
          ...(e.sequence !== null ? { id: String(e.sequence) } : {}),
          event: e.sequence !== null ? 'event' : 'transient',
          data: JSON.stringify(e),
        });
      };
      try {
        let lastSent = after ?? 0;
        if (after !== null) {
          const missed = await s.bus.since(a.workspaceId, after, REPLAY_LIMIT + 1);
          if (missed.length > REPLAY_LIMIT) {
            await stream.writeSSE({ event: 'resync', data: JSON.stringify({ reason: 'too_many_missed_events' }) });
          } else {
            for (const e of missed) {
              await send(e);
              lastSent = e.sequence ?? lastSent;
            }
          }
        }
        replaying = false;
        for (const e of buffered) if (e.sequence === null || e.sequence > lastSent) queue.push(e);
        buffered.length = 0;
        await stream.writeSSE({ event: 'ready', data: JSON.stringify({ workspaceId: a.workspaceId }) });
        let lastBeat = Date.now();
        while (!closed) {
          while (queue.length && !closed) await send(queue.shift()!);
          if (Date.now() - lastBeat > 15_000) {
            await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
            lastBeat = Date.now();
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 5_000);
          });
          wake = null;
        }
      } finally {
        unsubscribe();
      }
    });
  });
}
