/**
 * 左パネル: Workspace 概要 → Project 概要 → Agent 詳細 の 3 段階。
 */
import { Link } from 'react-router';
import { AGENT_STATUS_LABEL, ROLE_LABEL, type OfficeState, type ProjectViewModel } from '@paw/contracts';
import { useOffice } from '../../shared/state/office';
import { Icon } from '../../shared/ui/Icon';
import { AGENT_STATUS_META, ROLE_META, RunStatusPill } from '../../shared/ui/status';
import { relTime, usd } from '../../shared/ui/format';
import { AgentInspector } from './AgentInspector';

export function LeftPanel({ snapshot }: { snapshot: OfficeState }) {
  const focusedProjectId = useOffice((s) => s.focusedProjectId);
  const selectedSeatKey = useOffice((s) => s.selectedSeatKey);
  const project = snapshot.projects.find((p) => p.id === focusedProjectId) ?? null;
  const seat = snapshot.seats.find((s) => s.key === selectedSeatKey) ?? null;

  return (
    <aside className="panel panel-left" aria-label="詳細パネル">
      {seat && project ? <AgentInspector key={seat.key} seat={seat} project={project} /> : project ? <ProjectSummary snapshot={snapshot} project={project} /> : <Overview snapshot={snapshot} />}
    </aside>
  );
}

function Overview({ snapshot }: { snapshot: OfficeState }) {
  const focusProject = useOffice((s) => s.focusProject);
  const { hub, budget } = snapshot;
  const pct = budget.monthlyBudgetUsd > 0 ? Math.min(1, budget.monthCostUsd / budget.monthlyBudgetUsd) : 0;
  const working = snapshot.seats.filter((s) => s.status === 'working' || s.status === 'reviewing').length;
  return (
    <div className="overview">
      <div className="card hero-card">
        <span className="eyebrow">
          <Icon name="office" size={13} /> MY OFFICE
        </span>
        <div className="hero-num">
          <strong>{snapshot.seats.length}</strong>
          <span>AGENTS</span>
          <em>
            {working} 稼働中 / {snapshot.projects.length} Projects
          </em>
        </div>
        <dl className="kv">
          <div>
            <dt>実行中の Run</dt>
            <dd>{hub.active}</dd>
          </div>
          <div>
            <dt>待機中</dt>
            <dd>{hub.queued}</dd>
          </div>
          <div>
            <dt>完了（24h）</dt>
            <dd>{hub.completed24h}</dd>
          </div>
          <div>
            <dt>Webhook（24h）</dt>
            <dd>{hub.webhooks24h}</dd>
          </div>
        </dl>
        {snapshot.approvalsPending > 0 ? (
          <Link to="/approvals" className="wait-banner">
            <Icon name="hand" size={14} /> {snapshot.approvalsPending} 件の承認待ち
            <Icon name="chevron-right" size={14} />
          </Link>
        ) : (
          <div className="ok-banner">
            <Icon name="check-circle" size={14} /> 承認待ちはありません
          </div>
        )}
        <div className="budget">
          <div className="budget-head">
            <span>今月の推定費用</span>
            <span className="mono">
              {usd(budget.monthCostUsd)} / {usd(budget.monthlyBudgetUsd, 0)}
            </span>
          </div>
          <div className={`progress ${pct > 0.9 ? 'tone-failed' : pct > 0.7 ? 'tone-waiting' : 'tone-working'}`}>
            <span style={{ width: `${Math.max(2, pct * 100)}%` }} />
          </div>
          <span className="hint">シミュレーション単価による推定値</span>
        </div>
      </div>
      <div className="section-title">PROJECTS</div>
      <div className="project-list">
        {snapshot.projects.map((p) => (
          <button key={p.id} className="project-row" style={{ ['--pc' as string]: p.color }} onClick={() => focusProject(p.id)}>
            <span className="pr-dot" />
            <span className="pr-main">
              <span className="pr-name">{p.name}</span>
              <span className="pr-sub">{p.repo ? p.repo.fullName : 'Repo 未接続'}</span>
            </span>
            <span className="pr-stats">
              {p.stats.waitingApproval > 0 ? (
                <span className="mini-badge waiting" title="承認待ち">
                  <Icon name="hand" size={11} />
                  {p.stats.waitingApproval}
                </span>
              ) : null}
              <span className="mini-badge" title="実行中">
                <Icon name="bolt" size={11} />
                {p.stats.doing}
              </span>
            </span>
          </button>
        ))}
        {snapshot.projects.length === 0 ? (
          <div className="empty">
            Project がありません。<Link to="/projects">Projects</Link> から作成してください。
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProjectSummary({ snapshot, project }: { snapshot: OfficeState; project: ProjectViewModel }) {
  const focusProject = useOffice((s) => s.focusProject);
  const selectSeat = useOffice((s) => s.selectSeat);
  const seats = snapshot.seats.filter((s) => s.projectId === project.id);
  const runs = snapshot.runs.filter((r) => r.projectId === project.id).slice(0, 5);
  const st = project.stats;
  return (
    <div className="project-summary">
      <button className="back-link" onClick={() => focusProject(null)}>
        <Icon name="chevron-left" size={14} /> オフィス全体
      </button>
      <div className="card project-card" style={{ ['--pc' as string]: project.color }}>
        <span className="eyebrow">
          <span className="pr-dot" /> {project.name.toUpperCase()}
        </span>
        <div className="hero-num">
          <strong>{seats.length}</strong>
          <span>AGENTS</span>
        </div>
        <p className="muted small">{project.description || '説明なし'}</p>
        <dl className="kv">
          <div>
            <dt>Open Draft PR</dt>
            <dd>{st.openPrs}</dd>
          </div>
          <div>
            <dt>失敗（24h）</dt>
            <dd>{st.failed24h}</dd>
          </div>
        </dl>
        <div className="dnd">
          DOING <b>{st.doing}</b> · NEXT <b>{st.next}</b> · DONE <b>{st.done24h}</b>
        </div>
        {st.waitingApproval > 0 ? (
          <Link to="/approvals" className="wait-banner">
            <Icon name="hand" size={14} /> {st.waitingApproval} 件の承認待ち <Icon name="chevron-right" size={14} />
          </Link>
        ) : null}
        <div className="repo-line">
          <Icon name="branch" size={13} />
          {project.repo ? (
            <>
              <span className="mono">{project.repo.fullName}</span>
              <span className={`auto-badge${project.repo.automationEnabled ? ' on' : ''}`}>
                {project.repo.automationEnabled ? `自動起動 ON · ${project.repo.triggerLabel}` : '自動起動 OFF'}
              </span>
            </>
          ) : (
            <span className="muted">Repo 未接続</span>
          )}
        </div>
      </div>
      <div className="section-title">AGENTS</div>
      <div className="seat-list">
        {seats.map((s) => {
          const m = AGENT_STATUS_META[s.status];
          return (
            <button key={s.key} className={`seat-row agent-${s.status}`} onClick={() => selectSeat(s.key)} style={{ ['--role' as string]: ROLE_META[s.role].color }}>
              <span className="seat-icon">
                <Icon name={ROLE_META[s.role].icon} size={15} />
              </span>
              <span className="seat-main">
                <span className="seat-name">
                  {s.name} <em>{ROLE_LABEL[s.role]}</em>
                </span>
                <span className="seat-reason">{s.statusReason}</span>
              </span>
              <span className="seat-status">
                <Icon name={m.icon} size={12} /> {AGENT_STATUS_LABEL[s.status]}
              </span>
            </button>
          );
        })}
      </div>
      <div className="section-title">最近の RUN</div>
      <div className="mini-runs">
        {runs.map((r) => (
          <Link key={r.id} to={`/runs/${r.id}`} className="mini-run">
            <RunStatusPill status={r.status} small />
            <span className="mini-run-title">{r.title}</span>
            <span className="muted small">{relTime(r.updatedAt)}</span>
          </Link>
        ))}
        {runs.length === 0 ? <div className="empty">Run はまだありません</div> : null}
      </div>
    </div>
  );
}
