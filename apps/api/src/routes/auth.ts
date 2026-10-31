import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { LoginRequest, SignupRequest } from '@paw/contracts';
import type { AppEnv, Services } from '../app';
import { users, workspaces } from '../db/schema';
import { verifyPassword } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { checkLoginRate, clearSession, issueSession, resetLoginRate } from '../auth/session';
import { audit } from '../services/audit';
import { createUserWithWorkspace } from '../services/provision';
import { DEMO_ACCOUNTS } from '../seed';
import { parseBody } from './helpers';

export function registerAuthRoutes(app: Hono<AppEnv>, s: Services) {
  /** PAW_SIGNUP: open = 誰でも / first_user = ユーザーがまだいない時だけ（サーバーの所有者用）/ closed = 不可 */
  const signupAllowed = async () => {
    if (s.config.signup === 'open') return true;
    if (s.config.signup === 'closed') return false;
    const [any] = await s.db.select({ id: users.id }).from(users).limit(1);
    return !any;
  };

  app.get('/v1/auth/config', async (c) =>
    c.json({
      mode: s.config.publicUrl ? 'server' : 'local',
      devRoutes: s.config.enableDevRoutes,
      signup: await signupAllowed(),
      devAccounts: s.config.enableDevRoutes && s.config.seedDemo ? DEMO_ACCOUNTS.map(({ username, password, displayName }) => ({ username, password, displayName })) : [],
    }),
  );

  app.post('/v1/auth/login', async (c) => {
    const body = await parseBody(c, LoginRequest);
    const rateKey = `${body.username.toLowerCase()}`;
    checkLoginRate(rateKey);
    const [row] = await s.db
      .select({ user: users, workspace: workspaces })
      .from(users)
      .innerJoin(workspaces, eq(workspaces.ownerUserId, users.id))
      .where(eq(users.username, body.username.toLowerCase()));
    // ユーザーの存在有無で応答を変えない
    const ok = row ? await verifyPassword(body.password, row.user.passwordHash) : await verifyPassword(body.password, 'scrypt$00$00');
    if (!row || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'ユーザー名またはパスワードが違います');
    resetLoginRate(rateKey);
    await issueSession(c, s, row.user.id);
    return c.json({
      user: { id: row.user.id, username: row.user.username, displayName: row.user.displayName },
      workspace: { id: row.workspace.id, name: row.workspace.name },
    });
  });

  app.post('/v1/auth/signup', async (c) => {
    const body = await parseBody(c, SignupRequest);
    if (!(await signupAllowed())) throw new AppError(403, 'SIGNUP_DISABLED', '新規登録は無効です（このサーバーは所有者専用です）');
    const { userId, workspace } = await createUserWithWorkspace(s.db, {
      username: body.username.toLowerCase(),
      displayName: body.displayName,
      password: body.password,
    });
    await audit(s.db, {
      workspaceId: workspace.id,
      actorUserId: userId,
      action: 'workspace.created',
      targetType: 'workspace',
      targetId: workspace.id,
    });
    await issueSession(c, s, userId);
    return c.json(
      {
        user: { id: userId, username: body.username.toLowerCase(), displayName: body.displayName },
        workspace: { id: workspace.id, name: workspace.name },
      },
      201,
    );
  });

  app.post('/v1/auth/logout', (c) => {
    clearSession(c);
    return c.json({ ok: true });
  });
}
