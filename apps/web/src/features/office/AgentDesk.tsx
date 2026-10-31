/**
 * 論理 Agent の席（基本設計書 5.1 AgentDesk）。机・モニター・キャラクター・ラベルをまとめる。
 * 状態ラベルは色だけでなくアイコンと文字を必ず併記する（要件定義書 7.1-3）。
 */
import { memo, useState } from 'react';
import { Html, RoundedBox } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { AGENT_STATUS_LABEL, ROLE_LABEL, type SeatViewModel } from '@paw/contracts';
import { AgentAvatar } from './AgentAvatar';
import { AgentStatusFx, SelectionRing } from './AgentStatusFx';
import { screenTexture } from './screens';
import { AGENT_STATUS_META, ROLE_META } from '../../shared/ui/status';
import { Icon } from '../../shared/ui/Icon';
import { useHtmlPortal } from './htmlPortal';
import { DESK_ROTATION } from './layout';
import { useOfficeLook } from '../../shared/look';

interface Props {
  seat: SeatViewModel;
  position: [number, number, number];
  detail: boolean;
  selected: boolean;
  dimmed: boolean;
  lowPower: boolean;
  phase: number;
  onSelect(key: string): void;
}

function Props_({ role }: { role: SeatViewModel['role'] }) {
  switch (role) {
    case 'planner':
      return (
        <group position={[-0.55, 0.78, 0.05]} rotation={[0, 0.3, 0]}>
          {[0, 1, 2].map((i) => (
            <mesh key={i} position={[0, i * 0.012, 0]} rotation={[0, i * 0.12, 0]} castShadow>
              <boxGeometry args={[0.24, 0.01, 0.32]} />
              <meshStandardMaterial color={i === 2 ? '#fef3c7' : '#f8fafc'} />
            </mesh>
          ))}
        </group>
      );
    case 'developer':
      return (
        <group position={[0.58, 0.77, -0.12]} rotation={[0, -0.5, 0]}>
          <mesh position={[0, 0.2, 0]} castShadow>
            <boxGeometry args={[0.36, 0.24, 0.03]} />
            <meshStandardMaterial color="#111827" />
          </mesh>
          <mesh position={[0, 0.2, 0.017]}>
            <planeGeometry args={[0.32, 0.2]} />
            <meshBasicMaterial map={screenTexture('working')} toneMapped={false} />
          </mesh>
          <mesh position={[0, 0.04, 0]}>
            <boxGeometry args={[0.03, 0.1, 0.03]} />
            <meshStandardMaterial color="#374151" />
          </mesh>
        </group>
      );
    case 'tester':
      return (
        <group position={[-0.58, 0.77, 0.08]}>
          <mesh position={[0, 0.06, 0]} castShadow>
            <cylinderGeometry args={[0.03, 0.08, 0.14, 12]} />
            <meshStandardMaterial color="#a7f3d0" transparent opacity={0.85} />
          </mesh>
          <mesh position={[0.12, 0.05, 0.04]} castShadow>
            <cylinderGeometry args={[0.025, 0.025, 0.12, 10]} />
            <meshStandardMaterial color="#fde68a" transparent opacity={0.85} />
          </mesh>
        </group>
      );
    case 'reviewer':
      return (
        <group position={[0.6, 0.77, 0.05]}>
          <mesh position={[0, 0.02, 0]} castShadow>
            <cylinderGeometry args={[0.07, 0.08, 0.03, 16]} />
            <meshStandardMaterial color="#334155" />
          </mesh>
          <mesh position={[0, 0.2, 0]} rotation={[0, 0, 0.25]}>
            <cylinderGeometry args={[0.012, 0.012, 0.34, 6]} />
            <meshStandardMaterial color="#64748b" />
          </mesh>
          <mesh position={[-0.06, 0.36, 0]} rotation={[0, 0, -0.9]}>
            <coneGeometry args={[0.07, 0.1, 16, 1, true]} />
            <meshStandardMaterial color="#e2e8f0" emissive="#fef9c3" emissiveIntensity={0.6} side={2} />
          </mesh>
        </group>
      );
  }
}

function AgentDeskImpl({ seat, position, detail, selected, dimmed, lowPower, phase, onSelect }: Props) {
  const [hover, setHover] = useState(false);
  const portal = useHtmlPortal();
  const look = useOfficeLook();
  const role = ROLE_META[seat.role];
  const meta = AGENT_STATUS_META[seat.status];
  const attention = seat.status !== 'idle';
  const showLabel = detail || selected || hover;
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect(seat.key);
  };

  return (
    <group
      position={position}
      rotation={[0, DESK_ROTATION, 0]}
      onClick={click}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHover(false);
        document.body.style.cursor = '';
      }}
    >
      {/* 机 */}
      <RoundedBox args={[1.62, 0.06, 0.84]} radius={0.025} position={[0, 0.74, -0.2]} castShadow receiveShadow>
        <meshStandardMaterial color={look.desk.top} roughness={look.avatar === 'robot' ? 0.35 : 0.55} metalness={look.avatar === 'robot' ? 0.3 : 0} />
      </RoundedBox>
      {[-0.74, 0.74].map((x) => (
        <mesh key={x} position={[x, 0.36, -0.2]} castShadow>
          <boxGeometry args={[0.06, 0.72, 0.76]} />
          <meshStandardMaterial color={look.desk.leg} roughness={0.6} />
        </mesh>
      ))}
      {/* モニター */}
      <group position={[0, 0.77, -0.44]}>
        <mesh position={[0, 0.01, 0]} receiveShadow>
          <boxGeometry args={[0.26, 0.02, 0.16]} />
          <meshStandardMaterial color="#374151" />
        </mesh>
        <mesh position={[0, 0.13, 0]}>
          <boxGeometry args={[0.05, 0.24, 0.04]} />
          <meshStandardMaterial color="#374151" />
        </mesh>
        <mesh position={[0, 0.42, 0]} castShadow>
          <boxGeometry args={[0.9, 0.54, 0.04]} />
          <meshStandardMaterial color={look.desk.monitor} roughness={0.4} />
        </mesh>
        <mesh position={[0, 0.42, 0.021]}>
          <planeGeometry args={[0.84, 0.48]} />
          <meshBasicMaterial map={screenTexture(seat.status)} toneMapped={false} />
        </mesh>
      </group>
      {/* キーボード */}
      <mesh position={[0, 0.78, -0.02]} castShadow>
        <boxGeometry args={[0.5, 0.02, 0.15]} />
        <meshStandardMaterial color={look.desk.keyboard} roughness={0.6} />
      </mesh>
      <Props_ role={seat.role} />

      {/* キャラクター */}
      <group position={[0, 0, 0.62]} scale={hover && !selected ? 1.04 : 1}>
        <AgentAvatar roleColor={role.color} status={seat.status} phase={phase} lowPower={lowPower} style={look.avatar} chairColor={look.chair} />
        <AgentStatusFx status={seat.status} lowPower={lowPower} phase={phase} />
        {selected ? <SelectionRing /> : null}
      </group>

      {/* ラベル（DOM オーバーレイ） */}
      {showLabel || attention ? (
        <Html portal={portal as never} position={[0, 2.55, 0.5]} center zIndexRange={[6, 0]} style={{ pointerEvents: 'none' }}>
          <div className={`seat-label agent-${seat.status}${showLabel ? '' : ' compact'}${dimmed ? ' dim' : ''}${selected ? ' selected' : ''}`}>
            <span className="sl-icon" aria-hidden>
              <Icon name={meta.icon} size={showLabel ? 12 : 13} />
            </span>
            {showLabel ? (
              <>
                <span className="sl-name">{seat.name}</span>
                <span className="sl-role" style={{ color: role.color }}>
                  {ROLE_LABEL[seat.role]}
                </span>
                <span className="sl-status">{AGENT_STATUS_LABEL[seat.status]}</span>
              </>
            ) : (
              <span className="sr-only">{`${seat.name} ${AGENT_STATUS_LABEL[seat.status]}`}</span>
            )}
          </div>
        </Html>
      ) : null}
    </group>
  );
}

/** スナップショット再取得のたびに全席を再描画しないよう、表示に効く値だけ比較する */
function sameProps(a: Props, b: Props) {
  return (
    a.seat.key === b.seat.key &&
    a.seat.status === b.seat.status &&
    a.seat.name === b.seat.name &&
    a.seat.role === b.seat.role &&
    a.detail === b.detail &&
    a.selected === b.selected &&
    a.dimmed === b.dimmed &&
    a.lowPower === b.lowPower &&
    a.phase === b.phase &&
    a.onSelect === b.onSelect &&
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2]
  );
}

export const AgentDesk = memo(AgentDeskImpl, sameProps);
