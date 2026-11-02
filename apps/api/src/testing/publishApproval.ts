/**
 * テスト用: publish 承認（GitHub への書き込みの前の人の承認）を探し、API から判断する。
 * 画面と同じく、版数と内容ハッシュを付けて POST /v1/approvals/:id/decision を呼ぶ。
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { approvals } from '../db/schema';

type Request = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

/** その Run の未決の publish 承認（無ければ null） */
export async function pendingPublish(db: Db, runId: string) {
  const [ap] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.status, 'pending'), eq(approvals.actionType, 'publish')));
  return ap ?? null;
}

/** 未決の publish 承認があれば判断する。無ければ何もせず null を返す */
export async function decidePublish(
  db: Db,
  req: Request,
  runId: string,
  decision: 'approve' | 'request_changes' | 'reject' = 'approve',
  comment?: string,
) {
  const ap = await pendingPublish(db, runId);
  if (!ap) return null;
  const r = await req('POST', `/v1/approvals/${ap.id}/decision`, {
    decision,
    expectedVersion: ap.version,
    confirmationDigest: ap.payloadDigest,
    ...(comment ? { comment } : {}),
  });
  if (r.status !== 200) throw new Error(`publish の判断に失敗: ${r.status} ${JSON.stringify(r.body)}`);
  return ap;
}
