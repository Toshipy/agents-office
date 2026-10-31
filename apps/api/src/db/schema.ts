/**
 * DB スキーマ（基本設計書 7.2）。ローカル版は PGlite（WASM版PostgreSQL）+ Drizzle ORM。
 * クラウド版の RDS for PostgreSQL と同じ方言で書くことで移行コストを抑える。
 *
 * すべての業務テーブルは workspace_id を持ち、クエリは必ず確認済み workspace_id を条件に含める（7.3）。
 */
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  AgentRole,
  ApprovalActionType,
  ApprovalStatus,
  RunStatus,
  StepKey,
  StepRole,
  StepStatus,
} from '@paw/contracts';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  /** MVP は 1 ユーザー 1 Workspace（要件定義書 1.2 で推奨） */
  ownerUserId: text('owner_user_id')
    .notNull()
    .unique()
    .references(() => users.id),
  name: text('name').notNull(),
  monthlyBudgetUsd: doublePrecision('monthly_budget_usd').notNull().default(50),
  runBudgetUsd: doublePrecision('run_budget_usd').notNull().default(2),
  maxConcurrentRuns: integer('max_concurrent_runs').notNull().default(2),
  /** キルスイッチ（FR-056 / R-04）。true の間は新規 Run を開始しない */
  paused: boolean('paused').notNull().default(false),
  demoTraffic: boolean('demo_traffic').notNull().default(false),
  eventSequence: bigint('event_sequence', { mode: 'number' }).notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    color: text('color').notNull(),
    position: integer('position').notNull().default(0),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    agentConfig: jsonb('agent_config')
      .$type<{ roles: AgentRole[]; workflow: 'issue_to_draft_pr' }>()
      .notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('projects_ws_idx').on(t.workspaceId)],
);

export interface RepoPolicy {
  triggerLabel: string;
  events: ('issues.opened' | 'issues.labeled')[];
  maxRevisionAttempts: number;
}

export const repositoryBindings = pgTable(
  'repository_bindings',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    provider: text('provider').notNull().default('github'),
    installationId: bigint('installation_id', { mode: 'number' }).notNull(),
    repositoryId: bigint('repository_id', { mode: 'number' }).notNull(),
    fullName: text('full_name').notNull(),
    /** FR-022: 自動起動は明示 ON、初期 OFF */
    automationEnabled: boolean('automation_enabled').notNull().default(false),
    policy: jsonb('policy_json').$type<RepoPolicy>().notNull(),
    /** ローカル版は GitHub App の代わりにシミュレーターで検証 */
    verification: text('verification').notNull().default('simulated'),
    /** ローカルの git リポジトリ（設定すると Claude がこのリポジトリの worktree で作業する） */
    localPath: text('local_path'),
    /** Tester が worktree で実行するコマンド（利用者が明示的に設定したものだけ実行） */
    testCommand: text('test_command'),
    nextPrNumber: integer('next_pr_number').notNull().default(1),
    nextIssueNumber: integer('next_issue_number').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('repo_binding_ws_repo_uq').on(t.workspaceId, t.repositoryId),
    uniqueIndex('repo_binding_project_uq').on(t.projectId),
    index('repo_binding_install_repo_idx').on(t.installationId, t.repositoryId),
  ],
);

export const agentDefinitions = pgTable(
  'agent_definitions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    role: text('role').$type<AgentRole>().notNull(),
    name: text('name').notNull(),
    model: text('model').notNull(),
    runtime: text('runtime').notNull(),
    promptVersion: text('prompt_version').notNull(),
    toolPolicy: jsonb('tool_policy').$type<string[]>().notNull(),
    version: integer('version').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_def_ws_role_uq').on(t.workspaceId, t.role)],
);

export interface RunSource {
  type: 'manual' | 'github_issue';
  issueNumber?: number;
  issueUrl?: string;
  deliveryId?: string;
  repositoryId?: number;
  requestedBy?: string;
}

export interface RunPr {
  number: number;
  url: string;
  branch: string;
  headSha: string;
  draft: boolean;
}

export interface PlanJson {
  steps: { id: string; role: StepRole; dependsOn: string[] }[];
  maxRevisionAttempts: number;
  summary: string;
  flags: string[];
}

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    request: text('request').notNull(),
    workflow: text('workflow').notNull(),
    /** AI 実行基盤: claude（Claude API）/ simulated（ローカルシミュレーション） */
    runtime: text('runtime').$type<'claude' | 'simulated'>().notNull().default('simulated'),
    source: jsonb('source').$type<RunSource>().notNull(),
    /** 同一 Issue に同時に 2 件の開発 Run を起動しないためのキー（要件定義書 5.2） */
    issueKey: text('issue_key'),
    status: text('status').$type<RunStatus>().notNull(),
    statusVersion: integer('status_version').notNull().default(1),
    plan: jsonb('plan').$type<PlanJson | null>(),
    guidance: text('guidance'),
    revisionCount: integer('revision_count').notNull().default(0),
    maxRevisionAttempts: integer('max_revision_attempts').notNull().default(3),
    fixLoops: integer('fix_loops').notNull().default(0),
    budgetLimitUsd: doublePrecision('budget_limit_usd').notNull(),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    pr: jsonb('pr').$type<RunPr | null>(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('runs_ws_status_idx').on(t.workspaceId, t.status),
    index('runs_ws_created_idx').on(t.workspaceId, t.createdAt),
    index('runs_issue_key_idx').on(t.workspaceId, t.issueKey),
  ],
);

export const runSteps = pgTable(
  'run_steps',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    seq: integer('seq').notNull(),
    key: text('key').$type<StepKey>().notNull(),
    role: text('role').$type<StepRole>().notNull(),
    agentId: text('agent_id'),
    agentVersion: integer('agent_version'),
    model: text('model'),
    status: text('status').$type<StepStatus>().notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(2),
    revision: integer('revision').notNull().default(0),
    summary: text('summary'),
    errorCode: text('error_code'),
    outcome: jsonb('outcome').$type<Record<string, unknown> | null>(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    nextAttemptAt: ts('next_attempt_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('steps_run_idx').on(t.runId, t.seq),
    index('steps_ws_status_idx').on(t.workspaceId, t.status),
  ],
);

/** ツール呼び出し・作業ログ（FR-030 / UI-04 ツール履歴） */
export const stepLogs = pgTable(
  'step_logs',
  {
    id: serial('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    runId: text('run_id').notNull(),
    stepId: text('step_id').notNull(),
    kind: text('kind').$type<'log' | 'tool' | 'policy' | 'error'>().notNull(),
    message: text('message').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('step_logs_run_idx').on(t.workspaceId, t.runId, t.id)],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    runId: text('run_id').notNull(),
    stepId: text('step_id'),
    kind: text('kind').$type<'plan' | 'diff' | 'test_report' | 'review' | 'draft_pr' | 'log'>().notNull(),
    title: text('title').notNull(),
    /** workspaces/<ws>/runs/<run>/<file>。パス名はアクセス制御にならない（7.3）— API で所有権を確認 */
    uri: text('uri').notNull(),
    mediaType: text('media_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    checksum: text('checksum').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('artifacts_run_idx').on(t.workspaceId, t.runId)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    runId: text('run_id').notNull(),
    projectId: text('project_id').notNull(),
    actionType: text('action_type').$type<ApprovalActionType>().notNull(),
    requestedByRole: text('requested_by_role').$type<AgentRole>().notNull(),
    title: text('title').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadDigest: text('payload_digest').notNull(),
    status: text('status').$type<ApprovalStatus>().notNull().default('pending'),
    version: integer('version').notNull().default(1),
    expiresAt: ts('expires_at').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: ts('decided_at'),
    decisionComment: text('decision_comment'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('approvals_ws_status_idx').on(t.workspaceId, t.status)],
);

export const eventLogs = pgTable(
  'event_logs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    runId: text('run_id'),
    projectId: text('project_id'),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    eventType: text('event_type').notNull(),
    occurredAt: ts('occurred_at').notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [uniqueIndex('event_logs_ws_seq_uq').on(t.workspaceId, t.sequence)],
);

/** FR-024: provider + delivery_id の複合ユニーク制約で冪等化 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    provider: text('provider').notNull(),
    deliveryId: text('delivery_id').notNull(),
    eventType: text('event_type').notNull(),
    action: text('action'),
    installationId: bigint('installation_id', { mode: 'number' }),
    repositoryId: bigint('repository_id', { mode: 'number' }),
    /** SQS の代わりの永続キュー。検証済み本文を保持し、Dispatcher が処理する */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
    processedAt: ts('processed_at'),
    attempts: integer('attempts').notNull().default(0),
    outcome: text('outcome'),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.deliveryId] }),
    index('webhook_unprocessed_idx').on(t.processedAt),
  ],
);

export const usageRecords = pgTable(
  'usage_records',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    runId: text('run_id').notNull(),
    stepId: text('step_id'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    durationMs: integer('duration_ms').notNull(),
    estimatedCostUsd: doublePrecision('estimated_cost_usd').notNull(),
    /** FR-055: 実測 / 推定 / 未計測 を区別 */
    measurement: text('measurement').$type<'measured' | 'estimated' | 'unmeasured'>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('usage_ws_created_idx').on(t.workspaceId, t.createdAt)],
);

/** FR-054: 人が行った承認・設定変更の監査 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    actorUserId: text('actor_user_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('audit_ws_created_idx').on(t.workspaceId, t.createdAt)],
);

/** 基本設計書 6.1: 状態更新系の Idempotency-Key */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    workspaceId: text('workspace_id').notNull(),
    key: text('key').notNull(),
    route: text('route').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').$type<unknown>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);
