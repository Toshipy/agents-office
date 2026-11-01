/**
 * ローカル GitHub シミュレーター。
 * 実 GitHub App の代わりに、GitHub 形式のペイロードを作り Webhook シークレットで署名して
 * 本番と同じ受信経路（receiveGithubWebhook → Dispatcher）に流す。
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import { repositoryBindings, runs, webhookDeliveries } from '../db/schema';
import { AppError, notFound } from '../lib/errors';
import { receiveGithubWebhook, signGithubPayload, type WebhookResult } from './webhook';

/** ローカルの擬似 Installation ID（Workspace ごと） */
export function simulatedInstallationId(workspaceId: string): number {
  let h = 0;
  for (const ch of workspaceId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 10_000 + (h % 89_999_999);
}

/** owner/repo から決定的な擬似 Repository ID */
export function simulatedRepositoryId(fullName: string): number {
  let h = 7;
  for (const ch of fullName.toLowerCase()) h = (h * 131 + ch.charCodeAt(0)) >>> 0;
  return 100_000 + (h % 899_999_999);
}

export async function deliver(
  db: Db,
  config: AppConfig,
  event: string,
  payload: Record<string, unknown>,
  deliveryId: string = randomUUID(),
): Promise<WebhookResult & { deliveryId: string }> {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = new Headers({
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': deliveryId,
    'x-hub-signature-256': signGithubPayload(config.githubWebhookSecret, raw),
  });
  const res = await receiveGithubWebhook(db, config, raw, headers);
  return { ...res, deliveryId };
}

export async function simulateIssue(
  db: Db,
  config: AppConfig,
  args: {
    workspaceId: string;
    projectId: string;
    action: 'opened' | 'labeled';
    title: string;
    body: string;
    labels: string[];
    senderLogin: string;
  },
) {
  const [binding] = await db
    .select()
    .from(repositoryBindings)
    .where(and(eq(repositoryBindings.workspaceId, args.workspaceId), eq(repositoryBindings.projectId, args.projectId)));
  if (!binding) throw new AppError(422, 'REPO_NOT_CONNECTED', 'この Project には Repo が接続されていません');
  // 本物の GitHub につないだ Repo には、実在しない Issue を作らない
  if (binding.verification === 'github_app') throw new AppError(422, 'REAL_GITHUB_REPO', 'GitHub App で接続した Repo にはシミュレーターから Issue を送れません。GitHub で Issue を作成してください');
  const [{ number }] = await db
    .update(repositoryBindings)
    .set({ nextIssueNumber: sql`${repositoryBindings.nextIssueNumber} + 1` })
    .where(eq(repositoryBindings.id, binding.id))
    .returning({ number: sql<number>`${repositoryBindings.nextIssueNumber} - 1` });
  const labels = Array.from(new Set(args.labels));
  const payload: Record<string, unknown> = {
    action: args.action,
    issue: {
      number: Number(number),
      title: args.title,
      body: args.body,
      labels: labels.map((name) => ({ name })),
      html_url: `local-github://${binding.fullName}/issues/${number}`,
      user: { login: args.senderLogin },
    },
    ...(args.action === 'labeled' ? { label: { name: labels[labels.length - 1] ?? '' } } : {}),
    repository: { id: binding.repositoryId, full_name: binding.fullName },
    installation: { id: binding.installationId },
    sender: { login: args.senderLogin },
  };
  const res = await deliver(db, config, 'issues', payload);
  return { ...res, issueNumber: Number(number) };
}

export async function simulateReview(
  db: Db,
  config: AppConfig,
  args: { workspaceId: string; runId: string; state: 'approved' | 'changes_requested'; body: string; reviewerLogin: string },
) {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, args.runId), eq(runs.workspaceId, args.workspaceId)));
  if (!run) throw notFound('Run');
  if (run.status !== 'waiting_review' || !run.pr) {
    throw new AppError(409, 'NOT_WAITING_REVIEW', 'この Run はレビュー待ちではありません');
  }
  const [binding] = await db.select().from(repositoryBindings).where(eq(repositoryBindings.projectId, run.projectId));
  if (!binding) throw new AppError(422, 'REPO_NOT_CONNECTED', 'Repo が接続されていません');
  if (binding.verification === 'github_app') throw new AppError(422, 'REAL_GITHUB_REPO', 'GitHub App で接続した Repo の PR は、GitHub 上でレビューしてください');
  const payload = {
    action: 'submitted',
    review: {
      state: args.state,
      body: args.body,
      commit_id: run.pr.headSha,
      user: { login: args.reviewerLogin },
    },
    pull_request: { number: run.pr.number, head: { sha: run.pr.headSha, ref: run.pr.branch }, draft: true },
    repository: { id: binding.repositoryId, full_name: binding.fullName },
    installation: { id: binding.installationId },
    sender: { login: args.reviewerLogin },
  };
  return deliver(db, config, 'pull_request_review', payload);
}

/** 同じ Delivery ID・同じ本文で再送（冪等性の確認用）。自分の Workspace の Repo 宛のみ許可 */
export async function redeliver(db: Db, config: AppConfig, args: { workspaceId: string; deliveryId: string }) {
  const [d] = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.provider, 'github'), eq(webhookDeliveries.deliveryId, args.deliveryId)));
  if (!d || d.repositoryId == null || d.installationId == null) throw notFound('Delivery');
  const [owned] = await db
    .select({ id: repositoryBindings.id })
    .from(repositoryBindings)
    .where(
      and(
        eq(repositoryBindings.workspaceId, args.workspaceId),
        eq(repositoryBindings.installationId, d.installationId),
        eq(repositoryBindings.repositoryId, d.repositoryId),
      ),
    );
  if (!owned) throw notFound('Delivery');
  return deliver(db, config, d.eventType, d.payload, d.deliveryId);
}
