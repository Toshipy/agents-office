/**
 * オフィス画面の状態。サーバーのスナップショットが唯一の正（ADR-013）。
 * イベントは即時の見た目更新に使い、その後スナップショットを再取得して整合させる。
 */
import { create } from 'zustand';
import type { OfficeState, SeatViewModel, StepLogLine } from '@paw/contracts';

export type ConnectionMode = 'connecting' | 'live' | 'polling' | 'offline';

export interface Fx {
  id: number;
  kind: 'packet' | 'pulse';
  from: string; // 'hub' | projectId
  to: string;
  color: string;
  createdAt: number;
}

interface OfficeStore {
  snapshot: OfficeState | null;
  lastSequence: number;
  connection: ConnectionMode;
  focusedProjectId: string | null;
  selectedSeatKey: string | null;
  highlightRunId: string | null;
  fx: Fx[];
  logs: Record<string, StepLogLine[]>;
  cameraCommand: { kind: 'zoomIn' | 'zoomOut' | 'reset'; at: number } | null;
  lowPower: boolean;
  mode2d: boolean;

  setSnapshot(s: OfficeState): void;
  patchSeat(seat: SeatViewModel): void;
  setLastSequence(n: number): void;
  setConnection(c: ConnectionMode): void;
  focusProject(id: string | null): void;
  selectSeat(key: string | null): void;
  setHighlightRun(id: string | null): void;
  pushFx(f: Omit<Fx, 'id' | 'createdAt'>): void;
  pruneFx(now: number): void;
  appendLogs(lines: StepLogLine[]): void;
  camera(kind: 'zoomIn' | 'zoomOut' | 'reset'): void;
  setLowPower(v: boolean): void;
  setMode2d(v: boolean): void;
  reset(): void;
}

let fxSeq = 1;
const MAX_LOG_LINES = 300;

function readPref(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function writePref(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export const useOffice = create<OfficeStore>((set, get) => ({
  snapshot: null,
  lastSequence: 0,
  connection: 'connecting',
  focusedProjectId: null,
  selectedSeatKey: null,
  highlightRunId: null,
  fx: [],
  logs: {},
  cameraCommand: null,
  lowPower: readPref('paw.lowPower'),
  mode2d: readPref('paw.mode2d'),

  setSnapshot: (s) =>
    set((st) => {
      const focusedOk = !st.focusedProjectId || s.projects.some((p) => p.id === st.focusedProjectId);
      const seatOk = !st.selectedSeatKey || s.seats.some((x) => x.key === st.selectedSeatKey);
      return {
        snapshot: s,
        lastSequence: Math.max(st.lastSequence, s.sequence),
        focusedProjectId: focusedOk ? st.focusedProjectId : null,
        selectedSeatKey: seatOk ? st.selectedSeatKey : null,
      };
    }),
  patchSeat: (seat) =>
    set((st) => {
      if (!st.snapshot) return {};
      return {
        snapshot: { ...st.snapshot, seats: st.snapshot.seats.map((x) => (x.key === seat.key ? seat : x)) },
      };
    }),
  setLastSequence: (n) => set({ lastSequence: n }),
  setConnection: (c) => set({ connection: c }),
  focusProject: (id) => set({ focusedProjectId: id, selectedSeatKey: id === null ? null : get().selectedSeatKey }),
  selectSeat: (key) =>
    set(() => {
      if (!key) return { selectedSeatKey: null };
      const projectId = key.split(':')[0];
      return { selectedSeatKey: key, focusedProjectId: projectId };
    }),
  setHighlightRun: (id) => set({ highlightRunId: id }),
  pushFx: (f) => set((st) => ({ fx: [...st.fx.slice(-40), { ...f, id: fxSeq++, createdAt: performance.now() }] })),
  pruneFx: (now) =>
    set((st) => {
      const keep = st.fx.filter((f) => now - f.createdAt < 2200);
      return keep.length === st.fx.length ? st : { fx: keep };
    }),
  appendLogs: (lines) =>
    set((st) => {
      if (lines.length === 0) return {};
      const logs = { ...st.logs };
      for (const l of lines) {
        const cur = logs[l.stepId] ?? [];
        if (cur.some((x) => x.id === l.id)) continue;
        const next = [...cur, l].sort((a, b) => a.id - b.id);
        logs[l.stepId] = next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
      }
      return { logs };
    }),
  camera: (kind) => set({ cameraCommand: { kind, at: performance.now() } }),
  setLowPower: (v) => {
    writePref('paw.lowPower', v);
    set({ lowPower: v });
  },
  setMode2d: (v) => {
    writePref('paw.mode2d', v);
    set({ mode2d: v });
  },
  reset: () =>
    set({ snapshot: null, lastSequence: 0, connection: 'connecting', focusedProjectId: null, selectedSeatKey: null, fx: [], logs: {} }),
}));
