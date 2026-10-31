/**
 * 承認カード（UI-05 / FR-044 / FR-045）。
 * 「何を承認するか」（対象・内容ハッシュ・期限）を表示し、確認ダイアログを経て判定する。
 * pr_review は GitHub 側でレビューする（ローカル版は GitHub シミュレーター経由）。
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { APPROVAL_TYPE_LABEL, ROLE_LABEL, type AgentRole } from '@paw/contracts';
import { ApiError, api, newIdempotencyKey, type ApprovalDto } from '../../shared/api/client';
import { useAuthConfig } from '../../shared/api/authConfig';
import { Icon } from '../../shared/ui/Icon';
import { Modal } from '../../shared/ui/content';
import { RunStatusPill } from '../../shared/ui/status';
import { relTime, untilTime } from '../../shared/ui/format';
import { toast } from '../../shared/ui/toast';

type Action =
  | { kind: 'decision'; decision: 'approve' | 'request_changes' | 'reject' }
  | { kind: 'review'; state: 'approved' | 'changes_requested' };

const ACTION_TEXT: Record<string, { label: string; tone: string; icon: string; confirm: string }> = {
  approve: { label: '承認して続行', tone: 'primary', icon: 'check', confirm: '内容を確認のうえ承認しますか？' },
  request_changes: { label: '差し戻し', tone: '', icon: 'refresh', confirm: '指示を添えて差し戻します。' },
  reject: { label: '却下（Run を中止）', tone: 'danger', icon: 'x', confirm: '却下すると Run は中止されます。' },
  approved: { label: 'GitHub で Approve', tone: 'primary', icon: 'check', confirm: 'GitHub のレビュー（Approve）をシミュレートします。マージは行われません。' },
  changes_requested: { label: 'GitHub で Request changes', tone: '', icon: 'refresh', confirm: 'GitHub のレビュー（Request changes）をシミュレートします。再修正 Run が始まります。' },
};

export function ApprovalCard({ approval: a }: { approval: ApprovalDto }) {
  const qc = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = a.status === 'pending';
  const p = a.payload;
  const devRoutes = useAuthConfig().data?.devRoutes ?? false;

  const submit = async () => {
    if (!action) return;
    setBusy(true);
    try {
      if (action.kind === 'review') {
        await api.post('/v1/dev/github/simulate', { kind: 'review', runId: a.runId, state: action.state, body: comment });
        toast({ tone: 'success', title: action.state === 'approved' ? 'Approve を送信しました' : 'Request changes を送信しました', body: '署名付き Webhook として処理されます' });
      } else {
        await api.post(
          `/v1/approvals/${a.id}/decision`,
          { decision: action.decision, expectedVersion: a.version, confirmationDigest: a.payloadDigest, ...(comment.trim() ? { comment: comment.trim() } : {}) },
          { 'idempotency-key': newIdempotencyKey() },
        );
        toast({ tone: 'success', title: '判定を記録しました' });
      }
      setAction(null);
      setComment('');
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['run', a.runId] });
    } catch (e) {
      toast({ tone: 'error', title: '処理できませんでした', body: e instanceof ApiError ? `${e.message}（${e.code}）` : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const key = action ? (action.kind === 'review' ? action.state : action.decision) : null;
  const needsComment = key === 'request_changes';

  return (
    <article className={`approval-card type-${a.actionType}${pending ? '' : ' decided'}`}>
      <header className="ap-head">
        <span className="ap-type">
          <Icon name={a.actionType === 'pr_review' ? 'git-pr' : a.actionType === 'dangerous_operation' ? 'alert' : 'help'} size={15} />
          {APPROVAL_TYPE_LABEL[a.actionType]}
        </span>
        {a.project ? (
          <span className="task-project" style={{ ['--pc' as string]: a.project.color }}>
            {a.project.name}
          </span>
        ) : null}
        <span className="muted small">
          {relTime(a.createdAt)} · 要求元 {ROLE_LABEL[a.requestedByRole as AgentRole] ?? a.requestedByRole}
        </span>
        <span className={`ap-status s-${a.status}`}>{pending ? untilTime(a.expiresAt) : a.status}</span>
      </header>
      <h3 className="ap-title">{a.title}</h3>
      {a.run ? (
        <Link to={`/runs/${a.runId}`} className="ap-run">
          <RunStatusPill status={a.run.status} small /> {a.run.title} <span className="mono faint">{a.runId}</span>
        </Link>
      ) : null}

      <div className="ap-body">
        {a.actionType === 'pr_review' ? (
          <>
            <dl className="kv cols">
              <div>
                <dt>Draft PR</dt>
                <dd className="mono">#{p.pr?.number}</dd>
              </div>
              <div>
                <dt>ブランチ</dt>
                <dd className="mono">{p.pr?.branch}</dd>
              </div>
              <div>
                <dt>テスト</dt>
                <dd>{p.testsPassed === true ? '✓ 通過' : p.testsPassed === false ? '✗ 失敗' : '—'}</dd>
              </div>
              <div>
                <dt>差分</dt>
                <dd className="mono">{p.diff ? `${p.diff.files?.length ?? 0} files +${p.diff.additions} −${p.diff.deletions}` : '—'}</dd>
              </div>
            </dl>
            <p className="hint">{String(p.note ?? '')}</p>
          </>
        ) : a.actionType === 'dangerous_operation' ? (
          <>
            <ul className="danger-list">
              {(p.detected as string[] | undefined)?.map((d) => (
                <li key={d}>
                  <Icon name="alert" size={13} /> {d}
                </li>
              ))}
            </ul>
            <ul className="questions">
              {(p.questions as string[] | undefined)?.map((qq) => <li key={qq}>{qq}</li>)}
            </ul>
            <blockquote className="excerpt">{String(p.requestExcerpt ?? '')}</blockquote>
            <p className="hint warn">{String(p.note ?? '')}</p>
          </>
        ) : (
          <>
            <p>
              再修正 {p.revisionCount} / {p.maxRevisionAttempts} 回に達しました。
            </p>
            {p.lastReviewComment ? <blockquote className="excerpt">{String(p.lastReviewComment)}</blockquote> : null}
            <p className="hint">{String(p.note ?? '')}</p>
          </>
        )}
        <div className="digest mono" title="承認対象の内容ハッシュ。内容が変わると承認できません">
          <Icon name="lock" size={12} /> {a.payloadDigest.slice(0, 23)}… · v{a.version}
        </div>
      </div>

      {pending ? (
        <footer className="ap-actions">
          {a.actionType === 'pr_review' && !devRoutes ? (
            <span className="muted small">GitHub 上でレビューしてください（レビューイベントを受信すると反映されます）</span>
          ) : a.actionType === 'pr_review' ? (
            <>
              <span className="muted small">GitHub シミュレーター:</span>
              <button className="btn primary" onClick={() => setAction({ kind: 'review', state: 'approved' })}>
                <Icon name="check" size={14} /> Approve
              </button>
              <button className="btn" onClick={() => setAction({ kind: 'review', state: 'changes_requested' })}>
                <Icon name="refresh" size={14} /> Request changes
              </button>
            </>
          ) : (
            <>
              <button
                className="btn primary"
                disabled={a.actionType === 'dangerous_operation'}
                title={a.actionType === 'dangerous_operation' ? 'MVP では危険操作は承認しても実行できません' : undefined}
                onClick={() => setAction({ kind: 'decision', decision: 'approve' })}
              >
                <Icon name={a.actionType === 'dangerous_operation' ? 'lock' : 'check'} size={14} /> 承認して続行
              </button>
              <button className="btn" onClick={() => setAction({ kind: 'decision', decision: 'request_changes' })}>
                <Icon name="refresh" size={14} /> {a.actionType === 'dangerous_operation' ? '安全な範囲で再計画' : '差し戻し（指示を追加）'}
              </button>
              <button className="btn danger" onClick={() => setAction({ kind: 'decision', decision: 'reject' })}>
                <Icon name="x" size={14} /> 却下
              </button>
            </>
          )}
        </footer>
      ) : (
        <footer className="ap-decided small muted">
          {a.decidedBy ? `判定: ${a.status}（${a.decidedBy}）` : a.status} {a.decidedAt ? `· ${relTime(a.decidedAt)}` : ''}
          {a.decisionComment ? ` — 「${a.decisionComment}」` : ''}
        </footer>
      )}

      {action && key ? (
        <Modal title={ACTION_TEXT[key].label} onClose={() => setAction(null)}>
          <div className="confirm">
            <p>{ACTION_TEXT[key].confirm}</p>
            <dl className="kv">
              <div>
                <dt>対象</dt>
                <dd>{a.title}</dd>
              </div>
              <div>
                <dt>Run</dt>
                <dd className="mono">{a.runId}</dd>
              </div>
              <div>
                <dt>内容ハッシュ</dt>
                <dd className="mono">{a.payloadDigest.slice(0, 30)}…</dd>
              </div>
            </dl>
            <label>
              コメント{needsComment ? '（必須）' : '（任意）'}
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={2000} placeholder={needsComment ? '修正してほしい点を具体的に' : ''} />
            </label>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setAction(null)}>
                キャンセル
              </button>
              <button className={`btn ${ACTION_TEXT[key].tone}`} disabled={busy || (needsComment && !comment.trim())} onClick={() => void submit()}>
                <Icon name={ACTION_TEXT[key].icon} size={14} /> {busy ? '送信中…' : ACTION_TEXT[key].label}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </article>
  );
}
