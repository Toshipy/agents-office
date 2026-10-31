/**
 * My Office（UI-02 / 基本設計書 5.4 /office）。
 */
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useOffice } from '../../shared/state/office';
import { Icon } from '../../shared/ui/Icon';
import { AGENT_STATUS_META } from '../../shared/ui/status';
import { AGENT_STATUS_LABEL, AGENT_VISUAL_STATUSES } from '@paw/contracts';
import { LeftPanel } from './LeftPanel';
import { TaskStatusPanel } from './TaskStatusPanel';
import { Office2D } from './Office2D';
import { OfficeCanvas } from './OfficeCanvas';

function detectWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

class CanvasBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const LEFT_W = 348;
const RIGHT_W = 372;

export function OfficePage() {
  const snapshot = useOffice((s) => s.snapshot);
  const mode2d = useOffice((s) => s.mode2d);
  const setMode2d = useOffice((s) => s.setMode2d);
  const lowPower = useOffice((s) => s.lowPower);
  const setLowPower = useOffice((s) => s.setLowPower);
  const camera = useOffice((s) => s.camera);
  const focusProject = useOffice((s) => s.focusProject);
  const selectSeat = useOffice((s) => s.selectSeat);
  const webgl = useMemo(detectWebGL, []);
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });

  const hasSnapshot = Boolean(snapshot);
  // スナップショット取得後に stage が描画されるため、その時点で監視を開始する
  useEffect(() => {
    const el = stage.current;
    const outer = root.current;
    if (!el || !outer) return;
    const measure = () => setSize({ w: outer.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(outer);
    measure();
    return () => ro.disconnect();
  }, [hasSnapshot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        const st = useOffice.getState();
        if (st.selectedSeatKey) selectSeat(null);
        else focusProject(null);
      } else if (e.key === '+' || e.key === '=') camera('zoomIn');
      else if (e.key === '-') camera('zoomOut');
      else if (e.key === '0') {
        focusProject(null);
        camera('reset');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [camera, focusProject, selectSeat]);

  if (!snapshot) {
    return (
      <div className="office-loading">
        <div className="spinner" />
        <span>オフィスを読み込み中…</span>
      </div>
    );
  }

  const narrow = size.w < 1100;
  const left = narrow ? 0 : LEFT_W + 24;
  const right = narrow ? 0 : RIGHT_W + 24;
  const viewport = { width: size.w - left - right, height: size.h - (narrow ? 10 : 40), offsetX: (left - right) / 2 };
  const show3d = webgl && !mode2d;
  const fallback = <Office2D snapshot={snapshot} reason="3D 表示を開始できなかったため 2D 表示に切り替えました" />;

  return (
    <div className={`office${narrow ? ' narrow' : ''}`} ref={root}>
      <div className="stage" ref={stage}>
        {show3d ? (
          <CanvasBoundary fallback={fallback}>
            <OfficeCanvas snapshot={snapshot} viewport={viewport} />
          </CanvasBoundary>
        ) : (
          <Office2D snapshot={snapshot} reason={webgl ? undefined : 'この環境では WebGL が使えないため 2D 表示です'} />
        )}
      </div>
      <LeftPanel snapshot={snapshot} />
      <TaskStatusPanel snapshot={snapshot} />
      <div className="legend" aria-label="状態の凡例">
        {AGENT_VISUAL_STATUSES.map((s) => (
          <span key={s} className={`legend-item agent-${s}`}>
            <Icon name={AGENT_STATUS_META[s].icon} size={12} /> {AGENT_STATUS_LABEL[s]}
          </span>
        ))}
      </div>
      <div className="zoom-controls" role="toolbar" aria-label="表示操作">
        {show3d ? (
          <>
            <button className="icon-btn" onClick={() => camera('zoomIn')} aria-label="ズームイン" title="ズームイン (+)">
              <Icon name="plus" />
            </button>
            <button className="icon-btn" onClick={() => camera('zoomOut')} aria-label="ズームアウト" title="ズームアウト (-)">
              <Icon name="minus" />
            </button>
            <button
              className="icon-btn"
              onClick={() => {
                focusProject(null);
                camera('reset');
              }}
              aria-label="視点を初期化"
              title="視点を初期化 (0)"
            >
              <Icon name="home" />
            </button>
            <button className={`icon-btn${lowPower ? ' on' : ''}`} onClick={() => setLowPower(!lowPower)} aria-pressed={lowPower} aria-label="低負荷表示" title="低負荷表示（影・パーティクルを省略）">
              <Icon name="power" />
            </button>
          </>
        ) : null}
        {webgl ? (
          <button className="icon-btn" onClick={() => setMode2d(!mode2d)} aria-label={mode2d ? '3D 表示に切替' : '2D 表示に切替'} title={mode2d ? '3D 表示' : '2D 表示'}>
            <Icon name={mode2d ? 'cube' : 'layers'} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
