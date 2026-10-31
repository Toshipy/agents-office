/**
 * My Runs（UI-03 / FR-006 / FR-013）。検索・状態 / Project フィルター・cursor ページング。
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { RUN_STATUSES, RUN_STATUS_LABEL, ROLE_LABEL, type RunStatus } from '@paw/contracts';
import { api, type ProjectDto, type RunListItem } from '../../shared/api/client';
import { Icon } from '../../shared/ui/Icon';
import { ProgressBar, RUN_STATUS_META, RunStatusPill, stepLabel } from '../../shared/ui/status';
import { relTime, usd } from '../../shared/ui/format';

export function RunListPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<RunStatus | ''>('');
  const [projectId, setProjectId] = useState('');
  const projects = useQuery({ queryKey: ['projects', 'all'], queryFn: () => api.get<{ items: ProjectDto[] }>('/v1/projects?includeArchived=1') });
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  if (status) params.set('status', status);
  if (projectId) params.set('projectId', projectId);
  const runs = useInfiniteQuery({
    queryKey: ['runs', 'list', q.trim(), status, projectId],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(params);
      if (pageParam) p.set('cursor', pageParam);
      return api.get<{ items: RunListItem[]; nextCursor: string | null; total: number }>(`/v1/runs?${p.toString()}`);
    },
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = runs.data?.pages.flatMap((p) => p.items) ?? [];
  const total = runs.data?.pages[0]?.total ?? 0;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>My Runs</h1>
          <p className="muted">Workspace 横断の Run 一覧（あなたの Run だけが表示されます）</p>
        </div>
      </header>
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="タイトル・Run ID で検索" aria-label="検索" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value as RunStatus | '')} aria-label="状態">
          <option value="">すべての状態</option>
          {RUN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {RUN_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          <option value="">すべての Project</option>
          {projects.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.status === 'archived' ? '（アーカイブ）' : ''}
            </option>
          ))}
        </select>
        <span className="muted small">{total} 件</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>状態</th>
              <th>タイトル</th>
              <th>Project</th>
              <th>現在のステップ</th>
              <th>起点</th>
              <th className="num">推定費用</th>
              <th>更新</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td>
                  <RunStatusPill status={r.status} small />
                </td>
                <td>
                  <Link to={`/runs/${r.id}`} className="row-link">
                    {r.title}
                  </Link>
                  <div className="mono faint small">{r.id}</div>
                </td>
                <td>
                  <span className="task-project" style={{ ['--pc' as string]: r.project?.color ?? '#94a3b8' }}>
                    {r.project?.name ?? '—'}
                  </span>
                </td>
                <td>
                  {r.currentStep ? (
                    <div className="cell-step">
                      <span>
                        {ROLE_LABEL[r.currentStep.role]} · {stepLabel(r.currentStep.key)}
                      </span>
                      <ProgressBar value={r.progress} tone={RUN_STATUS_META[r.status].tone} />
                    </div>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="small">
                  {r.sourceType === 'github_issue' ? `GitHub Issue #${r.issueNumber}` : '手動'}
                  {r.prNumber ? <div className="muted">Draft PR #{r.prNumber}</div> : null}
                </td>
                <td className="num mono">{usd(r.costUsd)}</td>
                <td className="small muted">{relTime(r.updatedAt)}</td>
              </tr>
            ))}
            {!runs.isLoading && items.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty">
                  該当する Run はありません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {runs.hasNextPage ? (
        <button className="btn" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
          さらに読み込む
        </button>
      ) : null}
    </div>
  );
}
