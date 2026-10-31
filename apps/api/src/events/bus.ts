/**
 * Workspace 単位のイベントバス（基本設計書 5.3）。
 * - 永続イベント: event_logs に Workspace 内連番 sequence 付きで保存し、SSE で配信
 * - 一時イベント（step.log）: 連番なし・非永続。ライブ表示専用（正本は step_logs テーブル）
 * 購読は必ず workspaceId 単位。別 Workspace のイベントは配信しない（基本設計書 7.3）。
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { EventType, TransientEventType, WorkspaceEvent } from '@paw/contracts';
import type { Db } from '../db/client';
import { eventLogs } from '../db/schema';
import { newId } from '../lib/ids';
import { Mutex } from '../lib/mutex';
import { log } from '../lib/logger';

type Listener = (event: WorkspaceEvent) => void;

export interface EmitOptions {
  runId?: string | null;
  projectId?: string | null;
}

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();
  private anyListeners = new Set<Listener>();
  private mutex = new Mutex();

  constructor(private readonly db: Db) {}

  subscribe(workspaceId: string, listener: Listener): () => void {
    let set = this.listeners.get(workspaceId);
    if (!set) {
      set = new Set();
      this.listeners.set(workspaceId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(workspaceId);
    };
  }

  /** サーバー内部用（全 Workspace のイベントを受け取る）。クライアントへの配信には使わない */
  onAny(listener: Listener): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  subscriberCount(workspaceId?: string): number {
    if (workspaceId) return this.listeners.get(workspaceId)?.size ?? 0;
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  /** 永続イベント。連番の付与と配信順序をプロセス内で直列化する */
  emit(
    workspaceId: string,
    type: EventType,
    data: Record<string, unknown>,
    opts: EmitOptions = {},
  ): Promise<WorkspaceEvent> {
    return this.mutex.run(async () => {
      const id = newId('evt');
      const occurredAt = new Date();
      const result = await this.db.execute<{ sequence: number | string }>(sql`
        WITH s AS (
          UPDATE workspaces SET event_sequence = event_sequence + 1
          WHERE id = ${workspaceId}
          RETURNING event_sequence
        )
        INSERT INTO event_logs (id, workspace_id, run_id, project_id, sequence, event_type, occurred_at, meta)
        SELECT ${id}, ${workspaceId}, ${opts.runId ?? null}, ${opts.projectId ?? null}, s.event_sequence,
               ${type}, ${occurredAt.toISOString()}, ${JSON.stringify(data)}::jsonb
        FROM s
        RETURNING sequence
      `);
      const row = result.rows[0];
      if (!row) throw new Error(`workspace not found for event: ${workspaceId}`);
      const event: WorkspaceEvent = {
        eventId: id,
        workspaceId,
        sequence: Number(row.sequence),
        type,
        occurredAt: occurredAt.toISOString(),
        runId: opts.runId ?? null,
        projectId: opts.projectId ?? null,
        data,
      };
      this.publish(event);
      return event;
    });
  }

  emitTransient(
    workspaceId: string,
    type: TransientEventType,
    data: Record<string, unknown>,
    opts: EmitOptions = {},
  ): void {
    this.publish({
      eventId: newId('tev'),
      workspaceId,
      sequence: null,
      type,
      occurredAt: new Date().toISOString(),
      runId: opts.runId ?? null,
      projectId: opts.projectId ?? null,
      data,
    });
  }

  private publish(event: WorkspaceEvent) {
    for (const l of this.anyListeners) {
      try {
        l(event);
      } catch (err) {
        log.warn('internal event listener failed', { err: String(err) });
      }
    }
    const set = this.listeners.get(event.workspaceId);
    if (!set) return;
    for (const l of set) {
      try {
        l(event);
      } catch (err) {
        log.warn('event listener failed', { err: String(err) });
      }
    }
  }

  /** 再接続時の差分取得（Last-Event-ID 以降）。上限を超える場合は呼び出し側でスナップショットを再取得させる */
  async since(workspaceId: string, afterSequence: number, limit = 500): Promise<WorkspaceEvent[]> {
    const rows = await this.db
      .select()
      .from(eventLogs)
      .where(and(eq(eventLogs.workspaceId, workspaceId), gt(eventLogs.sequence, afterSequence)))
      .orderBy(asc(eventLogs.sequence))
      .limit(limit);
    return rows.map((r) => ({
      eventId: r.id,
      workspaceId: r.workspaceId,
      sequence: r.sequence,
      type: r.eventType as EventType,
      occurredAt: r.occurredAt.toISOString(),
      runId: r.runId,
      projectId: r.projectId,
      data: r.meta,
    }));
  }
}
