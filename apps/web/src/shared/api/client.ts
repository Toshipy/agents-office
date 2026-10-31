/**
 * API クライアント。Cookie セッション + CSRF 用ヘッダー（x-paw-client）を付与する。
 * エラーは { code, message, requestId } 形式（基本設計書 6.1）。
 */
import type {
  AgentRuntime,
  AgentVisualStatus,
  ApprovalActionType,
  ApprovalDecision,
  ApprovalStatus,
  AutomationPolicy,
  OfficeState,
  RunStatus,
  RunSummary,
  StepKey,
  StepLogLine,
  StepRole,
  StepStatus,
  WorkspaceEvent,
  WorkspaceSettings,
} from '@paw/contracts';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'x-paw-client': 'web',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'サーバーに接続できません（API が起動しているか確認してください）');
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const e = (data ?? {}) as { code?: string; message?: string; requestId?: string };
    throw new ApiError(res.status, e.code ?? 'HTTP_ERROR', e.message ?? `HTTP ${res.status}`, e.requestId);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', path, body ?? {}, headers),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export function newIdempotencyKey() {
  return `idem-${crypto.randomUUID()}`;
}

/* ------------------------------------------------------------------ */
/* Response types                                                      */
/* ------------------------------------------------------------------ */

export interface Me {
  user: { id: string; username: string; displayName: string };
  workspace: { id: string; name: string; settings: WorkspaceSettings; createdAt: string };
}

export interface ProjectDto {
  id: string;
  name: string;
  description: string;
  color: string;
  position: number;
  status: 'active' | 'archived';
  agentConfig: { roles: string[]; workflow: string };
  createdAt: string;
  updatedAt: string;
  repository: {
    id: string;
    fullName: string;
    installationId: number;
    repositoryId: number;
    verification: string;
    automationEnabled: boolean;
    policy: AutomationPolicy & { triggerLabel: string };
    localPath?: string | null;
    testCommand?: string | null;
    /** GitHub App 連携: サーバーが GitHub から取得した作業コピーを使う */
    managedCheckout?: boolean;
    defaultBranch?: string | null;
    runtime?: AgentRuntime;
  } | null;
}

export interface RunListItem extends RunSummary {
  project: { id: string; name: string; color: string } | null;
}

export interface StepDto {
  id: string;
  seq: number;
  key: StepKey;
  role: StepRole;
  agentId: string | null;
  agentVersion: number | null;
  model: string | null;
  status: StepStatus;
  attempt: number;
  maxAttempts: number;
  revision: number;
  summary: string | null;
  errorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ApprovalDto {
  id: string;
  workspaceId: string;
  runId: string;
  projectId: string;
  actionType: ApprovalActionType;
  requestedByRole: string;
  title: string;
  payload: Record<string, any>;
  payloadDigest: string;
  status: ApprovalStatus;
  version: number;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  createdAt: string;
  run?: { id: string; title: string; status: RunStatus };
  project?: { id: string; name: string; color: string };
}

export interface ArtifactMeta {
  id: string;
  kind: 'plan' | 'diff' | 'test_report' | 'review' | 'draft_pr' | 'log';
  title: string;
  stepId?: string | null;
  mediaType: string;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
}

export interface RunDetail {
  run: RunSummary & {
    request: string;
    source: { type: string; issueNumber?: number; issueUrl?: string; deliveryId?: string };
    plan: { steps: { id: string; role: string; dependsOn: string[] }[]; flags: string[]; summary: string } | null;
    guidance: string | null;
    maxRevisionAttempts: number;
    fixLoops: number;
    budgetLimitUsd: number;
    pr: { number: number; url: string; branch: string; headSha: string; draft: boolean } | null;
    branch: string;
    model?: string;
    errorMessage: string | null;
    durationMs: number | null;
  };
  project: { id: string; name: string; color: string } | null;
  repository: { fullName: string; localPath?: string | null } | null;
  steps: StepDto[];
  approvals: ApprovalDto[];
  artifacts: ArtifactMeta[];
  usage: { measurement: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number; records: number };
  events: { id: string; sequence: number; type: string; occurredAt: string; data: Record<string, any> }[];
}

export interface AgentDto {
  id: string;
  role: string;
  name: string;
  model: string;
  runtime: string;
  promptVersion: string;
  toolPolicy: string[];
  version: number;
  status: AgentVisualStatus;
  activeRunIds: string[];
  activeProjectIds: string[];
}

export interface RuntimeInfo {
  runtime: AgentRuntime;
  mode: 'auto' | AgentRuntime;
  reason: string;
  model: string | null;
  effort: string | null;
  fallbacks: string | null;
  billing: 'api' | 'subscription' | 'none';
  claudeCode: {
    bin: string;
    restricted: boolean;
    allowApiBilling: boolean;
    maxTurns: { plan: number; review: number; develop: number };
    version: string | null;
    loggedIn: boolean | null;
    authMethod: string | null;
    authLabel: string | null;
    problem: string | null;
  };
  stepTimeoutMs: number;
  note: string;
}

export type { OfficeState, StepLogLine, WorkspaceEvent, ApprovalDecision };

export interface GithubInstallationsDto {
  mode: 'github_app' | 'simulated';
  note: string;
  allowedUsers?: string[];
  error?: string | null;
  installations: {
    installationId: number;
    account: string;
    repositories: { fullName: string; repositoryId: number; private?: boolean; projectId: string | null }[];
  }[];
}
