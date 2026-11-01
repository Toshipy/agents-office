/**
 * ログイン / 初期セットアップ（UI-01）。ローカル版は Cognito の代わりにローカル認証。
 */
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../../shared/api/client';
import { useAuthConfig } from '../../shared/api/authConfig';
import { Icon } from '../../shared/ui/Icon';

export function LoginPage() {
  const qc = useQueryClient();
  const cfg = useAuthConfig();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [signupCode, setSignupCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e?: FormEvent, override?: { username: string; password: string }) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup' && !override) await api.post('/v1/auth/signup', { username, password, displayName, ...(signupCode.trim() ? { signupCode: signupCode.trim() } : {}) });
      else await api.post('/v1/auth/login', override ?? { username, password });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-art" aria-hidden>
        <div className="login-orb" />
        <div className="login-grid" />
      </div>
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <div className="login-brand">
          <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden>
            <defs>
              <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#8b9cff" />
                <stop offset="1" stopColor="#5eead4" />
              </linearGradient>
            </defs>
            <path d="M16 4 27 10v12L16 28 5 22V10z" fill="none" stroke="url(#lg)" strokeWidth="2.4" strokeLinejoin="round" />
            <circle cx="16" cy="16" r="3.6" fill="url(#lg)" />
          </svg>
          <div>
            <h1>Personal AI Workspace</h1>
            <p>あなた専用の AI エージェント・オフィス（{cfg.data?.mode === 'server' ? 'サーバー版' : 'ローカル版'}）</p>
          </div>
        </div>
        <div className="seg" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>
            サインイン
          </button>
          {cfg.data?.signup !== false ? (
            <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'on' : ''} onClick={() => setMode('signup')}>
              新規登録
            </button>
          ) : null}
        </div>
        <label>
          ユーザー名
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        {mode === 'signup' ? (
          <label>
            表示名
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </label>
        ) : null}
        {mode === 'signup' && cfg.data?.signupCodeRequired ? (
          <label>
            登録コード
            <input value={signupCode} onChange={(e) => setSignupCode(e.target.value)} autoComplete="off" required className="mono" />
          </label>
        ) : null}
        <label>
          パスワード
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'signup' ? 8 : 1} />
        </label>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        <button className="btn primary wide" disabled={busy}>
          {busy ? '処理中…' : mode === 'login' ? 'サインイン' : '登録して個人ワークスペースを作成'}
        </button>
        {cfg.data?.devAccounts.length ? (
          <div className="demo-accounts">
            <span className="eyebrow">ローカルデモ用アカウント</span>
            {cfg.data.devAccounts.map((a) => (
              <button key={a.username} type="button" className="demo-acc" onClick={() => void submit(undefined, { username: a.username, password: a.password })} disabled={busy}>
                <Icon name="user" size={14} />
                <span>
                  <strong>{a.displayName}</strong> <span className="mono muted">{a.username}</span>
                </span>
                <Icon name="chevron-right" size={14} />
              </button>
            ))}
            <p className="hint">各ユーザーのワークスペースは互いに見えません（alice と bob で確認できます）。</p>
          </div>
        ) : null}
      </form>
    </div>
  );
}
