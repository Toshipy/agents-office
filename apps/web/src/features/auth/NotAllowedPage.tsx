/**
 * ALB の Google ログインは通ったが、このアカウントは許可されていないときの案内（alb_oidc 専用）。
 * 自動で読み直さない（読み直すと同じ 401 を繰り返すため）。
 */
import { api } from '../../shared/api/client';

export function NotAllowedPage() {
  const signOut = async () => {
    try {
      await api.post('/v1/auth/logout');
    } catch {
      // ログアウトに失敗しても、トップへ戻して ALB に判断させる
    }
    location.assign('/');
  };
  return (
    <div className="login">
      <div className="login-art" aria-hidden>
        <div className="login-orb" />
        <div className="login-grid" />
      </div>
      <div className="login-card">
        <div className="login-brand">
          <div>
            <h1>このアカウントでは使えません</h1>
            <p>Google でサインインできましたが、このアカウントには利用が許可されていません。</p>
          </div>
        </div>
        <p className="hint">別のアカウントで使うには、いったんサインアウトしてからもう一度サインインしてください。</p>
        <button className="btn primary wide" onClick={() => void signOut()}>
          サインアウト
        </button>
      </div>
    </div>
  );
}
