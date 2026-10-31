/**
 * Project ごとの「島」。上に 4 席（Planner / Developer / Tester / Reviewer）と情報カードを置く。
 */
import { memo, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { AGENT_ROLES, type ProjectViewModel, type SeatViewModel } from '@paw/contracts';
import { AgentDesk } from './AgentDesk';
import { ISLAND_HEIGHT, ISLAND_SIZE, SEAT_OFFSETS, mix } from './layout';
import { Icon } from '../../shared/ui/Icon';
import { useHtmlPortal } from './htmlPortal';

interface Props {
  project: ProjectViewModel;
  seats: SeatViewModel[];
  position: [number, number];
  focused: boolean;
  anyFocused: boolean;
  zoomedIn: boolean;
  selectedSeatKey: string | null;
  lowPower: boolean;
  index: number;
  onFocus(id: string): void;
  onSelectSeat(key: string): void;
}

function IslandImpl({ project, seats, position, focused, anyFocused, zoomedIn, selectedSeatKey, lowPower, index, onFocus, onSelectSeat }: Props) {
  const [hover, setHover] = useState(false);
  const portal = useHtmlPortal();
  const edge = useRef<THREE.Mesh>(null);
  const S = ISLAND_SIZE;
  const colors = useMemo(
    () => ({
      top: mix(project.color, '#c8d0de', 0.42),
      inner: mix(project.color, '#e8edf5', 0.55),
      side: mix(project.color, '#121826', 0.62),
      glow: project.color,
    }),
    [project.color],
  );
  const dimmed = anyFocused && !focused;
  const border = useMemo(() => {
    const h = S / 2 - 0.06;
    return [
      [-h, 0.06, -h],
      [h, 0.06, -h],
      [h, 0.06, h],
      [-h, 0.06, h],
      [-h, 0.06, -h],
    ] as [number, number, number][];
  }, [S]);

  useFrame((state) => {
    if (!edge.current) return;
    const m = edge.current.material as THREE.MeshStandardMaterial;
    const target = focused ? 0.55 : hover ? 0.4 : 0.12 + Math.sin(state.clock.elapsedTime * 1.2 + index) * 0.04;
    m.emissiveIntensity = THREE.MathUtils.lerp(m.emissiveIntensity, target, 0.1);
  });

  const s = project.stats;
  // 画面上半分の島はカードを上に、下半分の島は下に出して、島同士・カード同士の重なりを避ける
  const upper = position[0] + position[1] < 0;
  const cardAnchor: [number, number, number] = upper ? [-S / 2 + 0.25, 0.3, -S / 2 + 0.25] : [S / 2 - 0.25, 0.05, S / 2 - 0.25];
  const showCard = !anyFocused || !zoomedIn;

  return (
    <group position={[position[0], 0, position[1]]}>
      {/* 土台 */}
      <RoundedBox
        ref={edge}
        args={[S, ISLAND_HEIGHT, S]}
        radius={0.32}
        smoothness={4}
        position={[0, -ISLAND_HEIGHT / 2, 0]}
        receiveShadow
        castShadow
        onClick={(e) => {
          e.stopPropagation();
          onFocus(project.id);
        }}
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
        <meshStandardMaterial color={colors.side} emissive={colors.glow} emissiveIntensity={0.12} roughness={0.7} />
      </RoundedBox>
      {/* 天板（カーペット） */}
      <RoundedBox args={[S - 0.36, 0.05, S - 0.36]} radius={0.22} smoothness={3} position={[0, 0.0, 0]} receiveShadow>
        <meshStandardMaterial color={colors.top} roughness={0.92} />
      </RoundedBox>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} receiveShadow>
        <planeGeometry args={[S - 2.2, S - 2.2]} />
        <meshStandardMaterial color={colors.inner} roughness={0.95} transparent opacity={0.45} />
      </mesh>
      <Line points={border} color={project.color} lineWidth={focused ? 2.2 : 1.2} transparent opacity={focused || hover ? 0.95 : 0.35} />

      {AGENT_ROLES.map((role, i) => {
        const seat = seats.find((x) => x.role === role);
        if (!seat) return null;
        const [ox, oz] = SEAT_OFFSETS[role];
        return (
          <AgentDesk
            key={seat.key}
            seat={seat}
            position={[ox, 0.02, oz]}
            detail={focused && zoomedIn}
            selected={selectedSeatKey === seat.key}
            dimmed={dimmed}
            lowPower={lowPower}
            phase={index * 1.7 + i * 0.9}
            onSelect={onSelectSeat}
          />
        );
      })}

      {showCard ? (
        <Html portal={portal as never} position={cardAnchor} zIndexRange={[8, 0]} style={{ pointerEvents: 'none' }}>
          <button
            type="button"
            className={`island-card ${upper ? 'above' : 'below'}${focused ? ' focused' : ''}${dimmed ? ' dim' : ''}${s.waitingApproval > 0 ? ' attention' : ''}`}
            style={{ ['--pc' as string]: project.color }}
            onClick={() => onFocus(project.id)}
            aria-label={`${project.name} を表示`}
          >
            <span className="ic-head">
              <span className="ic-dot" />
              <span className="ic-name">{project.name}</span>
              {project.repo?.automationEnabled ? (
                <span className="ic-auto" title={`自動起動 ON（ラベル ${project.repo.triggerLabel}）`}>
                  AUTO
                </span>
              ) : null}
            </span>
            <span className="ic-big">
              <strong>{seats.length}</strong> AGENTS
            </span>
            <span className="ic-rows">
              <span>
                Open Draft PR <b>{s.openPrs}</b>
              </span>
              <span>
                完了 (24h) <b>{s.done24h}</b>
              </span>
            </span>
            <span className="ic-foot">
              DOING <b>{s.doing}</b> · NEXT <b>{s.next}</b> · DONE <b>{s.done24h}</b>
            </span>
            {s.waitingApproval > 0 ? (
              <span className="ic-wait">
                <Icon name="hand" size={12} /> {s.waitingApproval} 件 承認待ち
              </span>
            ) : null}
            {s.failed24h > 0 ? (
              <span className="ic-fail">
                <Icon name="x-circle" size={12} /> 失敗 {s.failed24h}
              </span>
            ) : null}
          </button>
        </Html>
      ) : null}
    </group>
  );
}

export const ProjectIsland = memo(IslandImpl);
