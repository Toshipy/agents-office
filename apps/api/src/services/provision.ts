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
  { role: 'planner', name: 'Sora', runtime: 'OpenAI Agents SDK（未接続 → ローカルシミュレーション）' },
  { role: 'developer', name: 'Ren', runtime: 'Codex SDK（未接続 → ローカルシミュレーション）' },
  { role: 'tester', name: 'Mio', runtime: 'Codex SDK / 検証コマンド（未接続 → ローカルシミュレーション）' },
  { role: 'reviewer', name: 'Kei', runtime: 'OpenAI Agents SDK（未接続 → ローカルシミュレーション）' },
];

/** FR-002: 新規登録時に個人 Workspace と既定の Agent 定義を作成 */
export async function createUserWithWorkspace(
  db: Db,
  args: { username: string; displayName: string; password: string; settings?: Partial<typeof workspaces.$inferInsert> },
) {
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.username, args.username));
  if (exists) throw new AppError(409, 'USERNAME_TAKEN', 'このユーザー名は既に使われています');
  const passwordHash = await hashPassword(args.password);
  const userId = newId('usr');
  const workspaceId = newId('ws');
  await db.insert(users).values({ id: userId, username: args.username, displayName: args.displayName, passwordHash });
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
