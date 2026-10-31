/**
 * Projects（UI-06）: Project 作成・編集・アーカイブ、Repo 接続、自動起動ルール、GitHub シミュレーター。
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type ProjectDto } from '../../shared/api/client';
import { useAuthConfig } from '../../shared/api/authConfig';
import { Icon } from '../../shared/ui/Icon';
import { toast } from '../../shared/ui/toast';

const COLORS = ['#5eead4', '#fb7185', '#a78bfa', '#fbbf24', '#60a5fa', '#34d399', '#f472b6', '#fb923c'];

function errMsg(e: unknown) {
  return e instanceof ApiError ? e.message : String(e);
}

export function ProjectsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['projects', 'all'], queryFn: () => api.get<{ items: ProjectDto[] }>('/v1/projects?includeArchived=1') });
  const [creating, setCreating] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['projects'] });
  const items = q.data?.items ?? [];
  const active = items.filter((p) => p.status === 'active');
  const archived = items.filter((p) => p.status === 'archived');

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="muted">案件ごとに Repo・自動起動ルール・成果物を分けます。自動起動は Repo 単位で明示的に ON にしたときだけ動きます。</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> 新しい Project
        </button>
      </header>
      {creating ? <CreateProject onDone={() => { setCreating(false); void refresh(); }} /> : null}
      <div className="project-cards">
        {active.map((p) => (
          <ProjectCard key={p.id} project={p} onChange={() => void refresh()} />
        ))}
      </div>
      {archived.length ? (
        <>
          <div className="section-title">アーカイブ済み</div>
          <div className="project-cards">
            {archived.map((p) => (
              <ProjectCard key={p.id} project={p} onChange={() => void refresh()} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function CreateProject({ onDone }: { onDone(): void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const p = await api.post<ProjectDto>('/v1/projects', { name, description, color });
      if (repo.trim()) await api.post(`/v1/projects/${p.id}/repositories`, { fullName: repo.trim() });
      toast({ tone: 'success', title: 'Project を作成しました', body: p.name });
      onDone();
    } catch (e) {
      toast({ tone: 'error', title: '作成できませんでした', body: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card form-card">
      <h3 className="card-title">新しい Project</h3>
      <div className="form-grid">
        <label>
          名前
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        <label>
          Repo（owner/repo・ローカル GitHub シミュレーター）
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="me/my-app" className="mono" />
        </label>
        <label className="span-2">
          説明
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </label>
        <div className="span-2 color-row">
          {COLORS.map((c) => (
            <button key={c} type="button" className={`swatch${c === color ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`色 ${c}`} />
          ))}
        </div>
      </div>
      <div className="form-actions">
        <button className="btn" onClick={onDone}>
          キャンセル
        </button>
        <button className="btn primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
          作成
        </button>
      </div>
    </section>
  );
}

function ProjectCard({ project: p, onChange }: { project: ProjectDto; onChange(): void }) {
  const [repo, setRepo] = useState('');
  const [label, setLabel] = useState(p.repository?.policy.triggerLabel ?? 'ai:ready');
  const [maxRev, setMaxRev] = useState(p.repository?.policy.maxRevisionAttempts ?? 3);
  const [sim, setSim] = useState(false);
  const devRoutes = useAuthConfig().data?.devRoutes ?? false;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ tone: 'success', title: ok });
      onChange();
    } catch (e) {
      toast({ tone: 'error', title: '操作できませんでした', body: errMsg(e) });
    }
  };
  const setPolicy = (enabled: boolean) =>
    act(
      () =>
        api.put(`/v1/projects/${p.id}/automation-policy`, {
          enabled,
          triggerLabel: label.trim() || 'ai:ready',
          events: ['issues.opened', 'issues.labeled'],
          maxRevisionAttempts: Number(maxRev),
        }),
      enabled ? '自動起動を ON にしました' : '自動起動ルールを保存しました',
    );

  return (
    <section className={`card project-admin${p.status === 'archived' ? ' archived' : ''}`} style={{ ['--pc' as string]: p.color }}>
      <header className="pa-head">
        <span className="pr-dot" />
        <h3>{p.name}</h3>
        <span className="mono faint small">{p.id}</span>
        <div className="spacer" />
        {p.status === 'active' ? (
          <button className="btn ghost small" onClick={() => void act(() => api.patch(`/v1/projects/${p.id}`, { status: 'archived' }), 'アーカイブしました')}>
            アーカイブ
          </button>
        ) : (
          <button className="btn ghost small" onClick={() => void act(() => api.patch(`/v1/projects/${p.id}`, { status: 'active' }), '復元しました')}>
            復元
          </button>
        )}
      </header>
      <p className="muted small">{p.description || '説明なし'}</p>
      <div className="pa-agents">
        {p.agentConfig.roles.map((r) => (
          <span key={r} className="chip static">
            {r}
          </span>
        ))}
        <span className="muted small">workflow: {p.agentConfig.workflow}</span>
      </div>

      <div className="pa-section">
        <h4>
          <Icon name="branch" size={14} /> Repo
        </h4>
        {p.repository ? (
          <div className="pa-repo">
            <span className="mono">{p.repository.fullName}</span>
            <span className="faint small mono">
              installation {p.repository.installationId} · repo {p.repository.repositoryId} · {p.repository.verification}
            </span>
            <button className="btn ghost small" onClick={() => void act(() => api.del(`/v1/projects/${p.id}/repositories`), '接続を解除しました')}>
              接続解除
            </button>
          </div>
        ) : (
          <div className="pa-repo">
            <input className="mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" aria-label="Repo" />
            <button className="btn small" disabled={!repo.trim()} onClick={() => void act(() => api.post(`/v1/projects/${p.id}/repositories`, { fullName: repo.trim() }), 'Repo を接続しました（自動起動は OFF）')}>
              接続
            </button>
          </div>
        )}
      </div>

      {p.repository ? (
        <div className="pa-section">
          <h4>
            <Icon name="webhook" size={14} /> 自動起動ルール
          </h4>
          <div className="policy-row">
            <span className={`auto-badge${p.repository.automationEnabled ? ' on' : ''}`}>{p.repository.automationEnabled ? 'ON' : 'OFF'}</span>
            <label>
              トリガーラベル
              <input className="mono" value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label>
              再修正上限
              <select value={maxRev} onChange={(e) => setMaxRev(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} 回
                  </option>
                ))}
              </select>
            </label>
            <button className="btn small" onClick={() => void setPolicy(p.repository!.automationEnabled)}>
              保存
            </button>
            <button className={`btn small ${p.repository.automationEnabled ? 'danger' : 'primary'}`} onClick={() => void setPolicy(!p.repository!.automationEnabled)}>
              {p.repository.automationEnabled ? '自動起動を OFF' : '自動起動を ON'}
            </button>
          </div>
          <p className="hint">対象: issues.opened / issues.labeled のうち、ラベル「{p.repository.policy.triggerLabel}」が付いた Issue のみ。条件不一致は記録だけ残し、Run は作りません。</p>
          {devRoutes ? (
            <button className="btn ghost small" onClick={() => setSim((v) => !v)}>
              <Icon name="send" size={13} /> GitHub シミュレーターで Issue を送る
            </button>
          ) : null}
          {sim && devRoutes ? <IssueSimulator project={p} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function IssueSimulator({ project }: { project: ProjectDto }) {
  const [title, setTitle] = useState('注文履歴を CSV でエクスポートできるようにする');
  const [body, setBody] = useState('管理画面から CSV をダウンロードしたい。Excel で文字化けしないように。');
  const [labels, setLabels] = useState(project.repository?.policy.triggerLabel ?? 'ai:ready');
  const [last, setLast] = useState<{ deliveryId: string; status: number; body: { status: string; code?: string } } | null>(null);
  const send = async () => {
    try {
      const r = await api.post<{ deliveryId: string; status: number; body: { status: string; code?: string } }>('/v1/dev/github/simulate', {
        kind: 'issue',
        projectId: project.id,
        action: 'opened',
        title,
        body,
        labels: labels.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setLast(r);
      toast({ tone: 'info', title: `Webhook ${r.status} ${r.body.status}`, body: '自動起動ルールに合致すれば Run が作成されます' });
    } catch (e) {
      toast({ tone: 'error', title: '送信できませんでした', body: errMsg(e) });
    }
  };
  const redeliver = async () => {
    if (!last) return;
    try {
      const r = await api.post<{ deliveryId: string; status: number; body: { status: string } }>('/v1/dev/github/simulate', { kind: 'redeliver', deliveryId: last.deliveryId });
      setLast({ ...r });
      toast({ tone: 'info', title: `再送: ${r.status} ${r.body.status}`, body: '同じ Delivery ID は二重に処理されません' });
    } catch (e) {
      toast({ tone: 'error', title: '再送できませんでした', body: errMsg(e) });
    }
  };
  return (
    <div className="simulator">
      <label>
        Issue タイトル
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        本文（非信頼入力として扱われます）
        <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label>
        ラベル（カンマ区切り）
        <input className="mono" value={labels} onChange={(e) => setLabels(e.target.value)} />
      </label>
      <div className="form-actions">
        {last ? (
          <span className="mono small faint">
            delivery {last.deliveryId.slice(0, 8)}… → {last.status} {last.body.status}
          </span>
        ) : null}
        {last ? (
          <button className="btn small" onClick={() => void redeliver()}>
            同じ Delivery を再送
          </button>
        ) : null}
        <button className="btn primary small" onClick={() => void send()}>
          <Icon name="send" size={13} /> 署名付き Webhook を送信
        </button>
      </div>
    </div>
  );
}
