/**
 * 状態表示。色だけに依存せず、アイコン + ラベルを必ず併記する（要件定義書 7.1-3 / NFR-020）。
 */
import {
  AGENT_STATUS_LABEL,
  RUN_STATUS_LABEL,
  ROLE_LABEL,
  STEP_KEY_LABEL,
  type AgentVisualStatus,
  type RunStatus,
  type StepKey,
  type StepRole,
  type StepStatus,
} from '@paw/contracts';
import { Icon } from './Icon';

export const AGENT_STATUS_META: Record<AgentVisualStatus, { color: string; icon: string }> = {
  idle: { color: 'var(--s-idle)', icon: 'moon' },
  working: { color: 'var(--s-working)', icon: 'bolt' },
  reviewing: { color: 'var(--s-reviewing)', icon: 'search' },
  waiting_approval: { color: 'var(--s-waiting)', icon: 'hand' },
  completed: { color: 'var(--s-completed)', icon: 'check' },
  failed: { color: 'var(--s-failed)', icon: 'x' },
};

/** 3D 側で使う実色 */
export const AGENT_STATUS_HEX: Record<AgentVisualStatus, string> = {
  idle: '#8190a5',
  working: '#34d399',
  reviewing: '#60a5fa',
  waiting_approval: '#fbbf24',
  completed: '#a3e635',
  failed: '#f87171',
};

export const RUN_STATUS_META: Record<RunStatus, { tone: string; icon: string }> = {
  queued: { tone: 'muted', icon: 'clock' },
  planning: { tone: 'working', icon: 'map' },
  running: { tone: 'working', icon: 'bolt' },
  validating: { tone: 'reviewing', icon: 'flask' },
  pr_ready: { tone: 'reviewing', icon: 'git-pr' },
  waiting_review: { tone: 'waiting', icon: 'eye' },
  revising: { tone: 'working', icon: 'refresh' },
  needs_input: { tone: 'waiting', icon: 'help' },
  approved: { tone: 'completed', icon: 'check' },
  completed: { tone: 'completed', icon: 'check-circle' },
  failed: { tone: 'failed', icon: 'x-circle' },
  cancelled: { tone: 'muted', icon: 'slash' },
};

export const ROLE_META: Record<StepRole, { color: string; icon: string; blurb: string }> = {
  planner: { color: '#a5b4fc', icon: 'map', blurb: '依頼を読み、Step DAG と必要権限を計画する' },
  developer: { color: '#5eead4', icon: 'terminal', blurb: '隔離 worktree でコードを編集する（main へは書き込まない）' },
  tester: { color: '#fcd34d', icon: 'flask', blurb: 'ビルド・Lint・テストを実行して結果を記録する' },
  reviewer: { color: '#93c5fd', icon: 'search', blurb: '差分と受入条件を照合する（人間の承認の代わりにはならない）' },
  tool_broker: { color: '#f0abfc', icon: 'shield', blurb: 'ポリシー検証付きで GitHub 書き込みを代行する' },
};

export function RunStatusPill({ status, small }: { status: RunStatus; small?: boolean }) {
  const m = RUN_STATUS_META[status];
  return (
    <span className={`pill tone-${m.tone}${small ? ' pill-sm' : ''}`}>
      <Icon name={m.icon} size={small ? 12 : 13} />
      {RUN_STATUS_LABEL[status]}
    </span>
  );
}

export function AgentStatusPill({ status, small }: { status: AgentVisualStatus; small?: boolean }) {
  const m = AGENT_STATUS_META[status];
  return (
    <span className={`pill agent-${status}${small ? ' pill-sm' : ''}`}>
      <Icon name={m.icon} size={small ? 12 : 13} />
      {AGENT_STATUS_LABEL[status]}
    </span>
  );
}

const STEP_TONE: Record<StepStatus, string> = {
  pending: 'muted',
  running: 'working',
  succeeded: 'completed',
  failed: 'failed',
  needs_input: 'waiting',
  cancelled: 'muted',
  skipped: 'muted',
};
const STEP_ICON: Record<StepStatus, string> = {
  pending: 'clock',
  running: 'bolt',
  succeeded: 'check',
  failed: 'x',
  needs_input: 'help',
  cancelled: 'slash',
  skipped: 'slash',
};
const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  pending: '待機',
  running: '実行中',
  succeeded: '成功',
  failed: '失敗',
  needs_input: '判断待ち',
  cancelled: '中止',
  skipped: 'スキップ',
};

export function StepStatusPill({ status }: { status: StepStatus }) {
  return (
    <span className={`pill pill-sm tone-${STEP_TONE[status]}`}>
      <Icon name={STEP_ICON[status]} size={12} />
      {STEP_STATUS_LABEL[status]}
    </span>
  );
}

export function RoleBadge({ role, name }: { role: StepRole; name?: string | null }) {
  const m = ROLE_META[role];
  return (
    <span className="role-badge" style={{ ['--role' as string]: m.color }}>
      <Icon name={m.icon} size={12} />
      {name ? `${name} · ` : ''}
      {ROLE_LABEL[role]}
    </span>
  );
}

export function stepLabel(key: StepKey | null | undefined): string {
  return key ? STEP_KEY_LABEL[key] : '—';
}

export function ProgressBar({ value, tone }: { value: number; tone?: string }) {
  return (
    <div className={`progress tone-${tone ?? 'working'}`} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </div>
  );
}
