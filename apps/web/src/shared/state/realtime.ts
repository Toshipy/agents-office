/**
 * SSE + ポーリングのフォールバック（基本設計書 5.3 / FR-015 / NFR-013）。
 * - 起動時: スナップショット取得 → 連番 S 以降を SSE で購読
 * - 連番が飛んだら スナップショットを再取得
 * - SSE が連続して失敗したらポーリングへ切替、30 秒ごとに SSE を再試行
 */
import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { OfficeState, SeatViewModel, StepLogLine, WorkspaceEvent } from '@paw/contracts';
import { api } from '../api/client';
import { useOffice } from './office';
import { toast } from '../ui/toast';

const ROLE_COLORS: Record<string, string> = {
  planner: '#a5b4fc',
  developer: '#5eead4',
  tester: '#fcd34d',
  reviewer: '#93c5fd',
  tool_broker: '#f0abfc',
};

class RealtimeClient {
  private es: EventSource | null = null;
  private pollTimer: number | null = null;
  private retryTimer: number | null = null;
  private refetchTimer: number | null = null;
  private failures = 0;
  private stopped = false;
  private fetching = false;

  constructor(private readonly qc: QueryClient) {}

  async start() {
    this.stopped = false;
    await this.refetchSnapshot();
    this.openSse();
  }

  stop() {
    this.stopped = true;
    this.es?.close();
    this.es = null;
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    if (this.refetchTimer) window.clearTimeout(this.refetchTimer);
  }

  async refetchSnapshot() {
    if (this.fetching) return;
    this.fetching = true;
    try {
      const snap = await api.get<OfficeState>('/v1/workspaces/me/office-state');
      // setSnapshot は連番を max で更新する（古いスナップショットで連番を巻き戻さない）
      useOffice.getState().setSnapshot(snap);
    } catch {
      /* 次のイベント / ポーリングで再試行 */
    } finally {
      this.fetching = false;
    }
  }

  private scheduleRefetch(delay = 350) {
    if (this.refetchTimer) return;
    this.refetchTimer = window.setTimeout(() => {
      this.refetchTimer = null;
      void this.refetchSnapshot();
    }, delay);
  }

  private openSse() {
    if (this.stopped) return;
    const after = useOffice.getState().lastSequence;
    const es = new EventSource(`/v1/events/stream?after=${after}`, { withCredentials: true });
    this.es = es;
    useOffice.getState().setConnection('connecting');
    es.addEventListener('ready', () => {
      this.failures = 0;
      if (this.pollTimer) {
        window.clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      useOffice.getState().setConnection('live');
    });
    es.addEventListener('event', (m) => this.onEvent(JSON.parse((m as MessageEvent).data) as WorkspaceEvent));
    es.addEventListener('transient', (m) => this.onTransient(JSON.parse((m as MessageEvent).data) as WorkspaceEvent));
    es.addEventListener('resync', () => void this.refetchSnapshot());
    es.onerror = () => {
      this.failures += 1;
      if (this.failures >= 3) {
        es.close();
        this.es = null;
        this.startPolling();
      } else {
        useOffice.getState().setConnection('connecting');
      }
    };
  }

  private startPolling() {
    if (this.stopped) return;
    useOffice.getState().setConnection('polling');
    if (!this.pollTimer) {
      this.pollTimer = window.setInterval(() => void this.poll(), 3000);
      void this.poll();
    }
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.failures = 0;
      this.openSse();
    }, 30_000);
  }

  private async poll() {
    try {
      const after = useOffice.getState().lastSequence;
      const res = await api.get<{ events: WorkspaceEvent[]; sequence: number; resync: boolean }>(`/v1/events?after=${after}`);
      if (res.resync) await this.refetchSnapshot();
      else for (const e of res.events) this.onEvent(e);
      if (useOffice.getState().connection === 'offline') useOffice.getState().setConnection('polling');
    } catch {
      useOffice.getState().setConnection('offline');
    }
  }

  private onTransient(e: WorkspaceEvent) {
    if (e.type === 'step.log') {
      const line = (e.data as { line: StepLogLine }).line;
      useOffice.getState().appendLogs([line]);
    }
  }

  private onEvent(e: WorkspaceEvent) {
    const st = useOffice.getState();
    if (e.sequence === null) return;
    if (e.sequence <= st.lastSequence) return; // 既に反映済み
    if (e.sequence !== st.lastSequence + 1) {
      // 取りこぼし → スナップショットで復元（連番が飛んだ場合: 基本設計書 5.3）
      st.setLastSequence(e.sequence);
      void this.refetchSnapshot();
      this.invalidateAll();
      return;
    }
    st.setLastSequence(e.sequence);
    this.applyFx(e);
    switch (e.type) {
      case 'agent.status_changed':
        st.patchSeat((e.data as { seat: SeatViewModel }).seat);
        return;
      case 'approval.requested':
        toast({ tone: 'warn', title: '承認待ちが追加されました', body: String(e.data.title ?? ''), href: '/approvals' });
        break;
      case 'run.completed':
        if (e.data.status === 'failed') {
          toast({ tone: 'error', title: 'Run が失敗しました', body: String(e.data.errorCode ?? ''), href: e.runId ? `/runs/${e.runId}` : undefined });
        }
        break;
      case 'policy.denied':
        toast({ tone: 'info', title: 'ポリシーが操作を拒否しました', body: `${e.data.tool}`, href: e.runId ? `/runs/${e.runId}` : undefined });
        break;
    }
    this.scheduleRefetch();
    if (e.type.startsWith('run.') || e.type.startsWith('step.') || e.type === 'artifact.created') {
      void this.qc.invalidateQueries({ queryKey: ['runs'] });
      if (e.runId) void this.qc.invalidateQueries({ queryKey: ['run', e.runId] });
    }
    if (e.type.startsWith('approval.')) {
      void this.qc.invalidateQueries({ queryKey: ['approvals'] });
      if (e.runId) void this.qc.invalidateQueries({ queryKey: ['run', e.runId] });
    }
    if (e.type === 'project.updated') void this.qc.invalidateQueries({ queryKey: ['projects'] });
    if (e.type === 'workspace.updated') {
      void this.qc.invalidateQueries({ queryKey: ['me'] });
      void this.qc.invalidateQueries({ queryKey: ['usage'] });
    }
    if (e.type.startsWith('webhook.')) void this.qc.invalidateQueries({ queryKey: ['events-feed'] });
  }

  private invalidateAll() {
    for (const k of ['runs', 'run', 'approvals', 'projects', 'usage']) void this.qc.invalidateQueries({ queryKey: [k] });
  }

  private applyFx(e: WorkspaceEvent) {
    const st = useOffice.getState();
    const pid = e.projectId;
    switch (e.type) {
      case 'run.created':
        if (pid) st.pushFx({ kind: 'packet', from: 'hub', to: pid, color: '#c7d2fe' });
        break;
      case 'step.started':
        if (pid) st.pushFx({ kind: 'packet', from: 'hub', to: pid, color: ROLE_COLORS[String(e.data.role)] ?? '#e2e8f0' });
        break;
      case 'artifact.created':
        if (pid && e.data.kind === 'draft_pr') st.pushFx({ kind: 'packet', from: pid, to: 'hub', color: '#86efac' });
        break;
      case 'approval.requested':
        if (pid) st.pushFx({ kind: 'pulse', from: pid, to: pid, color: '#fbbf24' });
        break;
      case 'webhook.received':
        st.pushFx({ kind: 'pulse', from: 'hub', to: 'hub', color: '#60a5fa' });
        break;
      case 'webhook.ignored':
        st.pushFx({ kind: 'pulse', from: 'hub', to: 'hub', color: '#64748b' });
        break;
      case 'policy.denied':
        if (pid) st.pushFx({ kind: 'pulse', from: pid, to: pid, color: '#f87171' });
        break;
    }
  }
}

export function useRealtime(qc: QueryClient, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const client = new RealtimeClient(qc);
    void client.start();
    return () => {
      client.stop();
      useOffice.getState().reset();
    };
  }, [qc, enabled]);
}
