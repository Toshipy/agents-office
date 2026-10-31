/**
 * 2D 表示（FR-013 / NFR-015 / 要件定義書 7.1-4）。WebGL が使えない環境でも同じ情報へアクセスできる。
 */
import { AGENT_STATUS_LABEL, ROLE_LABEL, type OfficeState } from '@paw/contracts';
import { useOffice } from '../../shared/state/office';
import { Icon } from '../../shared/ui/Icon';
import { AGENT_STATUS_META, ROLE_META } from '../../shared/ui/status';

export function Office2D({ snapshot, reason }: { snapshot: OfficeState; reason?: string }) {
  const selectSeat = useOffice((s) => s.selectSeat);
  const selected = useOffice((s) => s.selectedSeatKey);
  const focusProject = useOffice((s) => s.focusProject);
  return (
    <div className="office-2d">
      {reason ? (
        <div className="notice">
          <Icon name="layers" size={14} /> {reason}
        </div>
      ) : null}
      <div className="grid-2d">
        {snapshot.projects.map((p) => (
          <section key={p.id} className="col-2d" style={{ ['--pc' as string]: p.color }}>
            <button className="col-head" onClick={() => focusProject(p.id)}>
              <span className="pr-dot" />
              <span>{p.name}</span>
              {p.stats.waitingApproval > 0 ? (
                <span className="mini-badge waiting">
                  <Icon name="hand" size={11} />
                  {p.stats.waitingApproval}
                </span>
              ) : null}
            </button>
            {snapshot.seats
              .filter((s) => s.projectId === p.id)
              .map((s) => {
                const m = AGENT_STATUS_META[s.status];
                return (
                  <button key={s.key} className={`card-2d agent-${s.status}${selected === s.key ? ' selected' : ''}`} onClick={() => selectSeat(s.key)}>
                    <span className="c2-top">
                      <span className="c2-role" style={{ color: ROLE_META[s.role].color }}>
                        <Icon name={ROLE_META[s.role].icon} size={13} /> {s.name} · {ROLE_LABEL[s.role]}
                      </span>
                      <span className="c2-status">
                        <Icon name={m.icon} size={12} /> {AGENT_STATUS_LABEL[s.status]}
                      </span>
                    </span>
                    <span className="c2-reason">{s.statusReason}</span>
                  </button>
                );
              })}
          </section>
        ))}
      </div>
    </div>
  );
}
