import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { AppEnv, Services } from '../app';
import { idempotencyKeys, projects, runs } from '../db/schema';
import { AppError, notFound } from '../lib/errors';
import { sha256Hex, stableStringify } from '../lib/crypto';

export async function parseBody<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'JSON を解析できません');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      parsed.error.issues[0]?.message ?? '入力が不正です',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

export function auth(c: Context<AppEnv>) {
  const a = c.get('auth');
  if (!a) throw new AppError(401, 'UNAUTHENTICATED', 'サインインが必要です');
  return a;
}

/**
 * Workspace 所有権を条件に含めて取得する。他 Workspace の ID を指定された場合は存在を明かさず 404（FR-003）
 */
export async function ownedProject(s: Services, workspaceId: string, projectId: string) {
  const [p] = await s.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
  if (!p) throw notFound('Project');
  return p;
}

export async function ownedRun(s: Services, workspaceId: string, runId: string) {
  const [r] = await s.db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.workspaceId, workspaceId)));
  if (!r) throw notFound('Run');
  return r;
}

/** 基本設計書 6.1: Idempotency-Key による連打・再送の無害化（2xx 応答のみ保存） */
export async function withIdempotency(
  c: Context<AppEnv>,
  s: Services,
  route: string,
  body: unknown,
  fn: () => Promise<{ status: 200 | 201 | 202; body: unknown }>,
) {
  const key = c.req.header('idempotency-key');
  const workspaceId = auth(c).workspaceId;
  if (!key) {
    const r = await fn();
    return c.json(r.body as object, r.status);
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key の形式が不正です');
  const requestHash = sha256Hex(stableStringify({ route, body }));
  const [existing] = await s.db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.workspaceId, workspaceId), eq(idempotencyKeys.key, key)));
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', '同じ Idempotency-Key が別のリクエストに使われています');
    }
    c.header('Idempotent-Replayed', 'true');
    return c.json(existing.responseBody as object, existing.responseStatus as 200);
  }
  const r = await fn();
  await s.db
    .insert(idempotencyKeys)
    .values({ workspaceId, key, route, requestHash, responseStatus: r.status, responseBody: r.body })
    .onConflictDoNothing();
  return c.json(r.body as object, r.status);
}
