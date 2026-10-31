/**
 * 完全オリジナルのキャラクター（基本設計書 5.1 AgentAvatar）。
 * 丸いバイザーの小型ロボット。役割色のボディと、背中の状態ランプで状態を示す。
 * アニメーションは「実行中」を表すだけで、業務の成功を保証しない（基本設計書 5.2）。
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import type { AgentVisualStatus } from '@paw/contracts';
import { AGENT_STATUS_HEX } from '../../shared/ui/status';
import { mix } from './layout';

interface Props {
  roleColor: string;
  status: AgentVisualStatus;
  phase: number;
  lowPower: boolean;
}

const tmp = new THREE.Color();

export function AgentAvatar({ roleColor, status, phase, lowPower }: Props) {
  const root = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const lampMat = useRef<THREE.MeshStandardMaterial>(null);
  const tipMat = useRef<THREE.MeshStandardMaterial>(null);

  const colors = useMemo(
    () => ({
      body: mix(roleColor, '#ffffff', 0.18),
      bodyDark: mix(roleColor, '#0b1220', 0.45),
      shell: '#eef2f8',
      visor: '#0b1220',
      limb: '#cfd6e2',
    }),
    [roleColor],
  );
  const statusHex = AGENT_STATUS_HEX[status];
  // 両目で 1 つのマテリアルを共有
  const eyeMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0b1220', emissive: '#cbd5e1', emissiveIntensity: 1.5, toneMapped: false }),
    [],
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime + phase;
    const k = lowPower ? 0.5 : 1;
    if (!root.current || !torso.current || !head.current || !armL.current || !armR.current) return;
    let bob = Math.sin(t * 1.6) * 0.012;
    let headYaw = Math.sin(t * 0.5) * 0.15;
    let headPitch = 0;
    let lx = 0.55;
    let rx = 0.55;
    let rz = 0;
    let lz = 0;
    switch (status) {
      case 'working':
        lx = 1.15 + Math.sin(t * 18) * 0.12 * k;
        rx = 1.15 + Math.sin(t * 18 + 1.7) * 0.12 * k;
        headYaw = Math.sin(t * 0.8) * 0.06;
        headPitch = -0.12;
        bob = Math.sin(t * 3) * 0.008;
        break;
      case 'reviewing':
        lx = 1.0;
        rx = 0.35 + Math.sin(t * 0.9) * 0.08;
        headYaw = Math.sin(t * 0.9) * 0.45;
        headPitch = -0.08;
        break;
      case 'waiting_approval':
        rx = 2.75 + Math.sin(t * 4) * 0.12;
        rz = -0.25 + Math.sin(t * 4) * 0.25;
        lx = 0.6;
        headYaw = Math.sin(t * 1.2) * 0.2;
        headPitch = 0.12;
        bob = Math.abs(Math.sin(t * 2)) * 0.03;
        break;
      case 'completed':
        lx = 2.6 + Math.sin(t * 6) * 0.1;
        rx = 2.6 + Math.sin(t * 6 + 1) * 0.1;
        lz = 0.3;
        rz = -0.3;
        bob = Math.abs(Math.sin(t * 5)) * 0.05;
        headPitch = 0.15;
        break;
      case 'failed':
        lx = 0.2;
        rx = 0.2;
        headPitch = -0.42;
        headYaw = Math.sin(t * 0.6) * 0.05;
        bob = -0.02;
        break;
      case 'idle':
        lx = 0.5;
        rx = 0.5;
        headYaw = Math.sin(t * 0.35) * 0.35;
        break;
    }
    const damp = 0.16;
    torso.current.position.y = THREE.MathUtils.lerp(torso.current.position.y, bob, 0.3);
    head.current.rotation.y = THREE.MathUtils.lerp(head.current.rotation.y, headYaw, damp);
    head.current.rotation.x = THREE.MathUtils.lerp(head.current.rotation.x, headPitch, damp);
    armL.current.rotation.x = THREE.MathUtils.lerp(armL.current.rotation.x, lx, 0.25);
    armR.current.rotation.x = THREE.MathUtils.lerp(armR.current.rotation.x, rx, 0.25);
    armL.current.rotation.z = THREE.MathUtils.lerp(armL.current.rotation.z, lz, 0.2);
    armR.current.rotation.z = THREE.MathUtils.lerp(armR.current.rotation.z, rz, 0.2);
    const blink = status === 'working' ? 0.6 + Math.abs(Math.sin(t * 6)) * 1.4 : status === 'idle' ? 0.35 : 1.3 + Math.sin(t * 3) * 0.5;
    const eyeBlink = (Math.sin(t * 0.7) > 0.985 ? 0.1 : 1) * (status === 'idle' ? 0.8 : 1.6);
    tmp.set(status === 'idle' ? '#cbd5e1' : statusHex);
    eyeMaterial.emissive.copy(tmp);
    eyeMaterial.emissiveIntensity = eyeBlink;
    if (lampMat.current) {
      lampMat.current.emissive.set(statusHex);
      lampMat.current.emissiveIntensity = blink;
    }
    if (tipMat.current) {
      tipMat.current.emissive.set(statusHex);
      tipMat.current.emissiveIntensity = status === 'idle' ? 0.4 : 1 + Math.sin(t * 5) * 0.8;
    }
  });

  return (
    <group ref={root}>
      {/* 椅子 */}
      <group position={[0, 0, 0.08]}>
        <RoundedBox args={[0.52, 0.07, 0.5]} radius={0.03} position={[0, 0.45, 0]} castShadow>
          <meshStandardMaterial color="#2a3245" roughness={0.7} />
        </RoundedBox>
        <RoundedBox args={[0.5, 0.36, 0.06]} radius={0.03} position={[0, 0.66, 0.24]} castShadow>
          <meshStandardMaterial color="#2a3245" roughness={0.7} />
        </RoundedBox>
        <mesh position={[0, 0.23, 0]}>
          <cylinderGeometry args={[0.035, 0.035, 0.42, 8]} />
          <meshStandardMaterial color="#3b4458" metalness={0.5} roughness={0.4} />
        </mesh>
        <mesh position={[0, 0.03, 0]} receiveShadow>
          <cylinderGeometry args={[0.24, 0.26, 0.04, 16]} />
          <meshStandardMaterial color="#1f2636" />
        </mesh>
      </group>

      {/* 脚 */}
      {[-0.1, 0.1].map((x) => (
        <group key={x} position={[x, 0.52, -0.06]}>
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -0.12]} castShadow>
            <capsuleGeometry args={[0.065, 0.22, 4, 8]} />
            <meshStandardMaterial color={colors.bodyDark} roughness={0.6} />
          </mesh>
          <mesh position={[0, -0.24, -0.27]} castShadow>
            <capsuleGeometry args={[0.06, 0.3, 4, 8]} />
            <meshStandardMaterial color={colors.bodyDark} roughness={0.6} />
          </mesh>
        </group>
      ))}

      <group ref={torso}>
        {/* 胴体 */}
        <mesh position={[0, 0.86, 0]} castShadow>
          <capsuleGeometry args={[0.215, 0.26, 6, 14]} />
          <meshStandardMaterial color={colors.body} roughness={0.45} metalness={0.05} />
        </mesh>
        {/* 背中の状態ランプ（カメラ側から見える） */}
        <RoundedBox args={[0.24, 0.2, 0.08]} radius={0.03} position={[0, 0.92, 0.2]} castShadow>
          <meshStandardMaterial color={colors.shell} roughness={0.35} />
        </RoundedBox>
        <mesh position={[0, 0.92, 0.245]}>
          <boxGeometry args={[0.15, 0.045, 0.01]} />
          <meshStandardMaterial ref={lampMat} color="#111827" emissive={statusHex} emissiveIntensity={1} toneMapped={false} />
        </mesh>

        {/* 腕 */}
        <group ref={armL} position={[-0.25, 1.0, -0.02]}>
          <mesh position={[0, -0.17, 0]} castShadow>
            <capsuleGeometry args={[0.055, 0.24, 4, 8]} />
            <meshStandardMaterial color={colors.limb} roughness={0.5} />
          </mesh>
          <mesh position={[0, -0.34, 0]}>
            <sphereGeometry args={[0.065, 12, 12]} />
            <meshStandardMaterial color={colors.shell} roughness={0.4} />
          </mesh>
        </group>
        <group ref={armR} position={[0.25, 1.0, -0.02]}>
          <mesh position={[0, -0.17, 0]} castShadow>
            <capsuleGeometry args={[0.055, 0.24, 4, 8]} />
            <meshStandardMaterial color={colors.limb} roughness={0.5} />
          </mesh>
          <mesh position={[0, -0.34, 0]}>
            <sphereGeometry args={[0.065, 12, 12]} />
            <meshStandardMaterial color={colors.shell} roughness={0.4} />
          </mesh>
        </group>

        {/* 頭 */}
        <group ref={head} position={[0, 1.31, 0]}>
          <mesh castShadow>
            <sphereGeometry args={[0.25, 24, 20]} />
            <meshStandardMaterial color={colors.shell} roughness={0.3} metalness={0.05} />
          </mesh>
          <mesh position={[0, -0.01, -0.07]} scale={[0.93, 0.56, 0.75]}>
            <sphereGeometry args={[0.255, 24, 16]} />
            <meshStandardMaterial color={colors.visor} roughness={0.15} metalness={0.4} />
          </mesh>
          {[-0.075, 0.075].map((x) => (
            <mesh key={x} position={[x, 0.0, -0.255]} rotation={[0, 0, Math.PI / 2]} material={eyeMaterial}>
              <capsuleGeometry args={[0.022, 0.035, 4, 8]} />
            </mesh>
          ))}
          {/* 役割色のイヤーパーツ */}
          {[-0.25, 0.25].map((x) => (
            <mesh key={x} position={[x, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.07, 0.07, 0.05, 16]} />
              <meshStandardMaterial color={roleColor} roughness={0.4} />
            </mesh>
          ))}
          <mesh position={[0, 0.3, 0]}>
            <cylinderGeometry args={[0.012, 0.012, 0.12, 6]} />
            <meshStandardMaterial color="#94a3b8" />
          </mesh>
          <mesh position={[0, 0.37, 0]}>
            <sphereGeometry args={[0.035, 12, 12]} />
            <meshStandardMaterial ref={tipMat} color="#111827" emissive={statusHex} emissiveIntensity={1} toneMapped={false} />
          </mesh>
        </group>
      </group>
    </group>
  );
}
