/**
 * Projects（UI-06）: Project 作成・編集・アーカイブ、Repo 接続、自動起動ルール、GitHub シミュレーター。
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type GithubInstallationsDto, type ProjectDto } from '../../shared/api/client';
import { useAuthConfig } from '../../shared/api/authConfig';
import { Icon } from '../../shared/ui/Icon';
import { toast } from '../../shared/ui/toast';
import { isClaudeRuntime, runtimeLabel } from '../../shared/runtime';

const COLORS = ['#5eead4', '#fb7185', '#a78bfa', '#fbbf24', '#60a5fa', '#34d399', '#f472b6', '#fb923c'];

function errMsg(e: unknown) {
  return e instanceof ApiError ? e.message : String(e);
}

export function ProjectsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['projects', 'all'], queryFn: () => api.get<{ items: ProjectDto[] }>('/v1/projects?includeArchived=1') });
  const gh = useQuery({ queryKey: ['github-installations'], queryFn: () => api.get<GithubInstallationsDto>('/v1/integrations/github/installations') });
  const [creating, setCreating] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['projects'] });
    void qc.invalidateQueries({ queryKey: ['github-installations'] });
  };
  const githubApp = gh.data?.mode === 'github_app';
  const candidates = githubApp ? (gh.data?.installations ?? []).flatMap((i) => i.repositories.filter((r) => !r.projectId).map((r) => r.fullName)) : [];
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
      {githubApp ? (
        <section className="card gh-banner">
          <Icon name="git-pr" size={15} />
          <div>
            <strong>GitHub App 連携</strong>
            <p className="small muted">
              {gh.data?.error
                ? `GitHub に接続できません: ${gh.data.error}`
                : `インストール先: ${(gh.data?.installations ?? []).map((i) => i.account).join(', ') || 'なし'} · 起動・レビューを受け付ける GitHub ユーザー: ${gh.data?.allowedUsers?.join(', ') || '未設定（Issue からは起動しません）'}`}
            </p>
          </div>
        </section>
      ) : null}
      {creating ? <CreateProject githubApp={githubApp} onDone={() => { setCreating(false); refresh(); }} /> : null}
      <datalist id="github-repo-candidates">
        {candidates.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="project-cards">
        {active.map((p) => (
          <ProjectCard key={p.id} project={p} githubApp={githubApp} onChange={refresh} />
        ))}
      </div>
      {archived.length ? (
        <>
          <div className="section-title">アーカイブ済み</div>
          <div className="project-cards">
            {archived.map((p) => (
              <ProjectCard key={p.id} project={p} githubApp={githubApp} onChange={refresh} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function CreateProject({ onDone, githubApp }: { onDone(): void; githubApp: boolean }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const p = await api.post<ProjectDto>('/v1/projects', { name, description, color });
      if (repo.trim()) {
        try {
          await api.post(`/v1/projects/${p.id}/repositories`, { fullName: repo.trim() });
        } catch (e) {
          // Project はできているので、Repo だけ後から接続し直せるようにする
          toast({ tone: 'error', title: 'Project は作成しましたが、Repo を接続できませんでした', body: errMsg(e) });
          onDone();
          return;
        }
      }
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
          {githubApp ? 'Repo（owner/repo・GitHub App をインストールしたリポジトリ）' : 'Repo（owner/repo・ローカル GitHub シミュレーター）'}
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="me/my-app"
            className="mono"
            list={githubApp ? 'github-repo-candidates' : undefined}
          />
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

function ProjectCard({ project: p, githubApp, onChange }: { project: ProjectDto; githubApp: boolean; onChange(): void }) {
  const [repo, setRepo] = useState('');
  const [label, setLabel] = useState(p.repository?.policy.triggerLabel ?? 'ai:ready');
  const [maxRev, setMaxRev] = useState(p.repository?.policy.maxRevisionAttempts ?? 3);
  const [sim, setSim] = useState(false);
  const [localPath, setLocalPath] = useState(p.repository?.localPath ?? '');
  const [testCommand, setTestCommand] = useState(p.repository?.testCommand ?? '');
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
            {p.repository.verification === 'github_app' ? (
              <a className="mono" href={`https://github.com/${p.repository.fullName}`} target="_blank" rel="noreferrer">
                {p.repository.fullName}
              </a>
            ) : (
              <span className="mono">{p.repository.fullName}</span>
            )}
            <span className="faint small mono">
              {p.repository.verification === 'github_app' ? 'GitHub App' : 'シミュレーター'} · installation {p.repository.installationId} · repo {p.repository.repositoryId}
              {p.repository.defaultBranch ? ` · 既定ブランチ ${p.repository.defaultBranch}` : ''}
            </span>
            <button className="btn ghost small" onClick={() => void act(() => api.del(`/v1/projects/${p.id}/repositories`), '接続を解除しました')}>
              接続解除
            </button>
          </div>
        ) : (
          <div className="pa-repo">
            <input
              className="mono"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder={githubApp ? 'owner/repo（GitHub App をインストールしたリポジトリ）' : 'owner/repo'}
              aria-label="Repo"
              list={githubApp ? 'github-repo-candidates' : undefined}
            />
            <button className="btn small" disabled={!repo.trim()} onClick={() => void act(() => api.post(`/v1/projects/${p.id}/repositories`, { fullName: repo.trim() }), 'Repo を接続しました（自動起動は OFF）')}>
              接続
            </button>
          </div>
        )}
      </div>

      {p.repository?.managedCheckout ? (
        <div className="pa-section">
          <h4>
            <Icon name="sparkles" size={14} /> Claude の作業場所
            <span className={`runtime-pill ${p.repository.runtime ?? 'simulated'}`}>{isClaudeRuntime(p.repository.runtime) ? `${runtimeLabel(p.repository.runtime)} で実行` : 'シミュレーション'}</span>
          </h4>
          <p className="small">
            サーバーが GitHub から取得した作業コピーを使います（起点: <span className="mono">{p.repository.defaultBranch ?? '既定ブランチ'}</span>）。結果は <span className="mono">ai/run-…</span> ブランチとして GitHub に push し、Draft PR を作ります。
          </p>
          <div className="form-grid">
            <label className="span-2">
              テストコマンド（任意・&& で連結可、シェル記号は不可）
              <input className="mono" value={testCommand} onChange={(e) => setTestCommand(e.target.value)} placeholder="pnpm install --frozen-lockfile && pnpm test" />
            </label>
          </div>
          <div className="form-actions">
            <button
              className="btn small primary"
              onClick={() => void act(() => api.put(`/v1/projects/${p.id}/local-repo`, { localPath: null, testCommand: testCommand.trim() || null }), 'テストコマンドを保存しました')}
            >
              保存
            </button>
          </div>
          <p className="hint">テストコマンドはサーバー上で実行されます。必要なツール（Node.js・pnpm など）をサーバーに入れておいてください。マージは人が GitHub で行います（AI はマージしません）。</p>
        </div>
      ) : p.repository ? (
        <div className="pa-section">
          <h4>
            <Icon name="sparkles" size={14} /> Claude が作業するローカルリポジトリ
            <span className={`runtime-pill ${p.repository.runtime ?? 'simulated'}`}>{isClaudeRuntime(p.repository.runtime) ? `${runtimeLabel(p.repository.runtime)} で実行` : 'シミュレーション'}</span>
          </h4>
          <div className="form-grid">
            <label className="span-2">
              git リポジトリの絶対パス
              <input className="mono" value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder="/Users/you/src/my-app" />
            </label>
            <label className="span-2">
              テストコマンド（任意・&& で連結可、シェル記号は不可）
              <input className="mono" value={testCommand} onChange={(e) => setTestCommand(e.target.value)} placeholder="pnpm install --frozen-lockfile && pnpm test" />
            </label>
          </div>
          <div className="form-actions">
            {p.repository.localPath ? (
              <button className="btn ghost small" onClick={() => void act(() => api.put(`/v1/projects/${p.id}/local-repo`, { localPath: null, testCommand: null }), 'ローカルリポジトリの設定を解除しました')}>
                解除
              </button>
            ) : null}
            <button
              className="btn small primary"
              disabled={!localPath.trim()}
              onClick={() => void act(() => api.put(`/v1/projects/${p.id}/local-repo`, { localPath: localPath.trim(), testCommand: testCommand.trim() || null }), 'ローカルリポジトリを設定しました')}
            >
              保存
            </button>
          </div>
          <p className="hint">
            Run ごとに <span className="mono">ai/run-…</span> ブランチの worktree を作り、Claude はその中のファイルだけを読み書きします（.git・CI 設定・秘密ファイルは不可、シェル実行不可）。テストコマンドはあなたのマシンで実行されるため、信頼できるリポジトリにだけ設定してください。マージは人が行います。
          </p>
        </div>
      ) : null}

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
          {/* 本物の GitHub につないだ Repo では、偽の Issue で Run が始まらないようシミュレーターを出さない */}
          {devRoutes && !p.repository.managedCheckout ? (
            <button className="btn ghost small" onClick={() => setSim((v) => !v)}>
              <Icon name="send" size={13} /> GitHub シミュレーターで Issue を送る
            </button>
          ) : null}
          {sim && devRoutes && !p.repository.managedCheckout ? <IssueSimulator project={p} /> : null}
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
