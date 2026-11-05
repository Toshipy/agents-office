import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type Me } from '../shared/api/client';
import { useAuthConfig } from '../shared/api/authConfig';
import { useRealtime } from '../shared/state/realtime';
import { useOffice } from '../shared/state/office';
import { Icon } from '../shared/ui/Icon';
import { Toaster } from '../shared/ui/toast';
import { clockTime, usd } from '../shared/ui/format';
import { LOOKS, LOOK_IDS, useLook } from '../shared/look';
import { LoginPage } from '../features/auth/LoginPage';
import { NotAllowedPage } from '../features/auth/NotAllowedPage';
import { OfficePage } from '../features/office/OfficePage';
import { RunListPage } from '../features/runs/RunListPage';
import { RunDetailPage } from '../features/runs/RunDetailPage';
import { ApprovalsPage } from '../features/approvals/ApprovalsPage';
import { ProjectsPage } from '../features/projects/ProjectsPage';
import { SettingsPage } from '../features/settings/SettingsPage';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/v1/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    retry: (count, e) => !(e instanceof ApiError && e.status === 401) && count < 2,
    staleTime: 30_000,
  });
}

export function LookSwitch() {
  const id = useLook((s) => s.id);
  const setLook = useLook((s) => s.setLook);
  return (
    <div className="look-switch" role="radiogroup" aria-label="デザイン案">
      {LOOK_IDS.map((l) => (
        <button key={l} role="radio" aria-checked={id === l} className={id === l ? 'on' : ''} title={`${LOOKS[l].name} — ${LOOKS[l].tagline}`} onClick={() => setLook(l)}>
          <b>{LOOKS[l].label}</b>
          <span className="ln"> {LOOKS[l].name}</span>
        </button>
      ))}
    </div>
  );
}

function useApplyLook() {
  const id = useLook((s) => s.id);
  useEffect(() => {
    document.documentElement.dataset.look = id;
  }, [id]);
}

export function App() {
  useApplyLook();
  const me = useMe();
  const cfg = useAuthConfig();
  const qc = useQueryClient();
  useRealtime(qc, Boolean(me.data));

  // 認証モードが分かるまで待つ（alb_oidc かどうかで未ログイン時の画面が変わる）
  if (me.isLoading || (!me.data && cfg.isLoading)) {
    return (
      <div className="boot">
        <div className="spinner" />
      </div>
    );
  }
  if (me.error && !me.data) {
    return (
      <div className="boot error-text">
        <p>API に接続できません。`pnpm dev` で API が起動しているか確認してください。</p>
        <button className="btn" onClick={() => void me.refetch()}>
          再試行
        </button>
      </div>
    );
  }
  if (!me.data) return cfg.data?.mode === 'alb_oidc' ? <NotAllowedPage /> : <LoginPage />;
  return (
    <>
      <Routes>
        <Route element={<Shell me={me.data} />}>
          <Route path="/" element={<Navigate to="/office" replace />} />
          <Route path="/office" element={<OfficePage />} />
          <Route path="/runs" element={<RunListPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/office" replace />} />
        </Route>
      </Routes>
      <Toaster />
    </>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const h = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(h);
  }, []);
  return <span className="clock mono">{clockTime(now)}</span>;
}

function ConnectionBadge() {
  const c = useOffice((s) => s.connection);
  const label = c === 'live' ? 'LIVE' : c === 'polling' ? 'POLLING' : c === 'offline' ? 'OFFLINE' : '接続中';
  const title =
    c === 'live'
      ? 'SSE でリアルタイム更新中'
      : c === 'polling'
        ? 'SSE が使えないため 3 秒ごとのポーリングで更新中'
        : c === 'offline'
          ? 'サーバーに接続できません'
          : '接続中…';
  return (
    <span className={`conn conn-${c}`} title={title}>
      <span className="conn-dot" /> {label}
    </span>
  );
}

function Shell({ me }: { me: Me }) {
  const snapshot = useOffice((s) => s.snapshot);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pending = snapshot?.approvalsPending ?? 0;
  const paused = snapshot?.workspace.settings.paused ?? me.workspace.settings.paused;
  const albOidc = useAuthConfig().data?.mode === 'alb_oidc';
  const logout = async () => {
    try {
      await api.post('/v1/auth/logout');
    } catch {
      // サーバー側のセッションが既に無い場合も、画面はログアウト状態にする
    }
    if (albOidc) {
      // ALB のセッション Cookie はログアウト API が消した。読み直して ALB に再ログインさせる
      location.assign('/');
      return;
    }
    // 先にログイン情報を「未ログイン」にしてログイン画面へ切り替える。
    // qc.clear() で me ごと消すと、表示中のコンポーネントが古いログイン情報を持ったまま読み込み中で止まる
    qc.setQueryData(['me'], null);
    useOffice.getState().reset();
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    navigate('/office');
  };
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
            <defs>
              <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#8b9cff" />
                <stop offset="1" stopColor="#5eead4" />
              </linearGradient>
            </defs>
            <path d="M16 4 27 10v12L16 28 5 22V10z" fill="none" stroke="url(#bg)" strokeWidth="2.4" strokeLinejoin="round" />
            <circle cx="16" cy="16" r="3.6" fill="url(#bg)" />
          </svg>
          <span className="brand-name">Personal AI Workspace</span>
          <span className="brand-ws">· {me.workspace.name}</span>
          {(window as unknown as { __PAW_DEMO__?: boolean }).__PAW_DEMO__ ? (
            <span className="local-badge" title="ブラウザだけで動くデモです。AI 実行と GitHub はシミュレーションです">DEMO</span>
          ) : (
            <ModeBadge />
          )}
        </div>
        <nav className="nav">
          <NavLink to="/office">
            <Icon name="office" size={15} /> Office
          </NavLink>
          <NavLink to="/runs">
            <Icon name="list" size={15} /> Runs
          </NavLink>
          <NavLink to="/approvals">
            <Icon name="hand" size={15} /> 承認
            {pending > 0 ? <span className="nav-badge">{pending}</span> : null}
          </NavLink>
          <NavLink to="/projects">
            <Icon name="folder" size={15} /> Projects
          </NavLink>
          <NavLink to="/settings">
            <Icon name="settings" size={15} /> 設定
          </NavLink>
        </nav>
        <div className="top-right">
          {paused ? (
            <span className="paused-badge" title="キルスイッチで新規 Run の開始を停止中">
              <Icon name="pause" size={12} /> 停止中
            </span>
          ) : null}
          {snapshot ? (
            <span className="top-budget mono" title="今月の推定費用 / 月間予算">
              <Icon name="dollar" size={13} />
              {usd(snapshot.budget.monthCostUsd)} / {usd(snapshot.budget.monthlyBudgetUsd, 0)}
            </span>
          ) : null}
          <ConnectionBadge />
          <Clock />
          <span className="user-chip" title={me.user.username}>
            <Icon name="user" size={14} /> {me.user.displayName}
          </span>
          <button className="icon-btn" onClick={() => void logout()} aria-label="サインアウト" title="サインアウト">
            <Icon name="logout" size={16} />
          </button>
        </div>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function ModeBadge() {
  const server = useAuthConfig().data?.mode === 'server';
  return server ? (
    <span className="local-badge" title="サーバーで常時動作しています">SERVER</span>
  ) : (
    <span className="local-badge" title="この PC で動作しています（クラウドではありません）">LOCAL</span>
  );
}
