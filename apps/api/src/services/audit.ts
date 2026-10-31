import type { Db } from '../db/client';
import { auditLogs } from '../db/schema';
import { newId } from '../lib/ids';

/** FR-054: 人が行った承認・設定変更を記録する（本文や秘密値は入れない） */
export async function audit(
  db: Db,
  entry: {
    workspaceId: string;
    actorUserId: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    detail?: Record<string, unknown>;
  },
) {
  await db.insert(auditLogs).values({
    id: newId('aud'),
    workspaceId: entry.workspaceId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    detail: entry.detail ?? {},
  });
}
