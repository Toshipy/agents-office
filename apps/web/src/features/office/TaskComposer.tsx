/**
 * 手動タスクの登録（UC-02 / 基本設計書 4.1: POST /v1/runs → 202 Accepted）。
 */
import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, api, newIdempotencyKey } from '../../shared/api/client';
import { useOffice } from '../../shared/state/office';
import { Icon } from '../../shared/ui/Icon';
import { toast } from '../../shared/ui/toast';

const SUGGESTIONS = ['テストを追加して', 'エラーメッセージを改善して', 'README のセットアップ手順を更新して'];

export function TaskComposer({ projectId, compact, placeholder }: { projectId?: string | null; compact?: boolean; placeholder?: string }) {
  const projects = useOffice((s) => s.snapshot?.projects ?? []);
  const focused = useOffice((s) => s.focusedProjectId);
  const [chosen, setChosen] = useState<string | null>(null);
  const target = projectId ?? chosen ?? focused ?? projects.find((p) => p.repo)?.id ?? null;
  const project = useMemo(() => projects.find((p) => p.id === target) ?? null, [projects, target]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const idem = useRef(newIdempotencyKey());
  const qc = useQueryClient();

  const submit = async () => {
    const request = text.trim();
    if (!project || request.length < 4 || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ runId: string; status: string }>('/v1/runs', { projectId: project.id, request }, { 'idempotency-key': idem.current });
      toast({ tone: 'success', title: 'タスクを受け付けました', body: `${project.name} — 待機中（${r.runId}）`, href: `/runs/${r.runId}` });
      setText('');
      idem.current = newIdempotencyKey();
      void qc.invalidateQueries({ queryKey: ['runs'] });
    } catch (e) {
      toast({ tone: 'error', title: '依頼できませんでした', body: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const disabledReason = !project ? 'Project がありません' : !project.repo ? 'Repo 未接続の Project には依頼できません' : null;
  const runtimeHint = project?.repo?.claudeReady
    ? 'Claude がローカルリポジトリの専用ブランチで作業します（計画 → 実装 → テスト → レビュー → 人の承認 → PR）。マージは人が行います。'
    : 'この Project はシミュレーションで実行されます。Projects でローカルリポジトリを設定すると Claude が作業します。';

  return (
    <div className={`composer${compact ? ' compact' : ''}`}>
      {!projectId ? (
        <div className="composer-row">
          <label className="sr-only" htmlFor="composer-project">
            対象 Project
          </label>
          <select id="composer-project" value={target ?? ''} onChange={(e) => setChosen(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.repo ? '' : '（Repo 未接続）'}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {compact ? (
        <div className="chips">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => setText(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : null}
      <div className="composer-input">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder ?? 'タスクを依頼（例: ログイン画面にパスワード表示切替を追加して）'}
          rows={compact ? 2 : 3}
          maxLength={4000}
          aria-label="依頼内容"
          disabled={Boolean(disabledReason)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
        <button className="btn primary send" onClick={() => void submit()} disabled={busy || text.trim().length < 4 || Boolean(disabledReason)} aria-label="依頼する">
          <Icon name="send" size={15} />
          <span>{busy ? '送信中' : '依頼'}</span>
        </button>
      </div>
      {disabledReason ? <p className="hint warn">{disabledReason}</p> : <p className="hint">{runtimeHint}</p>}
    </div>
  );
}
