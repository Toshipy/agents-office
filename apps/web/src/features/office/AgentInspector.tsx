/**
 * 選択した Agent の詳細サイドパネル（基本設計書 5.1 AgentInspector / FR-012）。
 * 担当 Run / Project / ライブ作業ログ / 成果物を表示し、Run 詳細へ遷移できる。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ROLE_LABEL, type ProjectViewModel, type SeatViewModel, type StepLogLine } from '@paw/contracts';
import { api, type RunDetail } from '../../shared/api/client';
import { useOffice } from '../../shared/state/office';
import { Icon } from '../../shared/ui/Icon';
import { AgentStatusPill, ROLE_META, RunStatusPill, StepStatusPill, stepLabel } from '../../shared/ui/status';
import { ArtifactBody, Modal, artifactIcon } from '../../shared/ui/content';
import { relTime } from '../../shared/ui/format';
import { TaskComposer } from './TaskComposer';

const EMPTY: StepLogLine[] = [];

export function AgentInspector({ seat, project }: { seat: SeatViewModel; project: ProjectViewModel }) {
  const selectSeat = useOffice((s) => s.selectSeat);
  const snapshot = useOffice((s) => s.snapshot);
  const role = ROLE_META[seat.role];
  // 現在の担当 Run が無ければ、この席の直近の Run を表示する
  const runId = useMemo(() => {
    if (seat.currentRun) return seat.currentRun.id;
    const recent = snapshot?.runs.find((r) => r.projectId === project.id);
    return recent?.id ?? null;
  }, [seat.currentRun, snapshot?.runs, project.id]);
  const detail = useQuery({
    queryKey: ['run', runId],
    queryFn: () => api.get<RunDetail>(`/v1/runs/${runId}`),
    enabled: Boolean(runId),
  });
  const myStep = useMemo(() => {
    const steps = detail.data?.steps ?? [];
    const mine = steps.filter((s) => s.role === seat.role);
    return mine.find((s) => s.status === 'running') ?? mine[mine.length - 1] ?? null;
  }, [detail.data?.steps, seat.role]);
  const [artifactId, setArtifactId] = useState<string | null>(null);

  return (
    <div className="inspector">
      <button className="back-link" onClick={() => selectSeat(null)}>
        <Icon name="chevron-left" size={14} /> {project.name}
      </button>
      <header className="insp-head" style={{ ['--role' as string]: role.color }}>
        <div className="insp-avatar" aria-hidden>
          <Icon name={role.icon} size={22} />
        </div>
        <div>
          <h2>{seat.name}</h2>
          <p className="insp-sub">
            {ROLE_LABEL[seat.role]} · {project.name}
          </p>
        </div>
      </header>
      <p className="insp-blurb">{role.blurb}</p>
      <div className="insp-status">
        <AgentStatusPill status={seat.status} />
        <span className="insp-reason">{seat.statusReason}</span>
      </div>

      {runId && detail.data ? (
        <section className="insp-run">
          <div className="insp-run-head">
            <span className="eyebrow">{seat.currentRun ? '担当中の Run' : '直近の Run'}</span>
            <RunStatusPill status={detail.data.run.status} small />
          </div>
          <Link to={`/runs/${runId}`} className="insp-run-title">
            {detail.data.run.title}
            <Icon name="external" size={13} />
          </Link>
          <div className="pipeline compact">
            {detail.data.steps.slice(-6).map((s) => (
              <span key={s.id} className={`pipe-step st-${s.status}${s.role === seat.role ? ' mine' : ''}`} title={`${stepLabel(s.key)} — ${s.status}`}>
                {stepLabel(s.key)}
              </span>
            ))}
          </div>
          {myStep ? (
            <div className="insp-step">
              <StepStatusPill status={myStep.status} />
              <span>
                {stepLabel(myStep.key)}
                {myStep.attempt > 1 ? `（試行 ${myStep.attempt}/${myStep.maxAttempts}）` : ''}
              </span>
              {myStep.summary ? <span className="muted">— {myStep.summary}</span> : null}
            </div>
          ) : null}
          {myStep ? <LiveLog runId={runId} stepId={myStep.id} live={myStep.status === 'running'} /> : null}
          {detail.data.artifacts.length ? (
            <div className="insp-artifacts">
              {detail.data.artifacts.slice(-4).map((a) => (
                <button key={a.id} className="artifact-chip" onClick={() => setArtifactId(a.id)}>
                  <Icon name={artifactIcon(a.kind)} size={14} />
                  <span>{a.title}</span>
                  <span className="muted">{relTime(a.createdAt)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : (
        <section className="insp-run empty">
          <Icon name="moon" size={18} />
          <span>まだ担当した Run はありません</span>
        </section>
      )}

      <TaskComposer projectId={project.id} compact placeholder={`${project.name} にタスクを依頼…`} />
      {artifactId ? (
        <Modal title="成果物" onClose={() => setArtifactId(null)} wide>
          <ArtifactBody artifactId={artifactId} />
        </Modal>
      ) : null}
    </div>
  );
}

function LiveLog({ runId, stepId, live }: { runId: string; stepId: string; live: boolean }) {
  const lines = useOffice((s) => s.logs[stepId] ?? EMPTY);
  const append = useOffice((s) => s.appendLogs);
  const box = useRef<HTMLDivElement>(null);
  // 初回と再接続時は API から取得（SSE の一時イベントは取りこぼし得るため）
  useEffect(() => {
    let alive = true;
    void api.get<{ items: StepLogLine[] }>(`/v1/runs/${runId}/logs?stepId=${stepId}`).then((r) => {
      if (alive) append(r.items);
    });
    return () => {
      alive = false;
    };
  }, [runId, stepId, append]);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines.length]);
  return (
    <div className="live-log" ref={box} aria-live="polite">
      <div className="live-log-head">
        <span className={`dot${live ? ' on' : ''}`} /> {live ? 'live work stream' : 'work log'}
      </div>
      {lines.length === 0 ? <div className="muted">ログはまだありません</div> : null}
      {lines.slice(-40).map((l) => (
        <div key={l.id} className={`log-line k-${l.kind}`}>
          <span className="log-time">{new Date(l.ts).toLocaleTimeString('ja-JP', { hour12: false })}</span>
          <span className="log-kind">{l.kind === 'tool' ? '⚙' : l.kind === 'policy' ? '⛔' : l.kind === 'error' ? '!' : '›'}</span>
          <span className="log-msg">{l.message}</span>
        </div>
      ))}
      {live ? <div className="log-cursor" aria-hidden>▍</div> : null}
    </div>
  );
}
