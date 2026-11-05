import { eq } from 'drizzle-orm';
import type { AgentRole } from '@paw/contracts';
import type { Db } from '../db/client';
import { agentDefinitions, users, workspaces } from '../db/schema';
import { hashPassword } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { newId } from '../lib/ids';
import { SIM_MODEL } from '../agents/simulated';
import { DEFAULT_TOOL_POLICIES } from '../workflow/toolBroker';

export const DEFAULT_AGENTS: { role: AgentRole; name: string; runtime: string }[] = [
  { role: 'planner', name: 'Sora', runtime: 'Claude Agent SDK / OpenAI Agents SDK（候補・未接続 → ローカルシミュレーション）' },
  { role: 'developer', name: 'Ren', runtime: 'Claude Code / Codex SDK（候補・未接続 → ローカルシミュレーション）' },
  { role: 'tester', name: 'Mio', runtime: '検証コマンド（未接続 → ローカルシミュレーション）' },
  { role: 'reviewer', name: 'Kei', runtime: 'Claude Agent SDK / OpenAI Agents SDK（候補・未接続 → ローカルシミュレーション）' },
];

type Tx = Pick<Db, 'insert'>;

/** ユーザー・個人ワークスペース・既定の Agent 定義をまとめて作る（呼び出し側がトランザクションを張る） */
async function insertUserWithWorkspace(
  db: Tx,
  args: { username: string; displayName: string; passwordHash: string; settings?: Partial<typeof workspaces.$inferInsert> },
) {
  const userId = newId('usr');
  const workspaceId = newId('ws');
  await db.insert(users).values({ id: userId, username: args.username, displayName: args.displayName, passwordHash: args.passwordHash });
  const [ws] = await db
    .insert(workspaces)
    .values({ id: workspaceId, ownerUserId: userId, name: `${args.displayName} のワークスペース`, ...args.settings })
    .returning();
  await db.insert(agentDefinitions).values(
    DEFAULT_AGENTS.map((a) => ({
      id: newId('agt'),
      workspaceId,
      role: a.role,
      name: a.name,
      model: SIM_MODEL,
      runtime: a.runtime,
      promptVersion: `${a.role}@1.0.0`,
      toolPolicy: DEFAULT_TOOL_POLICIES[a.role],
      version: 1,
    })),
  );
  return { userId, workspace: ws };
}

/** FR-002: 新規登録時に個人 Workspace と既定の Agent 定義を作成 */
export async function createUserWithWorkspace(
  db: Db,
  args: { username: string; displayName: string; password: string; settings?: Partial<typeof workspaces.$inferInsert> },
) {
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.username, args.username));
  if (exists) throw new AppError(409, 'USERNAME_TAKEN', 'このユーザー名は既に使われています');
  const passwordHash = await hashPassword(args.password);
  return insertUserWithWorkspace(db, { ...args, passwordHash });
}

/** どのパスワードとも一致しない値（verifyPassword は scrypt$ 形式以外を必ず拒む） */
export const UNUSABLE_PASSWORD_HASH = '!alb_oidc';

async function findByUsername(db: Db, username: string) {
  const [row] = await db
    .select({ userId: users.id, workspaceId: workspaces.id })
    .from(users)
    .innerJoin(workspaces, eq(workspaces.ownerUserId, users.id))
    .where(eq(users.username, username));
  return row ?? null;
}

/**
 * alb_oidc: メールアドレス（小文字）を username としてユーザーと個人ワークスペースを用意する。既にあればそれを返す。
 * 同時の初回要求は username の一意制約で片方が失敗するので、取り直して同じユーザーを返す。
 */
export async function ensureEmailUser(db: Db, email: string, displayName: string | null): Promise<{ userId: string; workspaceId: string }> {
  const username = email.toLowerCase();
  const found = await findByUsername(db, username);
  if (found) return found;
  try {
    // ユーザーだけが残ってワークスペースが無い状態にしないよう、まとめて 1 つのトランザクションで作る
    const created = await db.transaction((tx) =>
      insertUserWithWorkspace(tx as unknown as Tx, { username, displayName: displayName ?? username, passwordHash: UNUSABLE_PASSWORD_HASH }),
    );
    return { userId: created.userId, workspaceId: created.workspace.id };
  } catch (err) {
    const again = await findByUsername(db, username);
    if (again) return again;
    throw err;
  }
}
