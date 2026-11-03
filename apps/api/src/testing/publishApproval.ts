/**
 * テスト用: publish 承認（GitHub への書き込みの前の人の承認）を探し、API から判断する。
 * 画面と同じく、版数と内容ハッシュを付けて POST /v1/approvals/:id/decision を呼ぶ。
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { approvals, type runs } from '../db/schema';

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

type RunRow = typeof runs.$inferSelect;

/**
 * 「publish 承認を承認しながら、指定の状態まで待つ」関数を、各テストの waitFor / runRow で作る。
 * needs_input でも publish 以外の承認（確認・利用上限など）は判断しない。
 */
export function waitStatusApprovingWith(
  db: Db,
  req: Request,
  waitFor: (fn: () => Promise<RunRow | null>) => Promise<RunRow>,
  runRow: (id: string) => Promise<RunRow>,
) {
  return (id: string, ...statuses: string[]) =>
    waitFor(async () => {
      const r = await runRow(id);
      if (statuses.includes(r.status)) return r;
      if (r.status === 'needs_input') await decidePublish(db, req, id);
      return null;
    });
}
