/**
 * @paw/office-model — Run / Step / Approval → 3D 表示状態 への投影（基本設計書 13.1 packages/office-model）
 *
 * 純粋関数のみ。サーバーが確定した状態から決定的に算出し、キャラクターの「演出」で
 * 作業中と誤認させない（要件定義書 7.1-1）。
 */
import {
  ACTIVE_RUN_STATUSES,
  AGENT_ROLES,
  ROLE_LABEL,
  STEP_KEY_LABEL,
  type AgentRole,
  type AgentVisualStatus,
  type ApprovalActionType,
  type ProjectStats,
  type RunStatus,
  type SeatViewModel,
  type StepKey,
  type StepRole,
  type StepStatus,
} from '@paw/contracts';

export interface ProjectionAgent {
  id: string;
  role: AgentRole;
  name: string;
  version: number;
}

export interface ProjectionProject {
  id: string;
}

export interface ProjectionRun {
  id: string;
  projectId: string;
  title: string;
  status: RunStatus;
  prNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface ProjectionStep {
  id: string;
  runId: string;
  projectId: string;
  role: StepRole;
  key: StepKey;
  status: StepStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface ProjectionApproval {
  id: string;
  runId: string;
  projectId: string;
  actionType: ApprovalActionType;
  /** 承認待ちを表示する席（要求元 Agent） */
  requestedByRole: AgentRole;
  createdAt: Date;
}

export interface ProjectionInput {
  now: Date;
  workspaceId: string;
  projects: ProjectionProject[];
  agents: ProjectionAgent[];
  /** 非終端 Run と直近に終了した Run */
  runs: ProjectionRun[];
  /** 上記 Run の Step */
  steps: ProjectionStep[];
  /** pending の Approval のみ */
  approvals: ProjectionApproval[];
}

/** 成功直後の「完了」表示を保持する時間 */
export const COMPLETED_HOLD_MS = 90_000;
/** 失敗表示を保持する時間（新しい Step が始まれば即座に上書き） */
export const FAILED_HOLD_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const STATUS_PRIORITY: Record<AgentVisualStatus, number> = {
  working: 5,
  reviewing: 5,
  waiting_approval: 4,
  failed: 3,
  completed: 2,
  idle: 1,
};

function maxDate(dates: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d > best)) best = d;
  return best;
}

export function seatKey(projectId: string, role: AgentRole): string {
  return `${projectId}:${role}`;
}

/**
 * 1 席（Project × Role）の表示状態を決定する。
 * 優先度: 実行中 Step > 未処理 Approval > 直近失敗 > 直近完了 > idle
 */
export function deriveSeat(
  input: ProjectionInput,
  project: ProjectionProject,
  agent: ProjectionAgent,
): SeatViewModel {
  const { now } = input;
  const runsById = new Map(input.runs.map((r) => [r.id, r]));
  const mySteps = input.steps.filter((s) => s.projectId === project.id && s.role === agent.role);
  const running = mySteps
    .filter((s) => s.status === 'running')
    .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
  const approvals = input.approvals.filter(
    (a) => a.projectId === project.id && a.requestedByRole === agent.role,
  );

  let status: AgentVisualStatus = 'idle';
  let statusReason = '担当中の Run はありません';
  let currentRun: SeatViewModel['currentRun'] = null;

  if (running.length > 0) {
    const step = running[0];
    const run = runsById.get(step.runId);
    status = agent.role === 'reviewer' ? 'reviewing' : 'working';
    statusReason = `「${run?.title ?? step.runId}」の${STEP_KEY_LABEL[step.key]}を実行中`;
    if (running.length > 1) statusReason += `（他 ${running.length - 1} 件）`;
    currentRun = run
      ? { id: run.id, title: run.title, status: run.status, stepKey: step.key, stepId: step.id }
      : null;
  } else if (approvals.length > 0) {
    const ap = [...approvals].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    const run = runsById.get(ap.runId);
    status = 'waiting_approval';
    statusReason =
      ap.actionType === 'pr_review'
        ? `Draft PR${run?.prNumber ? ` #${run.prNumber}` : ''} の人間によるレビュー待ち`
        : ap.actionType === 'dangerous_operation'
          ? '危険な操作を検知したため停止中（判断が必要）'
          : '追加の指示・判断が必要';
    if (approvals.length > 1) statusReason += `（他 ${approvals.length - 1} 件）`;
    currentRun = run
      ? { id: run.id, title: run.title, status: run.status, stepKey: null, stepId: null }
      : null;
  } else {
    const finished = mySteps
      .filter((s) => s.finishedAt && (s.status === 'succeeded' || s.status === 'failed'))
      .sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime());
    const last = finished[0];
    if (last) {
      const age = now.getTime() - last.finishedAt!.getTime();
      const run = runsById.get(last.runId);
      if (last.status === 'failed' && age <= FAILED_HOLD_MS) {
        status = 'failed';
        statusReason = `「${run?.title ?? last.runId}」の${STEP_KEY_LABEL[last.key]}が失敗`;
        currentRun = run
          ? { id: run.id, title: run.title, status: run.status, stepKey: last.key, stepId: last.id }
          : null;
      } else if (last.status === 'succeeded' && age <= COMPLETED_HOLD_MS) {
        status = 'completed';
        statusReason = `「${run?.title ?? last.runId}」の${STEP_KEY_LABEL[last.key]}が完了`;
        currentRun = run
          ? { id: run.id, title: run.title, status: run.status, stepKey: last.key, stepId: last.id }
          : null;
      }
    }
  }

  const activeRunIds = Array.from(
    new Set([...running.map((s) => s.runId), ...approvals.map((a) => a.runId)]),
  );
  const lastEventAt = maxDate([
    ...mySteps.map((s) => s.finishedAt ?? s.startedAt),
    ...approvals.map((a) => a.createdAt),
  ]);

  return {
    key: seatKey(project.id, agent.role),
    agentId: agent.id,
    workspaceId: input.workspaceId,
    projectId: project.id,
    name: agent.name,
    role: agent.role,
    status,
    statusReason,
    activeRunIds,
    activeProjectIds: activeRunIds.length > 0 ? [project.id] : [],
    currentRun,
    lastEventAt: lastEventAt ? lastEventAt.toISOString() : null,
    version: agent.version,
  };
}

export function buildSeats(input: ProjectionInput): SeatViewModel[] {
  const seats: SeatViewModel[] = [];
  const agentsByRole = new Map(input.agents.map((a) => [a.role, a]));
  for (const project of input.projects) {
    for (const role of AGENT_ROLES) {
      const agent = agentsByRole.get(role);
      if (agent) seats.push(deriveSeat(input, project, agent));
    }
  }
  return seats;
}

export function buildProjectStats(input: ProjectionInput, projectId: string): ProjectStats {
  const since = input.now.getTime() - DAY_MS;
  const runs = input.runs.filter((r) => r.projectId === projectId);
  return {
    doing: runs.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status)).length,
    next: runs.filter((r) => r.status === 'queued').length,
    done24h: runs.filter(
      (r) => r.status === 'completed' && (r.finishedAt?.getTime() ?? 0) >= since,
    ).length,
    failed24h: runs.filter((r) => r.status === 'failed' && (r.finishedAt?.getTime() ?? 0) >= since)
      .length,
    waitingApproval: input.approvals.filter((a) => a.projectId === projectId).length,
    openPrs: runs.filter((r) => r.status === 'waiting_review').length,
  };
}

/** Workspace 横断で論理 Agent ごとに集約した状態（2D 一覧用・基本設計書 5.2 AgentViewModel） */
export function aggregateAgentStatus(seats: SeatViewModel[]): Map<string, AgentVisualStatus> {
  const out = new Map<string, AgentVisualStatus>();
  for (const s of seats) {
    const prev = out.get(s.agentId);
    if (!prev || STATUS_PRIORITY[s.status] > STATUS_PRIORITY[prev]) out.set(s.agentId, s.status);
  }
  return out;
}

export function describeRole(role: StepRole): string {
  return ROLE_LABEL[role];
}

/** Run の進捗率（表示用の目安。業務の成功を保証しない） */
export function runProgress(status: RunStatus, currentStepKey: StepKey | null): number {
  switch (status) {
    case 'queued':
      return 0.02;
    case 'planning':
      return 0.12;
    case 'running':
    case 'revising':
      return currentStepKey === 'implement' ? 0.4 : 0.32;
    case 'validating':
      return currentStepKey === 'review' ? 0.75 : currentStepKey === 'draft_pr' ? 0.88 : 0.6;
    case 'pr_ready':
      return 0.92;
    case 'waiting_review':
    case 'needs_input':
      return 0.95;
    case 'approved':
    case 'completed':
      return 1;
    case 'failed':
    case 'cancelled':
      return 1;
  }
}
