/**
 * 3D オフィスの配置（独自レイアウト: 中央の Dispatch Hub を Project の島が囲む）。
 */
import type { AgentRole } from '@paw/contracts';

export const ISLAND_SIZE = 7.2;
export const ISLAND_HEIGHT = 0.7;
export const HUB_RADIUS = 3.1;

/** 島の中心（XZ 平面）。数に応じて円周上に配置 */
export function islandPositions(count: number): [number, number][] {
  if (count === 0) return [];
  const radius = count <= 2 ? 10 : count <= 4 ? 11.5 : count <= 6 ? 13 : 14.5;
  // 画面上部（カメラから遠い側）から時計回りに並べる
  const start = -Math.PI * 0.75;
  return Array.from({ length: count }, (_, i) => {
    const a = start + (i * Math.PI * 2) / count;
    return [Math.cos(a) * radius, Math.sin(a) * radius];
  });
}

export function sceneExtent(count: number): number {
  const pos = islandPositions(count);
  const r = pos.reduce((m, [x, z]) => Math.max(m, Math.hypot(x, z)), HUB_RADIUS);
  return r + ISLAND_SIZE * 0.75;
}

/** 島内の席（ローカル座標）。2×2 */
export const SEAT_OFFSETS: Record<AgentRole, [number, number]> = {
  planner: [-1.55, -1.45],
  developer: [1.55, -1.45],
  tester: [-1.55, 1.55],
  reviewer: [1.55, 1.55],
};

/** 机の向き（画面が手前に見えるよう斜めに配置） */
export const DESK_ROTATION = Math.PI / 4 + 0.55;

export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount))));
  return `#${((1 << 24) | (f(r) << 16) | (f(g) << 8) | f(b)).toString(16).slice(1)}`;
}

export function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}
