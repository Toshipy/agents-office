/**
 * 見た目（デザイン案）の切り替え。3D シーンの素材・照明・キャラクターの造形と、
 * パネルの CSS トークン（:root[data-look=...]）をまとめて切り替える。
 */
import { create } from 'zustand';

export type LookId = 'studio' | 'neon' | 'daylight';
export type AvatarStyle = 'human' | 'robot' | 'clay';

export interface OfficeLook {
  id: LookId;
  label: string;
  name: string;
  tagline: string;
  background: string;
  floor: string;
  gridMajor: string;
  gridMinor: string;
  gridOpacity: number;
  ambient: number;
  hemiSky: string;
  hemiGround: string;
  hemi: number;
  sun: string;
  sunIntensity: number;
  rim: string;
  rimIntensity: number;
  exposure: number;
  island: {
    top: [string, number];
    inner: [string, number];
    innerOpacity: number;
    side: [string, number];
    edgeGlow: number;
    borderOpacity: number;
    borderWidth: number;
  };
  desk: { top: string; leg: string; monitor: string; keyboard: string };
  chair: string;
  avatar: AvatarStyle;
  hub: { base: string; top: string; accent: string; ring2: string; pedestal: string };
  walkway: string;
  walkwayIdleLine: string;
}

export const LOOKS: Record<LookId, OfficeLook> = {
  studio: {
    id: 'studio',
    label: 'A',
    name: 'Night Studio',
    tagline: '夜のスタジオ。くすんだパステルの島、木目の机、人型のスタッフ。動画に最も近い落ち着いた雰囲気',
    background: '#15141c',
    floor: '#1a1922',
    gridMajor: '#2b2937',
    gridMinor: '#201e2a',
    gridOpacity: 0.6,
    ambient: 0.5,
    hemiSky: '#f3e6d0',
    hemiGround: '#16141c',
    hemi: 0.5,
    sun: '#ffe9c9',
    sunIntensity: 1.75,
    rim: '#9aa7ff',
    rimIntensity: 0.35,
    exposure: 1.0,
    island: {
      top: ['#d6cfc9', 0.4],
      inner: ['#efe8e0', 0.55],
      innerOpacity: 0.35,
      side: ['#1c1a24', 0.62],
      edgeGlow: 0.05,
      borderOpacity: 0.3,
      borderWidth: 1.1,
    },
    desk: { top: '#e7d6b8', leg: '#2b2933', monitor: '#1d1c24', keyboard: '#d8d0c3' },
    chair: '#3b3745',
    avatar: 'human',
    hub: { base: '#201e29', top: '#27242f', accent: '#e2b45a', ring2: '#b4a6f5', pedestal: '#2f2b38' },
    walkway: '#201e29',
    walkwayIdleLine: '#5a5468',
  },
  neon: {
    id: 'neon',
    label: 'B',
    name: 'Neon Control（採用）',
    tagline: '管制室。半透明の島がプロジェクト色に発光し、ロボットが働く。情報量の多い HUD',
    background: '#05070d',
    floor: '#070b14',
    gridMajor: '#14385a',
    gridMinor: '#0b1c2e',
    gridOpacity: 0.85,
    ambient: 0.32,
    hemiSky: '#8fb8ff',
    hemiGround: '#05070d',
    hemi: 0.45,
    sun: '#c4d8ff',
    sunIntensity: 1.25,
    rim: '#ff4fd8',
    rimIntensity: 0.55,
    exposure: 1.1,
    island: {
      top: ['#0e1626', 0.84],
      inner: ['#0b1222', 0.6],
      innerOpacity: 0.55,
      side: ['#080d18', 0.86],
      edgeGlow: 0.85,
      borderOpacity: 1,
      borderWidth: 2.4,
    },
    desk: { top: '#18213a', leg: '#0b1020', monitor: '#060a12', keyboard: '#22304a' },
    chair: '#131b2c',
    avatar: 'robot',
    hub: { base: '#0c1220', top: '#111a2c', accent: '#38e1ff', ring2: '#ff4fd8', pedestal: '#162036' },
    walkway: '#0a101c',
    walkwayIdleLine: '#1f4a6b',
  },
  daylight: {
    id: 'daylight',
    label: 'C',
    name: 'Daylight Diorama',
    tagline: '昼の模型。明るい光と柔らかい影、粘土のようなキャラクター。ライトテーマの UI',
    background: '#dfe6ee',
    floor: '#e3e9f0',
    gridMajor: '#c8d1dc',
    gridMinor: '#d5dce5',
    gridOpacity: 0.9,
    ambient: 0.72,
    hemiSky: '#ffffff',
    hemiGround: '#c5cfdb',
    hemi: 0.7,
    sun: '#fff3df',
    sunIntensity: 2.1,
    rim: '#bcd7ff',
    rimIntensity: 0.3,
    exposure: 1.0,
    island: {
      top: ['#ffffff', 0.22],
      inner: ['#ffffff', 0.62],
      innerOpacity: 0.5,
      side: ['#ffffff', 0.34],
      edgeGlow: 0,
      borderOpacity: 0.55,
      borderWidth: 1.4,
    },
    desk: { top: '#fbfcfe', leg: '#cdb998', monitor: '#2b3442', keyboard: '#e4e9ef' },
    chair: '#93a6bb',
    avatar: 'clay',
    hub: { base: '#eef2f7', top: '#ffffff', accent: '#4f6bff', ring2: '#ff8a5b', pedestal: '#dfe5ee' },
    walkway: '#d3dbe5',
    walkwayIdleLine: '#a9b6c6',
  },
};

export const LOOK_IDS: LookId[] = ['studio', 'neon', 'daylight'];

function readLook(): LookId {
  try {
    const h = window.location.hash.replace('#', '');
    if ((LOOK_IDS as string[]).includes(h)) return h as LookId;
    const v = localStorage.getItem('paw.look.v2');
    if (v && (LOOK_IDS as string[]).includes(v)) return v as LookId;
  } catch {
    /* ignore */
  }
  // 採用案: B Neon Control（A / C は設定画面から比較用に切り替え可能）
  return 'neon';
}

export const useLook = create<{ id: LookId; setLook(id: LookId): void }>((set) => ({
  id: readLook(),
  setLook: (id) => {
    try {
      localStorage.setItem('paw.look.v2', id);
    } catch {
      /* ignore */
    }
    set({ id });
  },
}));

export function useOfficeLook(): OfficeLook {
  return LOOKS[useLook((s) => s.id)];
}
