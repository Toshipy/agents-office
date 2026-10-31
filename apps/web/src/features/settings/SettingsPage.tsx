/**
 * Usage / Settings（UI-07）: 予算・同時実行数・キルスイッチ・利用量・監査ログ。
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, type AgentDto, type Me, type RuntimeInfo } from '../../shared/api/client';
import { Icon } from '../../shared/ui/Icon';
import { AgentStatusPill } from '../../shared/ui/status';
import { relTime, usd, fmtNum } from '../../shared/ui/format';
import { toast } from '../../shared/ui/toast';
import { LookSwitch, useMe } from '../../app/App';
import { LOOKS, useLook } from '../../shared/look';
import { useOffice } from '../../shared/state/office';
import { isClaudeRuntime, runtimeLabel } from '../../shared/runtime';

interface Usage {
  measurement: string;
  note: string;
  pricePerMTok: { input: number; output: number };
  month: { costUsd: number; inputTokens: number; outputTokens: number; budgetUsd: number };
  limits: { runBudgetUsd: number; maxConcurrentRuns: number; activeRuns: number; paused: boolean };
  daily: { day: string; costUsd: number; runs: number }[];
  byProject: { projectId: string; name: string; costUsd: number; runs: number }[];
}

export function SettingsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api.get<Usage>('/v1/usage'), refetchInterval: 10_000 });
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => api.get<{ items: { id: string; action: string; targetType: string; targetId: string | null; detail: Record<string, unknown>; createdAt: string }[] }>('/v1/audit-logs') });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.get<{ agents: AgentDto[] }>('/v1/agents'), refetchInterval: 5000 });
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: () => api.get<RuntimeInfo>('/v1/runtime') });
  const lookId = useLook((s) => s.id);
  const settings = me.data?.workspace.settings;
  const [form, setForm] = useState({ monthlyBudgetUsd: 50, runBudgetUsd: 2, maxConcurrentRuns: 2, demoTraffic: false });
  useEffect(() => {
    if (settings) setForm({ monthlyBudgetUsd: settings.monthlyBudgetUsd, runBudgetUsd: settings.runBudgetUsd, maxConcurrentRuns: settings.maxConcurrentRuns, demoTraffic: settings.demoTraffic });
  }, [settings?.monthlyBudgetUsd, settings?.runBudgetUsd, settings?.maxConcurrentRuns, settings?.demoTraffic]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    try {
      await api.patch<Me['workspace']>('/v1/workspaces/me/settings', form);
      toast({ tone: 'success', title: '設定を保存しました' });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    } catch (e) {
      toast({ tone: 'error', title: '保存できませんでした', body: e instanceof ApiError ? e.message : String(e) });
    }
  };
  const kill = async (action: 'pause' | 'resume', cancelActive = false) => {
    if (action === 'pause' && cancelActive && !window.confirm('実行中・待機中の Run をすべて中止し、新規開始を停止します。よろしいですか？')) return;
    try {
      const r = await api.post<{ cancelled?: number }>('/v1/workspaces/me/kill-switch', { action, cancelActive });
      toast({ tone: action === 'pause' ? 'warn' : 'success', title: action === 'pause' ? `停止しました${cancelActive ? `（${r.cancelled ?? 0} 件中止）` : ''}` : '再開しました' });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    } catch (e) {
      toast({ tone: 'error', title: '操作できませんでした', body: e instanceof ApiError ? e.message : String(e) });
    }
  };
  const paused = useOffice((s) => s.snapshot?.workspace.settings.paused) ?? settings?.paused ?? false;
  const u = usage.data;
  const maxDay = Math.max(0.0001, ...(u?.daily.map((d) => d.costUsd) ?? [0]));

  return (
    <div className="page settings">
      <header className="page-head">
        <div>
          <h1>設定・利用量</h1>
          <p className="muted">{me.data?.workspace.name} — 個人ワークスペース（他のユーザーには見えません）</p>
        </div>
      </header>

      <div className="detail-grid">
        <section className={`card kill${paused ? ' paused' : ''}`}>
          <h3 className="card-title">
            <Icon name="power" size={15} /> キルスイッチ
          </h3>
          <p className="small muted">暴走や想定外の費用を止めるため、新規 Run の開始と自動起動を一括で停止します。</p>
          <div className="kill-state">
            {paused ? (
              <span className="paused-badge big">
                <Icon name="pause" size={14} /> 停止中
              </span>
            ) : (
              <span className="ok-badge">
                <Icon name="play" size={14} /> 稼働中
              </span>
            )}
          </div>
          <div className="form-actions">
            {paused ? (
              <button className="btn primary" onClick={() => void kill('resume')}>
                再開
              </button>
            ) : (
              <>
                <button className="btn" onClick={() => void kill('pause')}>
                  新規開始を停止
                </button>
                <button className="btn danger" onClick={() => void kill('pause', true)}>
                  緊急停止（実行中も中止）
                </button>
              </>
            )}
          </div>
        </section>

        <section className="card">
          <h3 className="card-title">
            <Icon name="settings" size={15} /> 実行上限
          </h3>
          <div className="form-grid">
            <label>
              月間予算（USD）
              <input type="number" min={1} max={1000} value={form.monthlyBudgetUsd} onChange={(e) => setForm({ ...form, monthlyBudgetUsd: Number(e.target.value) })} />
            </label>
            <label>
              Run あたり予算（USD）
              <input type="number" min={0.1} max={50} step={0.1} value={form.runBudgetUsd} onChange={(e) => setForm({ ...form, runBudgetUsd: Number(e.target.value) })} />
            </label>
            <label>
              同時実行数
              <select value={form.maxConcurrentRuns} onChange={(e) => setForm({ ...form, maxConcurrentRuns: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={form.demoTraffic} onChange={(e) => setForm({ ...form, demoTraffic: e.target.checked })} />
              デモ用 GitHub イベントを自動生成（ローカル専用）
            </label>
          </div>
          <div className="form-actions">
            <button className="btn primary" onClick={() => void save()}>
              保存
            </button>
          </div>
        </section>

        <section className="card">
          <h3 className="card-title">
            <Icon name="dollar" size={15} /> 今月の利用量（推定）
          </h3>
          {u ? (
            <>
              <div className="usage-big mono">
                {usd(u.month.costUsd)} <span className="muted">/ {usd(u.month.budgetUsd, 0)}</span>
              </div>
              <div className="spark" aria-label="日別の推定費用">
                {u.daily.map((d) => (
                  <span key={d.day} title={`${d.day}: ${usd(d.costUsd)}（${d.runs} runs）`} style={{ height: `${Math.max(4, (d.costUsd / maxDay) * 100)}%` }} />
                ))}
              </div>
              <dl className="kv cols">
                <div>
                  <dt>入力トークン</dt>
                  <dd className="mono">{fmtNum(u.month.inputTokens)}</dd>
                </div>
                <div>
                  <dt>出力トークン</dt>
                  <dd className="mono">{fmtNum(u.month.outputTokens)}</dd>
                </div>
                <div>
                  <dt>実行中</dt>
                  <dd>
                    {u.limits.activeRuns} / {u.limits.maxConcurrentRuns}
                  </dd>
                </div>
                <div>
                  <dt>単価（推定）</dt>
                  <dd className="mono small">
                    ${u.pricePerMTok.input} / ${u.pricePerMTok.output} per 1M
                  </dd>
                </div>
              </dl>
              <p className="hint">{u.note}</p>
            </>
          ) : (
            <span className="muted">読み込み中…</span>
          )}
        </section>
      </div>

      <div className="detail-grid">
        <section className={`card runtime-card${isClaudeRuntime(runtime.data?.runtime) ? ' on' : ''}`}>
          <h3 className="card-title">
            <Icon name="sparkles" size={15} /> AI 実行基盤
          </h3>
          {runtime.data ? (
            <>
              <div className="runtime-state">
                <span className={`runtime-pill ${runtime.data.runtime}`}>{runtimeLabel(runtime.data.runtime)}</span>
                {runtime.data.runtime === 'claude' ? <span className="mono small">{runtime.data.model} · effort {runtime.data.effort}</span> : null}
                {runtime.data.runtime === 'claude_code' ? (
                  <span className="mono small">
                    v{runtime.data.claudeCode.version ?? '?'} · {runtime.data.model ?? 'CLI の既定モデル'}
                  </span>
                ) : null}
              </div>
              <p className="small muted">{runtime.data.reason}</p>
              <p className="small">{runtime.data.note}</p>
              {runtime.data.runtime === 'claude_code' ? (
                <dl className="kv cols runtime-kv">
                  <div>
                    <dt>ログイン</dt>
                    <dd>{runtime.data.claudeCode.authLabel ?? '未確認'}</dd>
                  </div>
                  <div>
                    <dt>課金</dt>
                    <dd>{runtime.data.billing === 'subscription' ? 'サブスクの利用枠（API 課金なし）' : 'API 課金'}</dd>
                  </div>
                  <div>
                    <dt>制限モード</dt>
                    <dd>{runtime.data.claudeCode.restricted ? '有効（--restricted）' : '無効'}</dd>
                  </div>
                  <div>
                    <dt>工程の上限</dt>
                    <dd className="mono">
                      {runtime.data.claudeCode.maxTurns.develop} ターン / {Math.round(runtime.data.stepTimeoutMs / 60000)} 分
                    </dd>
                  </div>
                </dl>
              ) : null}
              {runtime.data.claudeCode.problem && runtime.data.runtime !== 'claude_code' && runtime.data.mode === 'auto' ? (
                <p className="hint warn">Claude Code（サブスク）を使えない理由: {runtime.data.claudeCode.problem}</p>
              ) : null}
              {runtime.data.claudeCode.problem && runtime.data.runtime === 'claude_code' ? <p className="hint warn">{runtime.data.claudeCode.problem}</p> : null}
              {runtime.data.runtime === 'claude' ? (
                <p className="hint">拒否（refusal）時は Anthropic のサーバー側フォールバック（default）で別モデルに切り替わります。費用は API が返したトークン数（実測）から計算します。</p>
              ) : runtime.data.runtime === 'claude_code' ? (
                <p className="hint">Claude Code はシェルを使えない制限モードで動き、ファイル操作は Run 専用の作業コピーに限られます。サブスクの利用上限に達すると Run は一時停止し、「承認・判断」から続行できます。</p>
              ) : (
                <p className="hint">この PC で Claude Code に claude.ai アカウントでログイン（`claude auth login`）して API を再起動すると、サブスクで動きます。Projects でローカルリポジトリの指定も必要です。</p>
              )}
            </>
          ) : (
            <span className="muted">読み込み中…</span>
          )}
        </section>
        <section className="card">
          <h3 className="card-title">
            <Icon name="cube" size={15} /> 見た目
          </h3>
          <p className="small muted">採用案は B（Neon Control）です。比較用に A / C にも切り替えられます（このブラウザにだけ保存）。</p>
          <LookSwitch />
          <p className="hint">{LOOKS[lookId].tagline}</p>
        </section>
      </div>

      <section className="card">
        <h3 className="card-title">
          <Icon name="bot" size={15} /> Agent 定義
        </h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>状態（全 Project 集約）</th>
                <th>実行基盤</th>
                <th>プロンプト版</th>
                <th>許可ツール</th>
              </tr>
            </thead>
            <tbody>
              {agents.data?.agents.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.name}</strong> <span className="muted">{a.role}</span> <span className="mono faint">v{a.version}</span>
                  </td>
                  <td>
                    <AgentStatusPill status={a.status} small /> <span className="muted small">{a.activeRunIds.length} runs</span>
                  </td>
                  <td className="small">{a.runtime}</td>
                  <td className="mono small">{a.promptVersion}</td>
                  <td className="small">
                    {a.toolPolicy.map((t) => (
                      <span key={t} className="chip static mono">
                        {t}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3 className="card-title">
          <Icon name="shield" size={15} /> 監査ログ（人の操作）
        </h3>
        <ol className="events">
          {audit.data?.items.map((a) => (
            <li key={a.id}>
              <span className="ev-type mono">{a.action}</span>
              <span className="ev-data mono faint">
                {a.targetType}
                {a.targetId ? `:${a.targetId}` : ''}
              </span>
              <span className="muted small">{relTime(a.createdAt)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
