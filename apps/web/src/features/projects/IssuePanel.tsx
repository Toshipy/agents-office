/**
 * 案件ごとの Issue 一覧（GitHub App で接続した Project だけ）。
 * 「候補」「資料済み」「実行中」の 3 欄に分け、候補と資料済みは「AI に任せる」で Run を始める。
 * 前の Run の PR がまだ開いている Issue も「実行中」に出す（見送り理由 open_pr を行に出す）。
 * ラベル付け・自分のアサインはサーバーが行う。ここでは見送り理由を日本語で行に出すだけ。
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, delegateIssue, listIssues, type IssueRowDto } from '../../shared/api/client';
import { Icon } from '../../shared/ui/Icon';
import { toast } from '../../shared/ui/toast';

/** delegate が返す見送り理由（skipped の値）を日本語にする */
const SKIP_TEXT: Record<string, string> = {
  assigned_to_other: '他の人が担当しているため任せられません',
  assigned_concurrently: '同時に他の人が担当になったため見送りました',
  assign_failed: '自分のアサインに失敗したため見送りました',
  nightly: '夜間の自動処理に回す Issue のため任せられません',
  duplicate_issue_run: 'この Issue は既に実行中です',
  open_pr: '前の Run の PR がまだ開いています（マージか close の後に任せられます）',
  not_an_issue: 'Issue ではなく PR のため任せられません',
  issue_closed: '閉じられた Issue のため任せられません',
  github_unavailable: 'GitHub に接続できないため見送りました',
  runtime_unavailable: 'Claude で実行できない（シミュレーションになる）ため見送りました',
  labeled_by_other: '他の人が付けたラベルのため見送りました',
};

const skipText = (reason: string) => SKIP_TEXT[reason] ?? `見送りました（${reason}）`;

function IssueRow({ projectId, issue, onStarted }: { projectId: string; issue: IssueRowDto; onStarted(): void }) {
  const [open, setOpen] = useState(false);
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false);
  const [skip, setSkip] = useState<string | null>(issue.skipReason ? skipText(issue.skipReason) : null);

  const delegate = async () => {
    setBusy(true);
    setSkip(null);
    try {
      await delegateIssue(projectId, issue.number, guidance);
      toast({ tone: 'success', title: `#${issue.number} を AI に任せました` });
      setGuidance('');
      setOpen(false);
      onStarted();
    } catch (e) {
      const reason = e instanceof ApiError && e.code === 'ISSUE_SKIPPED' ? (e.details as { reason?: string } | undefined)?.reason : undefined;
      if (reason) setSkip(skipText(reason));
      else toast({ tone: 'error', title: '任せられませんでした', body: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="issue-row">
      <div className="issue-main">
        <a href={issue.htmlUrl} target="_blank" rel="noreferrer" className="issue-title">
          <span className="mono faint">#{issue.number}</span> {issue.title}
        </a>
        <span className="issue-labels">
          {issue.labels.map((l) => (
            <span key={l} className="chip static">
              {l}
            </span>
          ))}
        </span>
        {issue.runId ? (
          <Link className="btn ghost small" to={`/runs/${issue.runId}`}>
            Run を開く
          </Link>
        ) : (
          <button className="btn small" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            <Icon name="sparkles" size={13} /> AI に任せる
          </button>
        )}
      </div>
      {skip ? <p className="hint warn issue-skip">{skip}</p> : null}
      {open && !issue.runId ? (
        <div className="issue-delegate">
          <label>
            追加の指示（任意）
            <textarea rows={2} maxLength={2000} value={guidance} onChange={(e) => setGuidance(e.target.value)} placeholder="例: 既存の API は変えずに実装する" />
          </label>
          <div className="form-actions">
            <button className="btn small" onClick={() => setOpen(false)}>
              キャンセル
            </button>
            <button className="btn primary small" disabled={busy} onClick={() => void delegate()}>
              {busy ? '送信中…' : '任せる'}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function IssuePanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['issues', projectId], queryFn: () => listIssues(projectId), refetchInterval: 30_000 });
  const reload = () => {
    void qc.invalidateQueries({ queryKey: ['issues', projectId] });
    void qc.invalidateQueries({ queryKey: ['runs'] });
  };

  if (q.isLoading) return <p className="muted small">Issue を読み込み中…</p>;
  if (q.error || !q.data) return <p className="error-text small">Issue を取得できませんでした: {q.error instanceof ApiError ? q.error.message : String(q.error)}</p>;

  const cols: { key: 'candidates' | 'materials' | 'running'; title: string; empty: string }[] = [
    { key: 'candidates', title: '候補', empty: '任せられる Issue はありません' },
    { key: 'materials', title: '資料済み', empty: '資料を書いた Issue はありません' },
    { key: 'running', title: '実行中', empty: '実行中の Issue はありません' },
  ];

  return (
    <div className="issue-panel">
      {cols.map((c) => {
        const rows = q.data[c.key];
        return (
          <div key={c.key} className="issue-col">
            <h5>
              {c.title}（{rows.length}）
            </h5>
            {rows.length === 0 ? (
              <p className="muted small">{c.empty}</p>
            ) : (
              <ul>
                {rows.map((i) => (
                  <IssueRow key={i.number} projectId={projectId} issue={i} onStarted={reload} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
