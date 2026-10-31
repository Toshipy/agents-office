/**
 * OrthographicCamera + MapControls（基本設計書 5.1 OfficeCamera / FR-010）。
 * - ズーム・パン・初期位置復元
 * - Project を選ぶとその島へ滑らかに寄る
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { MapControls } from '@react-three/drei';
import * as THREE from 'three';
import { useOffice } from '../../shared/state/office';
import { ISLAND_SIZE } from './layout';

interface MapControlsImpl {
  target: THREE.Vector3;
  update(): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

const OFFSET = new THREE.Vector3(1, 1.05, 1).normalize().multiplyScalar(80);

interface Props {
  focus: { x: number; z: number } | null;
  extent: number;
  /** 左右パネルを除いた可視領域（px） */
  viewport: { width: number; height: number; offsetX: number };
}

export function OfficeCamera({ focus, extent, viewport }: Props) {
  const controls = useRef<MapControlsImpl>(null);
  const { camera, size } = useThree();
  const anim = useRef<{ target: THREE.Vector3; zoom: number; active: boolean }>({
    target: new THREE.Vector3(),
    zoom: 20,
    active: true,
  });
  const command = useOffice((s) => s.cameraCommand);
  // E2E / 目視確認用のデバッグフック（?debug=1 のときだけ公開）
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('debug')) {
      (window as unknown as { __pawCamera: unknown }).__pawCamera = { camera, anim: anim.current, controls: controls.current };
    }
  }, [camera]);

  const fit = useMemo(() => {
    const w = Math.max(320, viewport.width);
    const h = Math.max(240, viewport.height);
    const overview = Math.min(w / (extent * 2.15), h / (extent * 1.35 + 4));
    const island = Math.min(w / (ISLAND_SIZE * 1.9), h / (ISLAND_SIZE * 1.45 + 2.5));
    return { overview, island };
  }, [viewport.width, viewport.height, extent]);

  // パネル分だけ画面中心をずらす（setViewOffset）
  useEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    if (viewport.offsetX !== 0) cam.setViewOffset(size.width, size.height, -viewport.offsetX, 0, size.width, size.height);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
  }, [camera, size.width, size.height, viewport.offsetX]);

  useEffect(() => {
    anim.current.target.set(focus ? focus.x : 0, focus ? 0.6 : 0, focus ? focus.z : 0);
    anim.current.zoom = focus ? fit.island : fit.overview;
    anim.current.active = true;
  }, [focus?.x, focus?.z, fit.island, fit.overview]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!command) return;
    const cam = camera as THREE.OrthographicCamera;
    if (command.kind === 'reset') {
      anim.current.target.set(0, 0, 0);
      anim.current.zoom = fit.overview;
    } else {
      if (controls.current) anim.current.target.copy(controls.current.target);
      anim.current.zoom = THREE.MathUtils.clamp(cam.zoom * (command.kind === 'zoomIn' ? 1.4 : 1 / 1.4), 4, 160);
    }
    anim.current.active = true;
  }, [command]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const stop = () => {
      anim.current.active = false;
    };
    c.addEventListener('start', stop);
    return () => c.removeEventListener('start', stop);
  }, []);

  useFrame((_, dt) => {
    const c = controls.current;
    const cam = camera as THREE.OrthographicCamera;
    if (!c || !anim.current.active) return;
    const k = 1 - Math.exp(-dt * 5.5);
    c.target.lerp(anim.current.target, k);
    cam.zoom = THREE.MathUtils.lerp(cam.zoom, anim.current.zoom, k);
    cam.position.copy(c.target).add(OFFSET);
    cam.updateProjectionMatrix();
    c.update();
    if (c.target.distanceTo(anim.current.target) < 0.01 && Math.abs(cam.zoom - anim.current.zoom) < 0.05) {
      anim.current.active = false;
    }
  });

  return (
    <MapControls
      ref={controls as never}
      makeDefault
      enableRotate={false}
      enableDamping
      dampingFactor={0.12}
      minZoom={4}
      maxZoom={160}
      zoomSpeed={0.9}
    />
  );
}

export const CAMERA_OFFSET = OFFSET;
