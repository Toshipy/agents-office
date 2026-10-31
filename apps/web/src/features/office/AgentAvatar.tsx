/**
 * 完全オリジナルのキャラクター（基本設計書 5.1 AgentAvatar）。見た目（デザイン案）ごとに 3 種類の造形を持つ。
 *  - human: 髪と肌色のある小さな人型（Night Studio）
 *  - robot: 丸いバイザーの小型ロボット。背中の状態ランプで状態を示す（Neon Control）
 *  - clay : 粘土のような丸いキャラクター（Daylight Diorama）
 * アニメーションは「実行中」を表すだけで、業務の成功を保証しない（基本設計書 5.2）。
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import type { AgentVisualStatus } from '@paw/contracts';
import { AGENT_STATUS_HEX } from '../../shared/ui/status';
import type { AvatarStyle } from '../../shared/look';
import { mix } from './layout';

interface Props {
  roleColor: string;
  status: AgentVisualStatus;
  phase: number;
  lowPower: boolean;
  style: AvatarStyle;
  chairColor: string;
}

const SKIN = ['#f1cba8', '#dba27b', '#b07a52', '#7d5537'];
const HAIR = ['#2a1c15', '#4b301e', '#141414', '#8a5a36', '#caa56c'];
const tmp = new THREE.Color();

export function AgentAvatar({ roleColor, status, phase, lowPower, style, chairColor }: Props) {
  const torso = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const lampMat = useRef<THREE.MeshStandardMaterial>(null);
  const tipMat = useRef<THREE.MeshStandardMaterial>(null);

  const pick = Math.abs(Math.round(phase * 10));
  const colors = useMemo(() => {
    if (style === 'human') {
      return {
        body: mix(roleColor, '#f4efe8', 0.35),
        legs: '#2f3340',
        limb: mix(roleColor, '#f4efe8', 0.35),
        hand: SKIN[pick % SKIN.length],
        head: SKIN[pick % SKIN.length],
        hair: HAIR[(pick + 1) % HAIR.length],
      };
    }
    if (style === 'clay') {
      const c = mix(roleColor, '#ffffff', 0.28);
      return { body: c, legs: mix(roleColor, '#5b6b80', 0.25), limb: c, hand: c, head: mix(roleColor, '#ffffff', 0.4), hair: c };
    }
    return {
      body: mix(roleColor, '#ffffff', 0.18),
      legs: mix(roleColor, '#0b1220', 0.45),
      limb: '#cfd6e2',
      hand: '#eef2f8',
      head: '#eef2f8',
      hair: '#0b1220',
    };
  }, [roleColor, style, pick]);
  const statusHex = AGENT_STATUS_HEX[status];
  // 目は 1 つのマテリアルを共有（ロボットは発光、それ以外は黒い点）
  const eyeMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: style === 'robot' ? '#0b1220' : '#151515',
        emissive: style === 'robot' ? '#cbd5e1' : '#000000',
        emissiveIntensity: style === 'robot' ? 1.5 : 0,
        roughness: 0.3,
        toneMapped: style !== 'robot',
      }),
    [style],
  );
  useEffect(() => () => eyeMaterial.dispose(), [eyeMaterial]);
  const rough = style === 'clay' ? 0.92 : style === 'human' ? 0.7 : 0.45;

  useFrame((state) => {
    const t = state.clock.elapsedTime + phase;
    const k = lowPower ? 0.5 : 1;
    if (!torso.current || !head.current || !armL.current || !armR.current) return;
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
    if (style === 'robot') {
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
    }
  });

  const torsoArgs: [number, number, number, number] = style === 'clay' ? [0.25, 0.2, 6, 16] : style === 'human' ? [0.19, 0.28, 6, 14] : [0.215, 0.26, 6, 14];
  const headR = style === 'clay' ? 0.27 : style === 'human' ? 0.21 : 0.25;
  const headY = style === 'clay' ? 1.3 : style === 'human' ? 1.29 : 1.31;

  return (
    <group>
      {/* 椅子 */}
      <group position={[0, 0, 0.08]}>
        <RoundedBox args={[0.52, 0.07, 0.5]} radius={0.03} position={[0, 0.45, 0]} castShadow>
          <meshStandardMaterial color={chairColor} roughness={0.7} />
        </RoundedBox>
        <RoundedBox args={[0.5, 0.36, 0.06]} radius={0.03} position={[0, 0.66, 0.24]} castShadow>
          <meshStandardMaterial color={chairColor} roughness={0.7} />
        </RoundedBox>
        <mesh position={[0, 0.23, 0]}>
          <cylinderGeometry args={[0.035, 0.035, 0.42, 8]} />
          <meshStandardMaterial color="#3b4458" metalness={0.5} roughness={0.4} />
        </mesh>
        <mesh position={[0, 0.03, 0]} receiveShadow>
          <cylinderGeometry args={[0.24, 0.26, 0.04, 16]} />
          <meshStandardMaterial color={mix(chairColor, '#000000', 0.25)} />
        </mesh>
      </group>

      {/* 脚 */}
      {[-0.1, 0.1].map((x) => (
        <group key={x} position={[x, 0.52, -0.06]}>
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -0.12]} castShadow>
            <capsuleGeometry args={[0.065, 0.22, 4, 8]} />
            <meshStandardMaterial color={colors.legs} roughness={rough} />
          </mesh>
          <mesh position={[0, -0.24, -0.27]} castShadow>
            <capsuleGeometry args={[0.06, 0.3, 4, 8]} />
            <meshStandardMaterial color={colors.legs} roughness={rough} />
          </mesh>
        </group>
      ))}

      <group ref={torso}>
        {/* 胴体 */}
        <mesh position={[0, style === 'clay' ? 0.88 : 0.86, 0]} castShadow>
          <capsuleGeometry args={torsoArgs} />
          <meshStandardMaterial color={colors.body} roughness={rough} metalness={style === 'robot' ? 0.05 : 0} />
        </mesh>
        {style === 'robot' ? (
          <>
            {/* 背中の状態ランプ（カメラ側から見える） */}
            <RoundedBox args={[0.24, 0.2, 0.08]} radius={0.03} position={[0, 0.92, 0.2]} castShadow>
              <meshStandardMaterial color="#eef2f8" roughness={0.35} />
            </RoundedBox>
            <mesh position={[0, 0.92, 0.245]}>
              <boxGeometry args={[0.15, 0.045, 0.01]} />
              <meshStandardMaterial ref={lampMat} color="#111827" emissive={statusHex} emissiveIntensity={1} toneMapped={false} />
            </mesh>
          </>
        ) : null}
        {style === 'human' ? (
          // 襟
          <mesh position={[0, 1.1, 0]}>
            <torusGeometry args={[0.11, 0.025, 8, 20]} />
            <meshStandardMaterial color={mix(colors.body, '#ffffff', 0.4)} roughness={0.8} />
          </mesh>
        ) : null}

        {/* 腕 */}
        {[
          { ref: armL, x: -(torsoArgs[0] + 0.04) },
          { ref: armR, x: torsoArgs[0] + 0.04 },
        ].map(({ ref, x }) => (
          <group key={x} ref={ref} position={[x, 1.0, -0.02]}>
            <mesh position={[0, -0.17, 0]} castShadow>
              <capsuleGeometry args={[style === 'clay' ? 0.07 : 0.055, style === 'clay' ? 0.16 : 0.24, 4, 8]} />
              <meshStandardMaterial color={colors.limb} roughness={rough} />
            </mesh>
            {style !== 'clay' ? (
              <mesh position={[0, -0.34, 0]}>
                <sphereGeometry args={[0.065, 12, 12]} />
                <meshStandardMaterial color={colors.hand} roughness={rough} />
              </mesh>
            ) : null}
          </group>
        ))}

        {/* 頭 */}
        <group ref={head} position={[0, headY, 0]}>
          <mesh castShadow>
            <sphereGeometry args={[headR, 24, 20]} />
            <meshStandardMaterial color={colors.head} roughness={style === 'robot' ? 0.3 : rough} metalness={style === 'robot' ? 0.05 : 0} />
          </mesh>
          {style === 'robot' ? (
            <>
              <mesh position={[0, -0.01, -0.07]} scale={[0.93, 0.56, 0.75]}>
                <sphereGeometry args={[0.255, 24, 16]} />
                <meshStandardMaterial color="#0b1220" roughness={0.15} metalness={0.4} />
              </mesh>
              {[-0.075, 0.075].map((x) => (
                <mesh key={x} position={[x, 0.0, -0.255]} rotation={[0, 0, Math.PI / 2]} material={eyeMaterial}>
                  <capsuleGeometry args={[0.022, 0.035, 4, 8]} />
                </mesh>
              ))}
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
            </>
          ) : null}
          {style === 'human' ? (
            <>
              {/* 髪（後頭部と頭頂を覆う） */}
              <mesh position={[0, 0.045, 0.035]} scale={[1.06, 0.92, 1.06]} castShadow>
                <sphereGeometry args={[headR, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.62]} />
                <meshStandardMaterial color={colors.hair} roughness={0.85} />
              </mesh>
              {pick % 3 === 0 ? (
                <mesh position={[0, 0.02, 0.2]}>
                  <sphereGeometry args={[0.075, 12, 12]} />
                  <meshStandardMaterial color={colors.hair} roughness={0.85} />
                </mesh>
              ) : null}
              {[-0.07, 0.07].map((x) => (
                <mesh key={x} position={[x, -0.01, -0.195]} material={eyeMaterial}>
                  <sphereGeometry args={[0.022, 10, 10]} />
                </mesh>
              ))}
              {[-0.205, 0.205].map((x) => (
                <mesh key={x} position={[x, -0.02, 0]}>
                  <sphereGeometry args={[0.045, 10, 10]} />
                  <meshStandardMaterial color={colors.head} roughness={0.7} />
                </mesh>
              ))}
            </>
          ) : null}
          {style === 'clay' ? (
            <>
              {[-0.085, 0.085].map((x) => (
                <mesh key={x} position={[x, 0.02, -0.252]} material={eyeMaterial}>
                  <sphereGeometry args={[0.03, 12, 12]} />
                </mesh>
              ))}
              {[-0.15, 0.15].map((x) => (
                <mesh key={x} position={[x, -0.06, -0.215]} scale={[1, 0.7, 0.5]}>
                  <sphereGeometry args={[0.045, 12, 12]} />
                  <meshStandardMaterial color="#ff9fae" roughness={0.9} />
                </mesh>
              ))}
              {/* 頭頂の小さな芽（役割色） */}
              <mesh position={[0, headR + 0.03, 0]} rotation={[0, 0, 0.4]}>
                <capsuleGeometry args={[0.03, 0.07, 4, 8]} />
                <meshStandardMaterial color={mix(roleColor, '#000000', 0.15)} roughness={0.9} />
              </mesh>
            </>
          ) : null}
        </group>
      </group>
    </group>
  );
}
