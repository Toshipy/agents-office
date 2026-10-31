/**
 * 中央の Dispatch Hub。Webhook 受信・キュー・Run 起動（ローカル版の Dispatcher / ワークフローエンジン）を表す。
 */
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { HubViewModel } from '@paw/contracts';
import { HUB_RADIUS } from './layout';
import { Icon } from '../../shared/ui/Icon';
import { useHtmlPortal } from './htmlPortal';
import { useOfficeLook } from '../../shared/look';

export function HubCore({ hub, lowPower }: { hub: HubViewModel; lowPower: boolean }) {
  const portal = useHtmlPortal();
  const look = useOfficeLook();
  const core = useRef<THREE.Group>(null);
  const ico = useRef<THREE.Mesh>(null);
  const ring1 = useRef<THREE.Mesh>(null);
  const ring2 = useRef<THREE.Mesh>(null);
  const orb = useRef<THREE.MeshStandardMaterial>(null);
  const accent = hub.paused ? '#f87171' : look.hub.accent;
  const busy = hub.active > 0;

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    const speed = hub.paused ? 0.15 : busy ? 1 : 0.45;
    if (ico.current) {
      ico.current.rotation.y += dt * 0.6 * speed;
      ico.current.rotation.x += dt * 0.25 * speed;
    }
    if (ring1.current) ring1.current.rotation.z += dt * 0.9 * speed;
    if (ring2.current) ring2.current.rotation.x += dt * 0.7 * speed;
    if (core.current) core.current.position.y = 2.1 + Math.sin(t * 1.2) * 0.12;
    if (orb.current) orb.current.emissiveIntensity = 1.4 + Math.sin(t * (busy ? 4 : 1.5)) * 0.5;
  });

  return (
    <group>
      <mesh position={[0, -0.3, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[HUB_RADIUS, HUB_RADIUS + 0.25, 0.6, 64]} />
        <meshStandardMaterial color={look.hub.base} roughness={0.6} metalness={0.2} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.011, 0]} receiveShadow>
        <circleGeometry args={[HUB_RADIUS - 0.15, 64]} />
        <meshStandardMaterial color={look.hub.top} roughness={0.8} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[HUB_RADIUS - 0.35, HUB_RADIUS - 0.22, 96]} />
        <meshBasicMaterial color={accent} transparent opacity={0.55} toneMapped={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[1.25, 1.32, 64]} />
        <meshBasicMaterial color={accent} transparent opacity={0.3} toneMapped={false} />
      </mesh>
      {/* 台座 */}
      <mesh position={[0, 0.25, 0]} castShadow>
        <cylinderGeometry args={[0.55, 0.8, 0.5, 6]} />
        <meshStandardMaterial color={look.hub.pedestal} roughness={0.5} metalness={0.3} />
      </mesh>
      <group ref={core} position={[0, 2.1, 0]}>
        <mesh ref={ico} castShadow={!lowPower}>
          <icosahedronGeometry args={[0.95, 0]} />
          <meshStandardMaterial color={accent} wireframe emissive={accent} emissiveIntensity={0.8} toneMapped={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.42, 32, 32]} />
          <meshStandardMaterial ref={orb} color={look.id === 'daylight' ? '#ffffff' : '#0b1020'} emissive={accent} emissiveIntensity={1.4} toneMapped={false} />
        </mesh>
        <mesh ref={ring1} rotation={[Math.PI / 2.4, 0, 0]}>
          <torusGeometry args={[1.35, 0.02, 8, 96]} />
          <meshBasicMaterial color={look.hub.ring2} toneMapped={false} />
        </mesh>
        <mesh ref={ring2} rotation={[0, 0, Math.PI / 3]}>
          <torusGeometry args={[1.55, 0.015, 8, 96]} />
          <meshBasicMaterial color={accent} transparent opacity={0.7} toneMapped={false} />
        </mesh>
      </group>
      <Html portal={portal as never} position={[0, 4.1, 0]} center zIndexRange={[7, 0]} style={{ pointerEvents: 'none' }}>
        <div className={`hub-card${hub.paused ? ' paused' : ''}`}>
          <span className="hub-title">
            <Icon name={hub.paused ? 'pause' : 'webhook'} size={12} /> DISPATCH HUB
          </span>
          {hub.paused ? <span className="hub-paused">キルスイッチで停止中</span> : null}
          {hub.budgetExceeded ? <span className="hub-paused">月間予算に到達 — 新規開始を保留中</span> : null}
          <span className="hub-stats">
            <span>
              待機 <b>{hub.queued}</b>
            </span>
            <span>
              実行 <b>{hub.active}</b>
            </span>
            <span>
              Webhook <b>{hub.webhooks24h}</b>
            </span>
          </span>
        </div>
      </Html>
    </group>
  );
}
