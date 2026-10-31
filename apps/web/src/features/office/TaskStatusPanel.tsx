/**
 * 右パネル: タスク（Run）の状態一覧と依頼フォーム。
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ROLE_LABEL, type OfficeState, type RunStatus, type RunSummary } from '@paw/contracts';
import { useOffice } from '../../shared/state/office';
import { Icon } from '../../shared/ui/Icon';
import { ProgressBar, RUN_STATUS_META, RunStatusPill, stepLabel } from '../../shared/ui/status';
import { relTime } from '../../shared/ui/format';
import { TaskComposer } from './TaskComposer';

type Filter = 'all' | 'active' | 'waiting' | 'queued' | 'done' | 'failed';

const FILTERS: { key: Filter; label: string; match(s: RunStatus): boolean }[] = [
  { key: 'all', label: 'すべて', match: () => true },
  { key: 'active', label: '進行中', match: (s) => ['planning', 'running', 'validating', 'pr_ready', 'revising', 'approved'].includes(s) },
  { key: 'waiting', label: '承認待ち', match: (s) => s === 'waiting_review' || s === 'needs_input' },
  { key: 'queued', label: '待機', match: (s) => s === 'queued' },
  { key: 'done', label: '完了', match: (s) => s === 'completed' },
  { key: 'failed', label: '失敗/中止', match: (s) => s === 'failed' || s === 'cancelled' },
];

export function TaskStatusPanel({ snapshot }: { snapshot: OfficeState }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [scopeFocused, setScopeFocused] = useState(true);
  const focusedProjectId = useOffice((s) => s.focusedProjectId);
  const selectSeat = useOffice((s) => s.selectSeat);
  const focusProject = useOffice((s) => s.focusProject);
  const projectsById = useMemo(() => new Map(snapshot.projects.map((p) => [p.id, p])), [snapshot.projects]);
  const scoped = snapshot.runs.filter((r) => !(scopeFocused && focusedProjectId) || r.projectId === focusedProjectId);
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, scoped.filter((r) => f.match(r.status)).length])) as Record<Filter, number>;
  const visible = scoped.filter((r) => FILTERS.find((f) => f.key === filter)!.match(r.status)).slice(0, 60);

  const open = (r: RunSummary) => {
    const role = r.status === 'waiting_review' ? 'reviewer' : r.status === 'needs_input' ? 'planner' : r.currentStep?.role;
    if (role && role !== 'tool_broker') selectSeat(`${r.projectId}:${role}`);
    else focusProject(r.projectId);
  };

  return (
    <aside className="panel panel-right" aria-label="タスクの状態">
      <TaskComposer />
      <div className="tasks-head">
        <h2>
          <Icon name="list" size={15} /> TASK STATUS
        </h2>
        {focusedProjectId ? (
          <button className={`scope-toggle${scopeFocused ? ' on' : ''}`} onClick={() => setScopeFocused((v) => !v)}>
            {scopeFocused ? projectsById.get(focusedProjectId)?.name ?? 'Project' : '全 Project'}
          </button>
        ) : (
          <span className="scope-label">全 Project</span>
        )}
      </div>
      <div className="filter-chips" role="tablist" aria-label="状態フィルター">
        {FILTERS.map((f) => (
          <button key={f.key} role="tab" aria-selected={filter === f.key} className={`fchip${filter === f.key ? ' on' : ''}${f.key === 'waiting' && counts.waiting > 0 ? ' warn' : ''}`} onClick={() => setFilter(f.key)}>
            {f.label} <b>{counts[f.key]}</b>
          </button>
        ))}
      </div>
      <ul className="task-list">
        {visible.map((r) => {
          const p = projectsById.get(r.projectId);
          const tone = RUN_STATUS_META[r.status].tone;
          return (
            <li key={r.id} className={`task tone-${tone}`}>
              <button className="task-main" onClick={() => open(r)}>
                <span className="task-top">
                  <RunStatusPill status={r.status} small />
                  <span className="task-time">{relTime(r.updatedAt)}</span>
                </span>
                <span className="task-title">{r.title}</span>
                <span className="task-meta">
                  <span className="task-project" style={{ ['--pc' as string]: p?.color ?? '#94a3b8' }}>
                    {p?.name ?? '—'}
                  </span>
                  {r.currentStep && !['completed', 'cancelled', 'waiting_review', 'needs_input'].includes(r.status) ? (
                    <span>
                      {ROLE_LABEL[r.currentStep.role]} · {stepLabel(r.currentStep.key)}
                    </span>
                  ) : null}
                  {r.prNumber ? <span>Draft PR #{r.prNumber}</span> : null}
                  {r.sourceType === 'github_issue' ? <span>Issue #{r.issueNumber}</span> : null}
                  {r.runtime === 'claude' ? <span className="runtime-tag">Claude</span> : null}
                  {r.revisionCount > 0 ? <span>rev {r.revisionCount}</span> : null}
                  {r.errorCode ? <span className="err">{r.errorCode}</span> : null}
                </span>
                {['planning', 'running', 'validating', 'revising', 'pr_ready', 'queued'].includes(r.status) ? <ProgressBar value={r.progress} tone={tone} /> : null}
              </button>
              <Link className="task-open" to={`/runs/${r.id}`} aria-label="Run 詳細を開く">
                <Icon name="external" size={14} />
              </Link>
            </li>
          );
        })}
        {visible.length === 0 ? <li className="empty">該当するタスクはありません</li> : null}
      </ul>
    </aside>
  );
}
