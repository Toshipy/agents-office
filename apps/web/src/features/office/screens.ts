/**
 * モニター画面のテクスチャ。状態ごとに 1 枚を共有し、低頻度で再描画する（描画コスト削減）。
 */
import * as THREE from 'three';
import type { AgentVisualStatus } from '@paw/contracts';

const W = 256;
const H = 152;

interface Screen {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
}

const screens = new Map<AgentVisualStatus, Screen>();
const CODE_COLORS = ['#5eead4', '#a5b4fc', '#94a3b8', '#f0abfc', '#fcd34d', '#94a3b8', '#94a3b8'];
const lines = Array.from({ length: 40 }, (_, i) => ({
  indent: (i * 7) % 4,
  len: 18 + ((i * 37) % 60),
  color: CODE_COLORS[(i * 5) % CODE_COLORS.length],
  tokens: 1 + ((i * 3) % 3),
}));

function make(status: AgentVisualStatus): Screen {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const s = { canvas, ctx, texture };
  draw(status, s, 0);
  return s;
}

export function screenTexture(status: AgentVisualStatus): THREE.CanvasTexture {
  let s = screens.get(status);
  if (!s) {
    s = make(status);
    screens.set(status, s);
  }
  return s.texture;
}

function frame(ctx: CanvasRenderingContext2D, bg: string, top: string) {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, 14);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(10 + i * 9, 7, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function centerGlyph(ctx: CanvasRenderingContext2D, glyph: string, label: string, color: string, t: number) {
  const pulse = 0.75 + Math.sin(t * 4) * 0.25;
  ctx.globalAlpha = pulse;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(W / 2, H / 2 - 4, 34, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0b1220';
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, W / 2, H / 2 - 2);
  ctx.fillStyle = color;
  ctx.font = 'bold 15px ui-monospace, monospace';
  ctx.fillText(label, W / 2, H - 18);
}

function draw(status: AgentVisualStatus, s: Screen, t: number) {
  const { ctx } = s;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  switch (status) {
    case 'working': {
      frame(ctx, '#0a1120', '#13203a');
      const scroll = (t * 16) % 12;
      const first = Math.floor(t * 1.333);
      for (let r = 0; r < 12; r++) {
        const ln = lines[(first + r) % lines.length];
        const y = 24 + r * 11 - scroll;
        if (y < 16) continue;
        ctx.fillStyle = '#334155';
        ctx.fillRect(6, y - 5, 10, 4);
        let x = 22 + ln.indent * 10;
        for (let k = 0; k < ln.tokens; k++) {
          const w = (ln.len / ln.tokens) * (k === 0 ? 1.1 : 0.9);
          ctx.fillStyle = k === 0 ? ln.color : '#64748b';
          ctx.fillRect(x, y - 6, w, 5);
          x += w + 6;
        }
      }
      if (Math.floor(t * 2) % 2 === 0) {
        ctx.fillStyle = '#5eead4';
        ctx.fillRect(22, H - 12, 7, 9);
      }
      break;
    }
    case 'reviewing': {
      frame(ctx, '#0a1120', '#14233f');
      for (let r = 0; r < 11; r++) {
        const y = 26 + r * 11;
        const kind = (r * 7) % 5;
        ctx.fillStyle = kind === 0 ? 'rgba(52,211,153,0.22)' : kind === 1 ? 'rgba(248,113,113,0.2)' : 'transparent';
        ctx.fillRect(4, y - 8, W - 8, 10);
        ctx.fillStyle = kind === 0 ? '#34d399' : kind === 1 ? '#f87171' : '#64748b';
        ctx.fillRect(10, y - 5, 5, 4);
        ctx.fillStyle = '#94a3b8';
        ctx.fillRect(22, y - 5, 40 + ((r * 29) % 120), 4);
      }
      const band = 22 + ((t * 30) % (H - 30));
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 2;
      ctx.strokeRect(3, band - 8, W - 6, 13);
      break;
    }
    case 'waiting_approval':
      frame(ctx, '#1c1407', '#2b1d07');
      centerGlyph(ctx, '!', 'NEEDS HUMAN', '#fbbf24', t);
      break;
    case 'failed':
      frame(ctx, '#1d0b0e', '#2c1015');
      centerGlyph(ctx, '×', 'ERROR', '#f87171', t);
      break;
    case 'completed':
      frame(ctx, '#0b1a10', '#0f2616');
      centerGlyph(ctx, '✓', 'DONE', '#a3e635', t * 0.5);
      break;
    case 'idle': {
      ctx.fillStyle = '#0b0f19';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(148,163,184,0.10)';
      for (let i = 0; i < 6; i++) {
        const x = (W / 2 + Math.cos(t * 0.3 + i) * 80) % W;
        const y = H / 2 + Math.sin(t * 0.4 + i * 1.7) * 45;
        ctx.beginPath();
        ctx.arc(x, y, 3 + (i % 3), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
  }
  s.texture.needsUpdate = true;
}

let lastDraw = 0;
/** useFrame から呼ぶ。約 8fps で再描画 */
export function tickScreens(elapsed: number, lowPower: boolean) {
  const interval = lowPower ? 0.5 : 0.12;
  if (elapsed - lastDraw < interval) return;
  lastDraw = elapsed;
  for (const [status, s] of screens) draw(status, s, elapsed);
}
