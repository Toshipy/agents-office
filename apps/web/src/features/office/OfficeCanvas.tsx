/**
 * R3F Canvas（基本設計書 5.1 OfficeCanvas / OfficeScene）。
 * 3D は読み取り中心のビュー（ADR-013）。状態はサーバーのスナップショットから描く。
 */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { OfficeState } from '@paw/contracts';
import { useOffice } from '../../shared/state/office';
import { HubCore } from './HubCore';
import { FxLayer, Walkways } from './FlowLines';
import { OfficeCamera, CAMERA_OFFSET } from './OfficeCamera';
import { ProjectIsland } from './ProjectIsland';
import { islandPositions, sceneExtent } from './layout';
import { tickScreens } from './screens';
import { HtmlPortalContext } from './htmlPortal';

function ScreenTicker({ lowPower }: { lowPower: boolean }) {
  useFrame((state) => tickScreens(state.clock.elapsedTime, lowPower));
  return null;
}

function Floor() {
  const grid = useMemo(() => {
    const g = new THREE.GridHelper(160, 80, '#26304a', '#161d2e');
    const m = g.material as THREE.Material;
    m.transparent = true;
    m.opacity = 0.55;
    return g;
  }, []);
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.72, 0]} receiveShadow>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color="#0c111c" roughness={1} />
      </mesh>
      <primitive object={grid} position={[0, -0.7, 0]} />
    </>
  );
}

function Scene({ snapshot, viewport }: { snapshot: OfficeState; viewport: { width: number; height: number; offsetX: number } }) {
  const focusedProjectId = useOffice((s) => s.focusedProjectId);
  const selectedSeatKey = useOffice((s) => s.selectedSeatKey);
  const focusProject = useOffice((s) => s.focusProject);
  const selectSeat = useOffice((s) => s.selectSeat);
  const lowPower = useOffice((s) => s.lowPower);
  const projects = snapshot.projects;
  const positions = useMemo(() => islandPositions(projects.length), [projects.length]);
  const extent = useMemo(() => sceneExtent(projects.length), [projects.length]);
  const anchors = useMemo(() => projects.map((p, i) => ({ id: p.id, x: positions[i][0], z: positions[i][1] })), [projects, positions]);
  const focusIndex = projects.findIndex((p) => p.id === focusedProjectId);
  const focus = focusIndex >= 0 ? { x: positions[focusIndex][0], z: positions[focusIndex][1] } : null;
  const [zoomedIn, setZoomedIn] = useState(false);

  useFrame(({ camera }) => {
    const z = (camera as THREE.OrthographicCamera).zoom;
    const threshold = Math.min(viewport.width / 30, viewport.height / 18);
    const next = z > threshold;
    if (next !== zoomedIn) setZoomedIn(next);
  });

  return (
    <>
      <color attach="background" args={['#090d16']} />
      <ambientLight intensity={0.45} />
      <hemisphereLight args={['#c7d2fe', '#0b1019', 0.55]} />
      <directionalLight
        position={[22, 34, 14]}
        intensity={1.9}
        castShadow={!lowPower}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-34}
        shadow-camera-right={34}
        shadow-camera-top={34}
        shadow-camera-bottom={-34}
        shadow-camera-near={1}
        shadow-camera-far={120}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      <directionalLight position={[-24, 14, -18]} intensity={0.45} color="#93c5fd" />
      <Floor />
      <HubCore hub={snapshot.hub} lowPower={lowPower} />
      <Walkways projects={projects} positions={positions} />
      {projects.map((p, i) => (
        <ProjectIsland
          key={p.id}
          index={i}
          project={p}
          seats={snapshot.seats.filter((s) => s.projectId === p.id)}
          position={positions[i]}
          focused={p.id === focusedProjectId}
          anyFocused={focusedProjectId !== null}
          zoomedIn={zoomedIn || p.id === focusedProjectId}
          selectedSeatKey={selectedSeatKey}
          lowPower={lowPower}
          onFocus={focusProject}
          onSelectSeat={selectSeat}
        />
      ))}
      <FxLayer anchors={anchors} />
      <OfficeCamera focus={focus} extent={extent} viewport={viewport} />
      <ScreenTicker lowPower={lowPower} />
    </>
  );
}

export function OfficeCanvas({ snapshot, viewport }: { snapshot: OfficeState; viewport: { width: number; height: number; offsetX: number } }) {
  const lowPower = useOffice((s) => s.lowPower);
  const selectSeat = useOffice((s) => s.selectSeat);
  const [hidden, setHidden] = useState(document.hidden);
  const overlay = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  return (
    <HtmlPortalContext.Provider value={overlay}>
    <Canvas
      orthographic
      shadows={lowPower ? false : 'soft'}
      dpr={lowPower ? 1 : [1, 2]}
      frameloop={hidden ? 'never' : 'always'}
      camera={{ position: CAMERA_OFFSET.toArray() as [number, number, number], zoom: 14, near: 0.1, far: 500 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onPointerMissed={() => selectSeat(null)}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
      }}
    >
      <Suspense fallback={null}>
        <Scene snapshot={snapshot} viewport={viewport} />
      </Suspense>
    </Canvas>
    <div ref={overlay} className="html-overlay" />
    </HtmlPortalContext.Provider>
  );
}
