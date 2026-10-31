/**
 * ローカル認証（Amazon Cognito の代替: ADR-010）。
 * - パスワードは scrypt でハッシュ化
 * - セッションは HttpOnly / SameSite=Strict Cookie に入れた HS256 JWT（SSE の EventSource でも送信される）
 * - 認証（誰か）と認可（どの Workspace を所有しているか）は分離し、毎リクエストで DB から Workspace を確定する
 * クラウド版では verifySession を Cognito JWT 検証に差し替える。
 */
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import { eq } from 'drizzle-orm';
import type { AppEnv, Services } from '../app';
import { users, workspaces } from '../db/schema';
import { AppError } from '../lib/errors';

export const SESSION_COOKIE = 'paw_session';
const SESSION_TTL_SEC = 12 * 3600;

export interface AuthContext {
  userId: string;
  username: string;
  displayName: string;
  workspaceId: string;
}

export async function issueSession(c: Context<AppEnv>, s: Services, userId: string) {
  const now = Math.floor(Date.now() / 1000);
  const token = await sign({ sub: userId, iat: now, exp: now + SESSION_TTL_SEC, aud: 'paw-local' }, s.config.sessionSecret, 'HS256');
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_TTL_SEC,
    secure: new URL(c.req.url).protocol === 'https:',
  });
}

export function clearSession(c: Context<AppEnv>) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

async function resolveAuth(c: Context<AppEnv>, s: Services): Promise<AuthContext | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  let payload: Record<string, unknown>;
  try {
    payload = (await verify(token, s.config.sessionSecret, 'HS256')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (payload.aud !== 'paw-local' || typeof payload.sub !== 'string') return null;
  const [row] = await s.db
    .select({ user: users, workspace: workspaces })
    .from(users)
    .innerJoin(workspaces, eq(workspaces.ownerUserId, users.id))
    .where(eq(users.id, payload.sub));
  if (!row) return null;
  return {
    userId: row.user.id,
    username: row.user.username,
    displayName: row.user.displayName,
    workspaceId: row.workspace.id,
  };
}

/** /v1 の業務 API は認証必須（FR-001: 未認証は 401） */
export function requireAuth(s: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = await resolveAuth(c, s);
    if (!auth) throw new AppError(401, 'UNAUTHENTICATED', 'サインインが必要です');
    c.set('auth', auth);
    await next();
  };
}

/**
 * CSRF 対策: 状態を変更するリクエストには独自ヘッダーを必須とし（クロスサイトのフォーム送信では付与できない）、
 * Origin がある場合は許可リストと照合する。Cookie も SameSite=Strict。
 */
export function csrfGuard(s: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      if (c.req.header('x-paw-client') !== 'web') {
        throw new AppError(403, 'CSRF_REJECTED', '不正なリクエスト元です');
      }
      const origin = c.req.header('origin');
      if (origin && !s.config.allowedOrigins.includes(origin)) {
        throw new AppError(403, 'CSRF_REJECTED', '許可されていない Origin です');
      }
    }
    await next();
  };
}

/** 単純なログイン試行制限（プロセス内） */
const attempts = new Map<string, { count: number; resetAt: number }>();
export function checkLoginRate(key: string) {
  const now = Date.now();
  const cur = attempts.get(key);
  if (!cur || cur.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + 5 * 60_000 });
    return;
  }
  cur.count += 1;
  if (cur.count > 10) throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'ログイン試行が多すぎます。しばらく待ってから再試行してください');
}
export function resetLoginRate(key: string) {
  attempts.delete(key);
}
