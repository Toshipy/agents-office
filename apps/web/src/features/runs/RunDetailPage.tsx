/**
 * Run Detail（UI-04）: Step / モデル / ツール / ログ / 費用 / Artifact / イベント。
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLE_LABEL, isTerminal, type StepLogLine } from '@paw/contracts';
import { ApiError, api, type RunDetail } from '../../shared/api/client';
import { Icon } from '../../shared/ui/Icon';
import { ArtifactBody, Modal, artifactIcon } from '../../shared/ui/content';
import { RoleBadge, RunStatusPill, StepStatusPill, stepLabel } from '../../shared/ui/status';
import { duration, fmtNum, relTime, usd } from '../../shared/ui/format';
import { toast } from '../../shared/ui/toast';
import { useOffice } from '../../shared/state/office';
import { ApprovalCard } from '../approvals/ApprovalCard';
import { isClaudeRuntime, runtimeLabel } from '../../shared/runtime';

type Tab = 'steps' | 'artifacts' | 'events';

export function RunDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['run', id], queryFn: () => api.get<RunDetail>(`/v1/runs/${id}`), retry: false });
  const logs = useQuery({
    queryKey: ['run', id, 'logs'],
    queryFn: () => api.get<{ items: StepLogLine[] }>(`/v1/runs/${id}/logs`),
    enabled: q.isSuccess,
    refetchInterval: q.data && !isTerminal(q.data.run.status) ? 2500 : false,
  });
  const [tab, setTab] = useState<Tab>('steps');
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const liveLogs = useOffice((s) => s.logs);

  const logsByStep = useMemo(() => {
    const m = new Map<string, StepLogLine[]>();
    for (const l of logs.data?.items ?? []) m.set(l.stepId, [...(m.get(l.stepId) ?? []), l]);
    for (const [stepId, lines] of Object.entries(liveLogs)) {
      if (!q.data?.steps.some((s) => s.id === stepId)) continue;
      const cur = m.get(stepId) ?? [];
      const ids = new Set(cur.map((x) => x.id));
      m.set(stepId, [...cur, ...lines.filter((x) => !ids.has(x.id))].sort((a, b) => a.id - b.id));
    }
    return m;
  }, [logs.data, liveLogs, q.data?.steps]);

  if (q.isLoading) return <div className="page muted">読み込み中…</div>;
  if (q.error) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="page">
        <div className="empty-state">
          <Icon name="slash" size={28} />
          <h2>{notFound ? 'Run が見つかりません' : '読み込みに失敗しました'}</h2>
          <p className="muted">{notFound ? '存在しないか、あなたのワークスペースの Run ではありません。' : String(q.error)}</p>
          <Link className="btn" to="/runs">
            Run 一覧へ
          </Link>
        </div>
      </div>
    );
  }
  const d = q.data!;
  const run = d.run;
  const canCancel = !isTerminal(run.status);
  const pendingApprovals = d.approvals.filter((a) => a.status === 'pending');

  const cancel = async () => {
    if (!window.confirm('この Run を中止しますか？ 実行中の Runner は停止されます。')) return;
    try {
      await api.post(`/v1/runs/${run.id}/cancel`);
      toast({ tone: 'info', title: 'Run を中止しました' });
      void qc.invalidateQueries({ queryKey: ['run', id] });
    } catch (e) {
      toast({ tone: 'error', title: '中止できませんでした', body: e instanceof ApiError ? e.message : String(e) });
    }
  };

  return (
    <div className="page run-detail">
      <Link to="/runs" className="back-link">
        <Icon name="chevron-left" size={14} /> Runs
      </Link>
      <header className="page-head">
        <div>
          <div className="head-pills">
            <RunStatusPill status={run.status} />
            {d.project ? (
              <span className="task-project" style={{ ['--pc' as string]: d.project.color }}>
                {d.project.name}
              </span>
            ) : null}
            <span className={`runtime-pill ${run.runtime}`} title={isClaudeRuntime(run.runtime) ? `${runtimeLabel(run.runtime)}（${run.model ?? ''}）がローカルリポジトリで実行` : 'ローカルシミュレーション'}>
              {isClaudeRuntime(run.runtime) ? `${runtimeLabel(run.runtime)} · ${run.model ?? ''}` : 'シミュレーション'}
            </span>
            <span className="mono faint small">{run.id}</span>
          </div>
          <h1>{run.title}</h1>
          <p className="muted small">
            {run.source.type === 'github_issue' ? `GitHub Issue #${run.source.issueNumber} から自動起動` : '手動依頼'} · 作成 {relTime(run.createdAt)} · 所要{' '}
            {duration(run.durationMs)}
          </p>
        </div>
        <div className="head-actions">
          {canCancel ? (
            <button className="btn danger" onClick={() => void cancel()}>
              <Icon name="stop" size={14} /> 中止
            </button>
          ) : null}
        </div>
      </header>

      {run.errorCode ? (
        <div className={`banner ${run.status === 'cancelled' ? 'muted-banner' : 'error-banner'}`}>
          <Icon name={run.status === 'cancelled' ? 'slash' : 'x-circle'} size={16} />
          <div>
            <strong>{run.errorCode}</strong>
            <div>{run.errorMessage}</div>
          </div>
        </div>
      ) : null}

      {pendingApprovals.map((a) => (
        <ApprovalCard key={a.id} approval={{ ...a, run: { id: run.id, title: run.title, status: run.status }, project: d.project ?? undefined }} />
      ))}

      <div className="detail-grid">
        <section className="card">
          <h3 className="card-title">
            <Icon name="git-pr" size={15} /> 成果物の概要
          </h3>
          <dl className="kv single">
            <div>
              <dt>Repo</dt>
              <dd className="mono">{d.repository?.fullName ?? '—'}</dd>
            </div>
            <div>
              <dt>ブランチ</dt>
              <dd className="mono">{run.branch}</dd>
            </div>
            <div>
              <dt>Draft PR</dt>
              <dd className="mono">
                {run.pr ? (
                  run.pr.url.startsWith('https://') ? (
                    <a href={run.pr.url} target="_blank" rel="noreferrer">
                      #{run.pr.number}（{run.pr.headSha.slice(0, 7)}）
                    </a>
                  ) : (
                    `#${run.pr.number}（${run.pr.headSha.slice(0, 7)}）`
                  )
                ) : (
                  '—'
                )}
              </dd>
            </div>
            <div>
              <dt>再修正</dt>
              <dd>
                {run.revisionCount} / {run.maxRevisionAttempts}
              </dd>
            </div>
          </dl>
          {run.pr ? (
            <p className="hint">
              {run.pr.url.startsWith('https://')
                ? 'GitHub の Draft PR でレビューしてください。Approve で完了、Request changes で同じ PR を修正します。マージは人が行います（AI はマージできません）。'
                : isClaudeRuntime(run.runtime)
                ? `ローカルリポジトリ（${d.repository?.localPath ?? ''}）のブランチ ${run.branch} に変更があります。確認してから人がマージしてください（AI はマージできません）。`
                : 'PR はローカル GitHub シミュレーター上の Draft です。マージは人が行います（AI はマージできません）。'}
            </p>
          ) : null}
        </section>
        <section className="card">
          <h3 className="card-title">
            <Icon name="dollar" size={15} /> 利用量（{d.usage.measurement === 'measured' ? '実測トークン' : d.usage.measurement === 'subscription' ? 'サブスク枠' : '推定'}）
          </h3>
          <dl className="kv cols">
            <div>
              <dt>推定費用</dt>
              <dd className="mono">{usd(d.usage.estimatedCostUsd, 4)}</dd>
            </div>
            <div>
              <dt>Run 予算</dt>
              <dd className="mono">{usd(run.budgetLimitUsd)}</dd>
            </div>
            <div>
              <dt>入力トークン</dt>
              <dd className="mono">{fmtNum(d.usage.inputTokens)}</dd>
            </div>
            <div>
              <dt>出力トークン</dt>
              <dd className="mono">{fmtNum(d.usage.outputTokens)}</dd>
            </div>
          </dl>
          <p className="hint">
            {d.usage.measurement === 'measured'
              ? 'Claude API が返したトークン数 × 公開単価で計算しています。'
              : d.usage.measurement === 'subscription'
                ? 'Claude Code をサブスクの利用枠で実行したため API の請求はありません（費用 $0）。トークン数は CLI が報告した値です。'
                : run.runtime === 'claude_code'
                  ? 'Claude Code が報告した API 換算の推定額です（API キーで動いた場合）。'
                  : 'シミュレーション単価による推定です（実際のモデル料金ではありません）。'}
          </p>
        </section>
        <section className="card">
          <h3 className="card-title">
            <Icon name="file" size={15} /> 依頼内容（非信頼入力）
          </h3>
          <pre className="request">{run.request}</pre>
          {run.guidance ? (
            <p className="small">
              <strong>人からの追加指示:</strong> {run.guidance}
            </p>
          ) : null}
        </section>
      </div>

      <div className="pipeline">
        {d.steps.map((s) => (
          <button key={s.id} className={`pipe-step st-${s.status}`} onClick={() => setOpenStep(s.id === openStep ? null : s.id)}>
            <span className="ps-key">{stepLabel(s.key)}</span>
            <span className="ps-role">{ROLE_LABEL[s.role]}</span>
            {s.revision > 0 ? <span className="ps-rev">rev {s.revision}</span> : null}
          </button>
        ))}
      </div>

      <div className="tabs" role="tablist">
        {(['steps', 'artifacts', 'events'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'steps' ? `Steps（${d.steps.length}）` : t === 'artifacts' ? `成果物（${d.artifacts.length}）` : `イベント（${d.events.length}）`}
          </button>
        ))}
      </div>

      {tab === 'steps' ? (
        <div className="steps">
          {d.steps.map((s) => {
            const lines = logsByStep.get(s.id) ?? [];
            const open = openStep === s.id || s.status === 'running';
            return (
              <div key={s.id} className={`step-row st-${s.status}`}>
                <button className="step-head" onClick={() => setOpenStep(open && openStep === s.id ? null : s.id)} aria-expanded={open}>
                  <span className="step-seq mono">#{s.seq}</span>
                  <StepStatusPill status={s.status} />
                  <span className="step-name">{stepLabel(s.key)}</span>
                  <RoleBadge role={s.role} />
                  <span className="step-summary">{s.summary ?? ''}</span>
                  <span className="step-meta mono small">
                    {s.model ?? '—'}
                    {s.agentVersion ? ` v${s.agentVersion}` : ''} · 試行 {s.attempt}/{s.maxAttempts} · {duration(s.startedAt ? (s.finishedAt ? new Date(s.finishedAt).getTime() : Date.now()) - new Date(s.startedAt).getTime() : null)}
                  </span>
                  <Icon name="chevron-down" size={14} className={open ? 'rot' : ''} />
                </button>
                {open ? (
                  <div className="step-logs">
                    {lines.length === 0 ? <div className="muted small">ログはありません</div> : null}
                    {lines.map((l) => (
                      <div key={l.id} className={`log-line k-${l.kind}`}>
                        <span className="log-time">{new Date(l.ts).toLocaleTimeString('ja-JP', { hour12: false })}</span>
                        <span className="log-kind">{l.kind === 'tool' ? '⚙' : l.kind === 'policy' ? '⛔' : l.kind === 'error' ? '!' : '›'}</span>
                        <span className="log-msg">{l.message}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {tab === 'artifacts' ? (
        <div className="artifact-grid">
          {d.artifacts.map((a) => (
            <button key={a.id} className="artifact-card" onClick={() => setArtifactId(a.id)}>
              <Icon name={artifactIcon(a.kind)} size={20} />
              <span className="ac-title">{a.title}</span>
              <span className="muted small">
                {a.mediaType} · {(a.sizeBytes / 1024).toFixed(1)} KB
              </span>
              <span className="faint small">{relTime(a.createdAt)}</span>
            </button>
          ))}
          {d.artifacts.length === 0 ? <div className="empty">成果物はまだありません</div> : null}
        </div>
      ) : null}

      {tab === 'events' ? (
        <ol className="events">
          {d.events.map((e) => (
            <li key={e.id}>
              <span className="mono faint">#{e.sequence}</span>
              <span className="ev-type mono">{e.type}</span>
              <span className="ev-data">{summarizeEvent(e.type, e.data)}</span>
              <span className="muted small">{new Date(e.occurredAt).toLocaleTimeString('ja-JP', { hour12: false })}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {artifactId ? (
        <Modal title={d.artifacts.find((a) => a.id === artifactId)?.title ?? '成果物'} onClose={() => setArtifactId(null)} wide>
          <ArtifactBody artifactId={artifactId} />
        </Modal>
      ) : null}
    </div>
  );
}

function summarizeEvent(type: string, data: Record<string, any>): string {
  switch (type) {
    case 'run.status_changed':
      return `${data.from} → ${data.to}`;
    case 'step.started':
      return `${data.key}（${data.role}）試行 ${data.attempt}`;
    case 'step.finished':
      return `${data.key}: ${data.status}${data.errorCode ? ` ${data.errorCode}` : ''}`;
    case 'artifact.created':
      return data.title;
    case 'approval.requested':
    case 'approval.resolved':
      return `${data.actionType ?? ''} ${data.status ?? ''} ${data.title ?? ''}`.trim();
    case 'policy.denied':
      return `${data.tool} — ${data.reason}`;
    case 'webhook.received':
    case 'webhook.ignored':
      return `${data.event} ${data.reason}`;
    default:
      return '';
  }
}
