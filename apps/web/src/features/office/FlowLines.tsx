/**
 * Hub と各 Project を結ぶ通路と、イベントに応じて流れる光（パケット）・パルス。
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import type { ProjectViewModel } from '@paw/contracts';
import { useOffice, type Fx } from '../../shared/state/office';
import { HUB_RADIUS, ISLAND_SIZE } from './layout';
import { useOfficeLook } from '../../shared/look';

interface Anchor {
  id: string;
  x: number;
  z: number;
}

export function Walkways({ projects, positions }: { projects: ProjectViewModel[]; positions: [number, number][] }) {
  return (
    <>
      {projects.map((p, i) => (
        <Walkway key={p.id} project={p} to={positions[i]} />
      ))}
    </>
  );
}

function Walkway({ project, to }: { project: ProjectViewModel; to: [number, number] }) {
  const line = useRef<any>(null);
  const look = useOfficeLook();
  const active = project.stats.doing > 0 || project.stats.next > 0;
  const auto = project.repo?.automationEnabled ?? false;
  const { mid, len, angle, start, end } = useMemo(() => {
    const [x, z] = to;
    const d = Math.hypot(x, z);
    const ux = x / d;
    const uz = z / d;
    const s = HUB_RADIUS - 0.1;
    const e = d - ISLAND_SIZE / 2 - 0.05;
    return {
      start: [ux * s, 0.06, uz * s] as [number, number, number],
      end: [ux * e, 0.06, uz * e] as [number, number, number],
      mid: [(ux * (s + e)) / 2, -0.12, (uz * (s + e)) / 2] as [number, number, number],
      len: e - s,
      angle: Math.atan2(x, z),
    };
  }, [to]);
  useFrame((_, dt) => {
    const m = line.current?.material;
    if (m) m.dashOffset -= dt * (active ? 1.6 : 0.4);
  });
  return (
    <group>
      <mesh position={mid} rotation={[0, angle, 0]} receiveShadow>
        <boxGeometry args={[1.25, 0.18, len]} />
        <meshStandardMaterial color={look.walkway} roughness={0.75} />
      </mesh>
      <Line
        ref={line}
        points={[start, end]}
        color={auto || active ? project.color : look.walkwayIdleLine}
        lineWidth={1.6}
        dashed
        dashSize={0.35}
        gapSize={0.3}
        transparent
        opacity={active ? 0.95 : auto ? 0.55 : 0.3}
      />
    </group>
  );
}

const _v = new THREE.Vector3();

export function FxLayer({ anchors }: { anchors: Anchor[] }) {
  const fx = useOffice((s) => s.fx);
  const prune = useOffice((s) => s.pruneFx);
  useFrame(() => prune(performance.now()));
  const find = (id: string) => (id === 'hub' ? { x: 0, z: 0 } : anchors.find((a) => a.id === id));
  return (
    <>
      {fx.map((f) => {
        const a = find(f.from);
        const b = find(f.to);
        if (!a || !b) return null;
        return f.kind === 'packet' ? (
          <Packet key={f.id} fx={f} from={[a.x, a.z]} to={[b.x, b.z]} />
        ) : (
          <Pulse key={f.id} fx={f} at={[a.x, a.z]} big={f.from === 'hub'} />
        );
      })}
    </>
  );
}

function Packet({ fx, from, to }: { fx: Fx; from: [number, number]; to: [number, number] }) {
  const m = useRef<THREE.Mesh>(null);
  const trail = useRef<THREE.Mesh>(null);
  const curve = useMemo(() => {
    const a = new THREE.Vector3(from[0], 2.0, from[1]);
    const b = new THREE.Vector3(to[0], 1.2, to[1]);
    const c = a.clone().lerp(b, 0.5);
    c.y += 4.5;
    return new THREE.QuadraticBezierCurve3(a, c, b);
  }, [from, to]);
  useFrame(() => {
    const p = Math.min(1, (performance.now() - fx.createdAt) / 1400);
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    if (m.current) {
      curve.getPoint(e, _v);
      m.current.position.copy(_v);
      m.current.scale.setScalar(p > 0.92 ? (1 - p) * 12 : 1);
    }
    if (trail.current) {
      curve.getPoint(Math.max(0, e - 0.06), _v);
      trail.current.position.copy(_v);
      (trail.current.material as THREE.MeshBasicMaterial).opacity = p > 0.92 ? 0 : 0.45;
    }
  });
  return (
    <>
      <mesh ref={m}>
        <sphereGeometry args={[0.2, 16, 16]} />
        <meshBasicMaterial color={fx.color} toneMapped={false} />
      </mesh>
      <mesh ref={trail}>
        <sphereGeometry args={[0.13, 12, 12]} />
        <meshBasicMaterial color={fx.color} transparent opacity={0.45} toneMapped={false} depthWrite={false} />
      </mesh>
    </>
  );
}

function Pulse({ fx, at, big }: { fx: Fx; at: [number, number]; big: boolean }) {
  const m = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const p = Math.min(1, (performance.now() - fx.createdAt) / 1600);
    if (!m.current) return;
    const s = (big ? 1.2 : 1.5) + p * (big ? 3.4 : 4.2);
    m.current.scale.set(s, s, s);
    (m.current.material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.8;
  });
  return (
    <mesh ref={m} position={[at[0], 0.09, at[1]]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.9, 1, 64]} />
      <meshBasicMaterial color={fx.color} transparent opacity={0.8} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}
