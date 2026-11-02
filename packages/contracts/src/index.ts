/**
 * @paw/contracts — API / Event の共有スキーマ（基本設計書 13.1 packages/contracts）
 *
 * Web と API の両方から参照する。サーバー側では必ず Zod で入力を検証する（基本設計書 6.1）。
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Agent / Role                                                        */
/* ------------------------------------------------------------------ */

/** MVP の論理 Agent（要求定義書 3.1: Planner / Developer / Tester / Reviewer） */
export const AGENT_ROLES = ['planner', 'developer', 'tester', 'reviewer'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Step を担当する主体。tool_broker は Agent ではなくポリシー検証付きのシステム部品 */
export const STEP_ROLES = [...AGENT_ROLES, 'tool_broker'] as const;
export type StepRole = (typeof STEP_ROLES)[number];

/** 基本設計書 5.2 AgentVisualStatus */
export const AGENT_VISUAL_STATUSES = [
  'idle',
  'working',
  'reviewing',
  'waiting_approval',
  'completed',
  'failed',
] as const;
export type AgentVisualStatus = (typeof AGENT_VISUAL_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Run state machine（要件定義書 5.1）                                   */
/* ------------------------------------------------------------------ */

export const RUN_STATUSES = [
  'queued',
  'planning',
  'running',
  'validating',
  'pr_ready',
  'waiting_review',
  'revising',
  'needs_input',
  'approved',
  'completed',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

/** 同時実行数（NFR-018）にカウントする状態。人間待ち（waiting_review / needs_input）は含めない */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'planning',
  'running',
  'validating',
  'pr_ready',
  'revising',
  'approved',
];

/**
 * 要件定義書 5.1 の遷移表。
 * 追加点（文書から導出したもの）:
 *  - 利用者による中止（FR-037）は非終端の全状態から cancelled へ遷移可能
 *  - waiting_review → needs_input は基本設計書 4.3「上限超過 → needs_input / escalated」に基づく
 *  - validating → needs_input / needs_input → running・validating は、Claude のサブスク利用上限で
 *    工程を一時停止し、人の「続行」でその工程から再開するための追加（利用者の要望による）
 *  - 終端でない全状態 → approved は、PR が GitHub で人の手でマージされたとき、どの状態の Run も完了に
 *    するための追加（レビュー待ちより前に PR が先にマージされても Run を取り残さない）
 */
export const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['planning', 'approved', 'cancelled'],
  planning: ['running', 'needs_input', 'failed', 'approved', 'cancelled'],
  running: ['validating', 'needs_input', 'failed', 'approved', 'cancelled'],
  validating: ['pr_ready', 'running', 'needs_input', 'failed', 'approved', 'cancelled'],
  pr_ready: ['waiting_review', 'failed', 'approved', 'cancelled'],
  waiting_review: ['revising', 'approved', 'needs_input', 'cancelled'],
  revising: ['running', 'failed', 'approved', 'cancelled'],
  needs_input: ['planning', 'running', 'validating', 'approved', 'cancelled'],
  approved: ['completed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export const STEP_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'needs_input',
  'cancelled',
  'skipped',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const STEP_KEYS = ['plan', 'implement', 'test', 'review', 'draft_pr', 'update_pr'] as const;
export type StepKey = (typeof STEP_KEYS)[number];

/* ------------------------------------------------------------------ */
/* Approval（基本設計書 11.1）                                           */
/* ------------------------------------------------------------------ */

/**
 * pr_review / dangerous_operation は基本設計書 11.1。
 * clarification は UC-05（要件不足・再修正上限超過時のエスカレーション）を表すためにローカル版で追加。
 * send_message / publish_document は P1 のため未実装。
 */
export const APPROVAL_ACTION_TYPES = ['pr_review', 'dangerous_operation', 'clarification'] as const;
export type ApprovalActionType = (typeof APPROVAL_ACTION_TYPES)[number];

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'changes_requested',
  'rejected',
  'expired',
  'superseded',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_DECISIONS = ['approve', 'request_changes', 'reject'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/* ------------------------------------------------------------------ */
/* Events（基本設計書 5.3）                                              */
/* ------------------------------------------------------------------ */

export const EVENT_TYPES = [
  'run.created',
  'run.status_changed',
  'run.completed',
  'step.started',
  'step.finished',
  'agent.status_changed',
  'artifact.created',
  'approval.requested',
  'approval.resolved',
  'webhook.received',
  'webhook.ignored',
  'policy.denied',
  'workspace.updated',
  'project.updated',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** 永続化・連番付与しない一時イベント（ライブ作業ログ） */
export const TRANSIENT_EVENT_TYPES = ['step.log'] as const;
export type TransientEventType = (typeof TRANSIENT_EVENT_TYPES)[number];

export interface WorkspaceEvent<T = Record<string, unknown>> {
  eventId: string;
  workspaceId: string;
  /** 永続イベントは Workspace 内で単調増加。transient は null */
  sequence: number | null;
  type: EventType | TransientEventType;
  occurredAt: string;
  runId: string | null;
  projectId: string | null;
  data: T;
}

export interface StepLogLine {
  id: number;
  runId: string;
  stepId: string;
  ts: string;
  kind: 'log' | 'tool' | 'policy' | 'error';
  message: string;
}

/* ------------------------------------------------------------------ */
/* Request schemas                                                     */
/* ------------------------------------------------------------------ */

const id = z.string().min(3).max(64).regex(/^[a-z]+_[A-Za-z0-9]+$/, 'invalid id');

export const LoginRequest = z.object({
  username: z.string().trim().min(1).max(40),
  password: z.string().min(1).max(200),
});

export const SignupRequest = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(24)
    .regex(/^[a-z0-9_-]+$/, '英小文字・数字・_・- のみ使用できます'),
  displayName: z.string().trim().min(1).max(40),
  password: z.string().min(8).max(200),
  /** サーバーで PAW_SIGNUP_CODE を設定している場合の登録コード */
  signupCode: z.string().trim().max(200).optional(),
});

export const CreateRunRequest = z.object({
  projectId: id,
  source: z.object({ type: z.literal('manual') }).default({ type: 'manual' }),
  title: z.string().trim().max(120).optional(),
  request: z.string().trim().min(4).max(4000),
  workflow: z.literal('issue_to_draft_pr').default('issue_to_draft_pr'),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const ApprovalDecisionRequest = z.object({
  decision: z.enum(APPROVAL_DECISIONS),
  expectedVersion: z.number().int().min(1),
  confirmationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  comment: z.string().trim().max(2000).optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const CreateProjectRequest = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).default(''),
  color: hexColor.default('#5eead4'),
});

/** Claude が作業するローカル git リポジトリとテストコマンド（null で解除） */
export const LocalRepoRequest = z.object({
  localPath: z.string().trim().min(1).max(500).nullable(),
  testCommand: z
    .string()
    .trim()
    .max(300)
    .regex(/^[A-Za-z0-9 _.:\/@=+,&-]*$/, 'テストコマンドに使えない文字が含まれています（シェルの記号は使えません）')
    .nullable(),
});

export const UpdateProjectRequest = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(500),
    color: hexColor,
    status: z.enum(['active', 'archived']),
  })
  .partial();

export const BindRepositoryRequest = z.object({
  fullName: z
    .string()
    .trim()
    .max(140)
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/repo 形式で入力してください'),
});

export const AUTOMATION_EVENTS = ['issues.opened', 'issues.labeled'] as const;

export const AutomationPolicyRequest = z.object({
  enabled: z.boolean(),
  triggerLabel: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[A-Za-z0-9:_.\- ]+$/),
  events: z.array(z.enum(AUTOMATION_EVENTS)).min(1),
  maxRevisionAttempts: z.number().int().min(1).max(5),
});
export type AutomationPolicy = z.infer<typeof AutomationPolicyRequest>;

export const WorkspaceSettingsRequest = z
  .object({
    monthlyBudgetUsd: z.number().min(1).max(1000),
    runBudgetUsd: z.number().min(0.1).max(50),
    maxConcurrentRuns: z.number().int().min(1).max(5),
    demoTraffic: z.boolean(),
  })
  .partial();

export const KillSwitchRequest = z.object({
  action: z.enum(['pause', 'resume']),
  cancelActive: z.boolean().default(false),
});

export const SimulateGithubRequest = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('issue'),
    projectId: id,
    action: z.enum(['opened', 'labeled']).default('opened'),
    title: z.string().trim().min(3).max(200),
    body: z.string().max(5000).default(''),
    labels: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
  }),
  z.object({
    kind: z.literal('redeliver'),
    deliveryId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('review'),
    runId: id,
    state: z.enum(['approved', 'changes_requested']),
    body: z.string().max(2000).default(''),
  }),
]);
export type SimulateGithubRequest = z.infer<typeof SimulateGithubRequest>;

/* ------------------------------------------------------------------ */
/* View models                                                         */
/* ------------------------------------------------------------------ */

export interface SeatCurrentRun {
  id: string;
  title: string;
  status: RunStatus;
  stepKey: StepKey | null;
  stepId: string | null;
}

/**
 * 3D オフィスの席。論理 Agent（Workspace 単位の AgentDefinition）を Project ごとに投影したもの。
 * 基本設計書 5.2 の AgentViewModel を Project 単位に分解した表現（表示キャラ数 ≠ 実行コンテナ数）。
 */
export interface SeatViewModel {
  key: string;
  agentId: string;
  workspaceId: string;
  projectId: string;
  name: string;
  role: AgentRole;
  status: AgentVisualStatus;
  statusReason: string;
  activeRunIds: string[];
  activeProjectIds: string[];
  currentRun: SeatCurrentRun | null;
  lastEventAt: string | null;
  version: number;
}

export interface ProjectStats {
  doing: number;
  next: number;
  done24h: number;
  failed24h: number;
  waitingApproval: number;
  openPrs: number;
}

export interface ProjectViewModel {
  id: string;
  name: string;
  description: string;
  color: string;
  position: number;
  status: 'active' | 'archived';
  repo: {
    fullName: string;
    /** ローカルリポジトリが設定され Claude で実行されるか */
    claudeReady: boolean;
    automationEnabled: boolean;
    triggerLabel: string;
    maxRevisionAttempts: number;
    events: string[];
  } | null;
  stats: ProjectStats;
}

/** AI 実行基盤。claude = Claude API（API キー・従量課金）、claude_code = Claude Code CLI（ログイン済みのサブスク等）、simulated = ローカルシミュレーション */
export const AGENT_RUNTIMES = ['claude', 'claude_code', 'simulated'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

/** 利用量の計測方法。subscription = サブスク枠で実行（API 課金なし。トークン数のみ記録） */
export type UsageMeasurement = 'measured' | 'estimated' | 'subscription' | 'unmeasured';

export interface RunSummary {
  id: string;
  projectId: string;
  title: string;
  status: RunStatus;
  statusVersion: number;
  sourceType: 'manual' | 'github_issue';
  /** AI 実行基盤（claude = Claude API / claude_code = Claude Code CLI（サブスク） / simulated） */
  runtime: AgentRuntime;
  issueNumber: number | null;
  prNumber: number | null;
  currentStep: { key: StepKey; role: StepRole; status: StepStatus } | null;
  progress: number;
  revisionCount: number;
  costUsd: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface HubViewModel {
  queued: number;
  active: number;
  waitingApproval: number;
  completed24h: number;
  webhooks24h: number;
  paused: boolean;
  /** 月間予算に到達し、新規 Run の開始を保留中 */
  budgetExceeded: boolean;
}

export interface WorkspaceSettings {
  monthlyBudgetUsd: number;
  runBudgetUsd: number;
  maxConcurrentRuns: number;
  demoTraffic: boolean;
  paused: boolean;
}

export interface OfficeState {
  workspace: { id: string; name: string; settings: WorkspaceSettings };
  projects: ProjectViewModel[];
  seats: SeatViewModel[];
  hub: HubViewModel;
  runs: RunSummary[];
  approvalsPending: number;
  budget: { monthCostUsd: number; monthlyBudgetUsd: number };
  sequence: number;
  generatedAt: string;
}

export interface ApiError {
  code: string;
  message: string;
  requestId: string;
  details?: unknown;
}

/* ------------------------------------------------------------------ */
/* Labels（UI 表示用・色だけに依存しない表現: 要件定義書 7.1-3）           */
/* ------------------------------------------------------------------ */

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: '待機中',
  planning: '計画中',
  running: '実行中',
  validating: '検証中',
  pr_ready: 'PR作成済',
  waiting_review: 'レビュー待ち',
  revising: '再修正中',
  needs_input: '判断待ち',
  approved: '承認済',
  completed: '完了',
  failed: '失敗',
  cancelled: '中止',
};

export const AGENT_STATUS_LABEL: Record<AgentVisualStatus, string> = {
  idle: '待機',
  working: '作業中',
  reviewing: 'レビュー中',
  waiting_approval: '承認待ち',
  completed: '完了',
  failed: '失敗',
};

export const ROLE_LABEL: Record<StepRole, string> = {
  planner: 'Planner',
  developer: 'Developer',
  tester: 'Tester',
  reviewer: 'Reviewer',
  tool_broker: 'Tool Broker',
};

export const STEP_KEY_LABEL: Record<StepKey, string> = {
  plan: '計画',
  implement: '実装',
  test: 'テスト',
  review: 'レビュー',
  draft_pr: 'Draft PR作成',
  update_pr: 'PR更新',
};

export const APPROVAL_TYPE_LABEL: Record<ApprovalActionType, string> = {
  pr_review: 'Draft PR レビュー',
  dangerous_operation: '危険操作の検知',
  clarification: '判断・追加指示が必要',
};
