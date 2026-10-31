/**
 * 状態エフェクト（基本設計書 5.1 AgentStatusFx）。色に加え形でも状態を区別する。
 *  working: 画面から立ち上るコード片 / reviewing: 頭の周りを回るルーペ /
 *  waiting_approval: 「!」の菱形と足元のパルス / failed: 「×」と赤いパルス / completed: チェックの跳ね上がり
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AgentVisualStatus } from '@paw/contracts';
import { AGENT_STATUS_HEX } from '../../shared/ui/status';

export function AgentStatusFx({ status, lowPower, phase }: { status: AgentVisualStatus; lowPower: boolean; phase: number }) {
  return (
    <>
      {status === 'working' && !lowPower ? <CodeBits phase={phase} /> : null}
      {status === 'reviewing' ? <Magnifier phase={phase} /> : null}
      {status === 'waiting_approval' ? (
        <>
          <Beacon color={AGENT_STATUS_HEX.waiting_approval} shape="diamond" phase={phase} />
          <GroundPulse color={AGENT_STATUS_HEX.waiting_approval} />
        </>
      ) : null}
      {status === 'failed' ? (
        <>
          <Beacon color={AGENT_STATUS_HEX.failed} shape="cross" phase={phase} />
          <GroundPulse color={AGENT_STATUS_HEX.failed} />
        </>
      ) : null}
      {status === 'completed' ? <Beacon color={AGENT_STATUS_HEX.completed} shape="check" phase={phase} /> : null}
    </>
  );
}

function CodeBits({ phase }: { phase: number }) {
  const group = useRef<THREE.Group>(null);
  const seeds = useMemo(() => Array.from({ length: 6 }, (_, i) => ({ x: (i % 3) * 0.22 - 0.22, d: i * 0.37, w: 0.06 + (i % 3) * 0.04 })), []);
  const colors = ['#5eead4', '#a5b4fc', '#f0abfc'];
  useFrame((state) => {
    const t = state.clock.elapsedTime + phase;
    group.current?.children.forEach((c, i) => {
      const s = seeds[i];
      const p = ((t * 0.55 + s.d) % 1 + 1) % 1;
      c.position.set(s.x + Math.sin(t + i) * 0.04, 1.5 + p * 0.9, -0.98);
      const m = (c as THREE.Mesh).material as THREE.MeshBasicMaterial;
      m.opacity = Math.sin(p * Math.PI) * 0.9;
    });
  });
  return (
    <group ref={group}>
      {seeds.map((s, i) => (
        <mesh key={i}>
          <boxGeometry args={[s.w, 0.035, 0.01]} />
          <meshBasicMaterial color={colors[i % 3]} transparent opacity={0} toneMapped={false} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

function Magnifier({ phase }: { phase: number }) {
  const g = useRef<THREE.Group>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime * 1.3 + phase;
    if (!g.current) return;
    g.current.position.set(Math.cos(t) * 0.42, 1.5 + Math.sin(t * 2) * 0.05, Math.sin(t) * 0.42);
    g.current.rotation.y = -t;
  });
  return (
    <group ref={g}>
      <mesh rotation={[0, 0, 0]}>
        <torusGeometry args={[0.1, 0.022, 10, 24]} />
        <meshStandardMaterial color="#e2e8f0" emissive={AGENT_STATUS_HEX.reviewing} emissiveIntensity={0.9} toneMapped={false} />
      </mesh>
      <mesh position={[0.1, -0.1, 0]} rotation={[0, 0, Math.PI / 4]}>
        <cylinderGeometry args={[0.018, 0.018, 0.13, 8]} />
        <meshStandardMaterial color="#94a3b8" />
      </mesh>
    </group>
  );
}

function Beacon({ color, shape, phase }: { color: string; shape: 'diamond' | 'cross' | 'check'; phase: number }) {
  const g = useRef<THREE.Group>(null);
  const born = useRef<number | null>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (born.current === null) born.current = t;
    if (!g.current) return;
    const age = t - born.current;
    const pop = Math.min(1, age * 3);
    const scale = shape === 'check' ? (age < 0.35 ? pop * 1.25 : 1) : 1;
    g.current.scale.setScalar(scale);
    g.current.position.y = 2.0 + Math.sin((t + phase) * 2.4) * 0.07;
    g.current.rotation.y = shape === 'diamond' ? t * 1.6 : shape === 'cross' ? Math.sin(t) * 0.4 : t * 0.8;
  });
  return (
    <group ref={g} position={[0, 2.0, 0]}>
      {shape === 'diamond' ? (
        <>
          <mesh>
            <octahedronGeometry args={[0.17, 0]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} toneMapped={false} />
          </mesh>
          <mesh position={[0, -0.3, 0]}>
            <sphereGeometry args={[0.04, 10, 10]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1} toneMapped={false} />
          </mesh>
        </>
      ) : shape === 'cross' ? (
        <>
          <mesh rotation={[0, 0, Math.PI / 4]}>
            <boxGeometry args={[0.38, 0.08, 0.08]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} toneMapped={false} />
          </mesh>
          <mesh rotation={[0, 0, -Math.PI / 4]}>
            <boxGeometry args={[0.38, 0.08, 0.08]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} toneMapped={false} />
          </mesh>
        </>
      ) : (
        <group rotation={[0, 0, 0]}>
          <mesh position={[-0.07, -0.03, 0]} rotation={[0, 0, Math.PI / 4]}>
            <boxGeometry args={[0.16, 0.07, 0.07]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} toneMapped={false} />
          </mesh>
          <mesh position={[0.06, 0.03, 0]} rotation={[0, 0, -Math.PI / 3.2]}>
            <boxGeometry args={[0.3, 0.07, 0.07]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} toneMapped={false} />
          </mesh>
        </group>
      )}
    </group>
  );
}

function GroundPulse({ color }: { color: string }) {
  const m = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!m.current) return;
    const p = (state.clock.elapsedTime * 0.7) % 1;
    m.current.scale.setScalar(0.8 + p * 0.9);
    (m.current.material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.55;
  });
  return (
    <mesh ref={m} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, -0.1]}>
      <ringGeometry args={[0.72, 0.8, 48]} />
      <meshBasicMaterial color={color} transparent opacity={0.5} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

export function SelectionRing({ color = '#e0e7ff' }: { color?: string }) {
  const m = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (m.current) m.current.rotation.z = state.clock.elapsedTime * 0.6;
  });
  return (
    <mesh ref={m} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, -0.1]}>
      <ringGeometry args={[0.95, 1.03, 64, 1, 0, Math.PI * 1.75]} />
      <meshBasicMaterial color={color} transparent opacity={0.85} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}
