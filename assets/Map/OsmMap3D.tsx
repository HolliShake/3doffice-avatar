// components/threeD/OsmMap3D.tsx
'use client';

import { AdaptiveDpr, Billboard, OrbitControls, Text } from '@react-three/drei';
import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

import { assembleMultipolygon } from '@/lib/osm-multipolygon';
import {
  type LatLon,
  type OsmDocument,
  type OsmNode,
  type OsmRelation,
  type OsmWay,
  parseOsm,
  type Tags,
} from './osm-parser';
import {
  altNames,
  bestName,
  formatAddress,
  isAnnotationOnly,
  parseNamespacedTags,
  splitTag,
} from '@/lib/osm-tags';

/* ============================================================
 * PERFORMANCE NOTES
 *  - All static geometry (roads, parks, water, barriers, steps, flowerbeds,
 *    parking spaces, canopies, multipolygons, buildings, rooftop props, point
 *    features) is merged / instanced: a few dozen draw calls, not thousands.
 *  - Point features are instanced per (feature, tag-variant), so tag-driven
 *    variants (bench material, lamp type, ...) cost one draw call per variant.
 *  - Linear barriers (fences, walls, hedges, guard rails, handrails) are merged
 *    per colour into one mesh each; steps are generated procedurally.
 *  - Buildings are merged per kind; hover/click is resolved by triangle index
 *    (binary search), and highlight is a single overlay mesh.
 *  - Every way is resolved + projected exactly once (scene.wayXY).
 *  - Spatial hash grids (grass scattering, road/wall alignment of speed bumps
 *    and doors) are built lazily and only when needed.
 *  - Flowers (flowerbeds) are a single instanced mesh with per-instance colour.
 *  - frameloop is "demand" unless an animated flag exists.
 *  - Parent callbacks are held in refs, so inline callbacks don't re-parse.
 * ============================================================ */

/* ============================================================
 * 0. PUBLIC PROPS
 * ============================================================ */

export type Ambiance = 'day' | 'night';

export interface BuildingClickInfo {
  id: number;
  lat: number;
  lon: number;
  name?: string;
  address?: string;
  height: number;
  kind: BuildingKind;
  tags: Tags;
}

export const OSM3D_BUILDING_CLICK_EVENT = 'osm3d:building-click';

export interface OsmMap3DProps {
  src?: string;
  xml?: string | null;
  label: string;
  className?: string;
  isLoading: boolean;
  zoom?: number;
  labels?: boolean;
  /**
   * Visual ambiance. `'day'` (default) uses bright daylight; `'night'` dims
   * the scene, swaps the sky for a starfield and turns on lamps / emissive
   * point features (street lamps, etc.).
   */
  ambiance?: Ambiance;
  /**
   * Optional geographic center of interest.
   *  - If provided and the coordinate falls inside a building, the camera
   *    focuses that building.
   *  - Otherwise (null / outside any building / no scene), the default
   *    camera center (extent centroid) is used.
   */
  center?: LatLon | null;
  onLoad?: (doc: OsmDocument) => void;
  onError?: (err: Error) => void;
  onBuildingClick?: (info: BuildingClickInfo | null) => void;
}

/* ============================================================
 * 0b. AMBIANCE CONTEXT
 * ============================================================ */

const AmbianceContext = createContext<Ambiance>('day');
const useAmbiance = (): Ambiance => useContext(AmbianceContext);

/* ============================================================
 * 1. TYPES
 * ============================================================ */

type XY = [number, number];
type V3 = [number, number, number];
type Projection = (ll: LatLon) => XY;
interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  r: number;
}
/** [x, z, colour index] */
type Flower = [number, number, number];

type WayKind =
  | 'building'
  | 'canopy'
  | 'road'
  | 'footway'
  | 'parking'
  | 'park'
  | 'water'
  | 'wall'
  | 'rail'
  | 'landuse'
  | 'power_line'
  | 'steps'
  | 'barrier'
  | 'tree_row'
  | 'flowerbed'
  | 'parking_space'
  | 'ignore';

type NodeKind =
  | 'tree'
  | 'bench'
  | 'chair'
  | 'desk'
  | 'table'
  | 'statue'
  | 'monument'
  | 'fire_hydrant'
  | 'flagpole'
  | 'tower'
  | 'water_tower'
  | 'atm'
  | 'bank'
  | 'shop'
  | 'grocery'
  | 'cafe'
  | 'restaurant'
  | 'fast_food'
  | 'toilet'
  | 'shed'
  | 'shelter'
  | 'waste_basket'
  | 'waste_disposal'
  | 'drinking_water'
  | 'recycling'
  | 'street_lamp'
  | 'power_pole'
  | 'power_tower'
  | 'gate'
  | 'lift_gate'
  | 'info_board'
  | 'guidepost'
  | 'bicycle_parking'
  | 'motorcycle_parking'
  | 'parking_entrance'
  | 'vending'
  | 'fountain'
  | 'clock'
  | 'phone'
  | 'post_box'
  | 'traffic_signals'
  | 'bus_stop'
  | 'crossing'
  | 'lounger'
  | 'planter'
  | 'bollard'
  | 'turnstile'
  | 'bicycle_repair_station'
  | 'cyclist_waiting_aid'
  | 'parking_space'
  | 'parking_meter'
  | 'trolley_bay'
  | 'speed_bump'
  | 'manhole'
  | 'street_cabinet'
  | 'defibrillator'
  | 'first_aid_kit'
  | 'fire_alarm'
  | 'surveillance'
  | 'water_tank'
  | 'air_conditioner'
  | 'notice_board'
  | 'milestone'
  | 'flower'
  | 'elevator'
  | 'locker'
  | 'door'
  | 'generic'
  | 'ignore';

export type BuildingKind =
  | 'academic'
  | 'sports'
  | 'office'
  | 'construction'
  | 'shed'
  | 'monument'
  | 'cafeteria'
  | 'residential'
  | 'utility';

type ParseState =
  | { status: 'idle' }
  | { status: 'parsing' }
  | { status: 'ready'; doc: OsmDocument }
  | { status: 'error'; error: Error };

/* ============================================================
 * 2. MODULE-SCOPED SINGLETONS + SMALL UTILITIES
 * ============================================================ */

const toonGradient = (() => {
  const data = new Uint8Array([80, 150, 210, 255]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
})();

let _skyTexture: THREE.CanvasTexture | null = null;
function getSkyTexture(): THREE.CanvasTexture {
  if (_skyTexture) return _skyTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  (
    [
      [0.0, '#5ea9e6'],
      [0.35, '#9fd0f0'],
      [0.62, '#ffe0b0'],
      [0.8, '#ffc88a'],
      [1.0, '#e6c9a0'],
    ] as const
  ).forEach(([o, c]) => g.addColorStop(o, c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 512);
  _skyTexture = new THREE.CanvasTexture(canvas);
  _skyTexture.colorSpace = THREE.SRGBColorSpace;
  return _skyTexture;
}

let _nightSkyTexture: THREE.CanvasTexture | null = null;
function getNightSkyTexture(): THREE.CanvasTexture {
  if (_nightSkyTexture) return _nightSkyTexture;
  const W = 1024;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const g = ctx.createLinearGradient(0, 0, 0, H);
  (
    [
      [0.0, '#050a1e'],
      [0.3, '#0b1430'],
      [0.6, '#1a2450'],
      [0.85, '#2a3565'],
      [1.0, '#3a4575'],
    ] as const
  ).forEach(([o, c]) => g.addColorStop(o, c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Stars: denser / brighter near the top.
  const rng = seededRand(0x5eed);
  const stars = 900;
  for (let i = 0; i < stars; i++) {
    const x = rng() * W;
    // bias towards upper hemisphere (v small)
    const y = Math.pow(rng(), 1.6) * H * 0.75;
    const r = rng() * 0.9 + 0.25;
    const a = 0.25 + rng() * 0.7;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // A soft moon.
  const mx = W * 0.72;
  const my = H * 0.22;
  const moonG = ctx.createRadialGradient(mx, my, 2, mx, my, 60);
  moonG.addColorStop(0, 'rgba(255,255,240,0.95)');
  moonG.addColorStop(0.25, 'rgba(240,240,220,0.35)');
  moonG.addColorStop(1, 'rgba(240,240,220,0)');
  ctx.fillStyle = moonG;
  ctx.beginPath();
  ctx.arc(mx, my, 60, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(248,248,235,0.95)';
  ctx.beginPath();
  ctx.arc(mx, my, 16, 0, Math.PI * 2);
  ctx.fill();

  _nightSkyTexture = new THREE.CanvasTexture(canvas);
  _nightSkyTexture.colorSpace = THREE.SRGBColorSpace;
  return _nightSkyTexture;
}

const noRaycast = () => undefined;
const EMPTY: readonly never[] = [];

const boundsOf = (pts: readonly XY[]): Box =>
  pts.reduce<Box>(
    (b, [x, z]) => ({
      minX: Math.min(b.minX, x),
      maxX: Math.max(b.maxX, x),
      minZ: Math.min(b.minZ, z),
      maxZ: Math.max(b.maxZ, z),
    }),
    { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }
  );

const isFiniteXY = ([x, z]: XY) => Number.isFinite(x) && Number.isFinite(z);

/** Memoised thunk: the work runs once, on first use. */
const lazy = <T,>(f: () => T) => {
  let done = false;
  let v: T;
  return () => {
    if (!done) {
      v = f();
      done = true;
    }
    return v;
  };
};

const firstNum = (v: string | undefined): number => parseFloat(splitTag(v)[0] ?? v ?? '');

const clampInt = (v: string | undefined, lo: number, hi: number, d: number): number => {
  const n = parseInt(splitTag(v)[0] ?? v ?? '', 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/* ============================================================
 * 3. BUILDING PALETTE + OSM MAPPING
 * ============================================================ */

interface PaletteEntry {
  wall: string;
  roof: string;
  accent: string;
  height: number;
}

const PALETTE: Record<BuildingKind, PaletteEntry> = {
  academic: { wall: '#b8e0ff', roof: '#3c6ec9', accent: '#ffe066', height: 6 },
  sports: { wall: '#ffd6a0', roof: '#e8683a', accent: '#ff5e5e', height: 6 },
  office: { wall: '#e0c8ff', roof: '#7a3fc4', accent: '#ffd93d', height: 8 },
  construction: { wall: '#fff4a8', roof: '#d99b1f', accent: '#ff8c42', height: 5 },
  shed: { wall: '#e8e0d0', roof: '#a87858', accent: '#ffb347', height: 2.5 },
  monument: { wall: '#f8e0c0', roof: '#c89060', accent: '#ffd700', height: 5 },
  cafeteria: { wall: '#ffc8dc', roof: '#e64a7c', accent: '#ffe066', height: 3.5 },
  residential: { wall: '#ffd8b0', roof: '#c8553d', accent: '#ffb347', height: 4.5 },
  utility: { wall: '#c0e8e0', roof: '#3a8c8c', accent: '#ffd93d', height: 3.5 },
};

const MAX_BUILDING_HEIGHT = 40;
const MAX_BUILDING_LABELS = 120;
const MAX_FEATURE_LABELS = 100;
const MAX_FLOWERS = 8000;
const FLOWER_COLORS = ['#ff6b9a', '#ffd93d', '#ffffff', '#b48cff', '#ff8c42', '#ff5e5e'].map(
  (c) => new THREE.Color(c)
);

const NON_BUILDING_VALUES = new Set([
  'no',
  'proposed',
  'ruins',
  'collapsed',
  'demolished',
  'destroyed',
  'razed',
  'removed',
  'abandoned',
  'disused',
]);

const KIND_GROUPS: readonly (readonly [BuildingKind, readonly string[]])[] = [
  [
    'residential',
    [
      'house',
      'detached',
      'semidetached',
      'terrace',
      'apartments',
      'residential',
      'dormitory',
      'bungalow',
      'cabin',
    ],
  ],
  [
    'academic',
    ['school', 'university', 'college', 'kindergarten', 'library', 'hospital', 'clinic'],
  ],
  [
    'office',
    [
      'office',
      'commercial',
      'retail',
      'supermarket',
      'mall',
      'kiosk',
      'civic',
      'government',
      'public',
    ],
  ],
  [
    'monument',
    ['church', 'cathedral', 'chapel', 'mosque', 'temple', 'synagogue', 'shrine', 'monastery'],
  ],
  ['construction', ['industrial', 'warehouse', 'factory', 'hangar', 'manufacture', 'construction']],
  ['shed', ['shed', 'hut', 'garage', 'garages', 'carport', 'greenhouse']],
  ['sports', ['sports_hall', 'stadium', 'gym', 'pavilion', 'grandstand']],
  ['cafeteria', ['restaurant', 'cafe', 'fast_food', 'food_court']],
  ['utility', ['service', 'transformer_tower', 'water_tower', 'storage_tank', 'silo']],
];

const KIND_BY_VALUE = new Map<string, BuildingKind>(
  KIND_GROUPS.flatMap(([k, vs]) => vs.map((v) => [v, k] as const))
);

function osmBuildingKind(tags: Tags): BuildingKind {
  const hit = KIND_BY_VALUE.get((tags.building ?? 'yes').toLowerCase());
  if (hit) return hit;
  const leisure = tags.leisure;
  return leisure === 'sports_centre' || leisure === 'stadium' || leisure === 'pitch'
    ? 'sports'
    : 'office';
}

function resolveBuildingHeight(tags: Tags, kind: BuildingKind): number {
  const heightRaw = splitTag(tags.height)[0] ?? tags.height;
  if (heightRaw) {
    const h = parseFloat(heightRaw);
    if (isFinite(h) && h > 0) return Math.min(h, MAX_BUILDING_HEIGHT);
  }
  const levelsRaw = splitTag(tags['building:levels'])[0] ?? tags['building:levels'];
  if (levelsRaw) {
    const lv = parseFloat(levelsRaw);
    if (isFinite(lv) && lv > 0) return Math.min(lv * 3.0, MAX_BUILDING_HEIGHT);
  }
  return PALETTE[kind].height;
}

/* ============================================================
 * 4. PROJECTION / GEOMETRY
 * ============================================================ */

const M_PER_DEG_LAT = 111_320;

function makeProjection(center: LatLon): Projection {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180);
  return (ll) => [(ll.lon - center.lon) * mPerDegLon, -(ll.lat - center.lat) * M_PER_DEG_LAT];
}

function unproject(xy: XY, center: LatLon): LatLon {
  const cos = Math.cos((center.lat * Math.PI) / 180);
  const mPerDegLon = M_PER_DEG_LAT * (Math.abs(cos) < 1e-6 ? 1e-6 : cos);
  return { lat: center.lat - xy[1] / M_PER_DEG_LAT, lon: center.lon + xy[0] / mPerDegLon };
}

function shadeHex(hex: string, dl: number): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l + dl, 0, 1));
  return `#${c.getHexString()}`;
}

function seededRand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function computeDocCenter(doc: OsmDocument): LatLon {
  if (doc.bounds) {
    return {
      lat: (doc.bounds.minLat + doc.bounds.maxLat) / 2,
      lon: (doc.bounds.minLon + doc.bounds.maxLon) / 2,
    };
  }
  const pts = doc.nodes.filter((n) => n.lat !== undefined && n.lon !== undefined);
  if (pts.length === 0) return { lat: 0, lon: 0 };
  const sum = pts.reduce((a, n) => ({ lat: a.lat + n.lat!, lon: a.lon + n.lon! }), {
    lat: 0,
    lon: 0,
  });
  return { lat: sum.lat / pts.length, lon: sum.lon / pts.length };
}

function resolveWayPath(way: OsmWay, nodeMap: Map<number, OsmNode>): LatLon[] | null {
  const geom = way.geometry;
  const aligned = geom !== undefined && geom.length === way.nodeRefs.length;

  if (way.nodeRefs.length === 0 && geom) {
    return geom.every(Boolean) ? geom.map((g) => ({ lat: g!.lat, lon: g!.lon })) : null;
  }

  const pts: LatLon[] = [];
  for (let i = 0; i < way.nodeRefs.length; i++) {
    const n = nodeMap.get(way.nodeRefs[i]!);
    if (n && n.lat !== undefined && n.lon !== undefined) {
      pts.push({ lat: n.lat, lon: n.lon });
    } else if (aligned && geom![i]) {
      pts.push({ lat: geom![i]!.lat, lon: geom![i]!.lon });
    } else {
      return null;
    }
  }
  return pts;
}

const latLonPathToXY = (path: LatLon[], projection: Projection): XY[] => path.map(projection);

function centroid(pts: XY[]): XY {
  const s = pts.reduce<XY>((a, [x, z]) => [a[0] + x, a[1] + z], [0, 0]);
  return [s[0] / pts.length, s[1] / pts.length];
}

function polygonArea(pts: XY[]): number {
  const a = pts.reduce((acc, p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length]!;
    return acc + q[0] * p[1] - p[0] * q[1];
  }, 0);
  return Math.abs(a) / 2;
}

function isClosedPath(path: LatLon[]): boolean {
  if (path.length < 4) return false;
  const a = path[0]!;
  const b = path[path.length - 1]!;
  return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
}

function convexHull(points: XY[]): XY[] {
  const pts = points.filter(isFiniteXY).sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (pts.length < 3) return pts;
  const cross = (o: XY, a: XY, b: XY) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (seq: XY[]) =>
    seq.reduce<XY[]>((h, p) => {
      while (h.length >= 2 && cross(h[h.length - 2]!, h[h.length - 1]!, p) <= 0) h.pop();
      h.push(p);
      return h;
    }, []);
  const lower = chain(pts);
  const upper = chain(pts.slice().reverse());
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function paddedHull(points: XY[], pad: number): XY[] {
  const base = convexHull(points);
  if (base.length < 3) return base;
  const grown = base.flatMap(([x, z]) =>
    Array.from({ length: 12 }, (_, k): XY => {
      const a = (k / 12) * Math.PI * 2;
      return [x + Math.cos(a) * pad, z + Math.sin(a) * pad];
    })
  );
  return convexHull(grown);
}

function cleanRing(pts: XY[]): XY[] {
  const clean = pts.filter(isFiniteXY).reduce<XY[]>((acc, p) => {
    const last = acc[acc.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-4) acc.push(p);
    return acc;
  }, []);
  if (clean.length > 1) {
    const first = clean[0]!;
    const last = clean[clean.length - 1]!;
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-4) clean.pop();
  }
  return clean;
}

function shapeFrom(pts: XY[], cx: number, cz: number): THREE.Shape {
  const shape = new THREE.Shape();
  pts.forEach(([x, z], i) => {
    const px = x - cx;
    const py = -(z - cz);
    if (i === 0) shape.moveTo(px, py);
    else shape.lineTo(px, py);
  });
  shape.closePath();
  return shape;
}

function buildExtrudedPolygon(pts: XY[], height: number) {
  if (pts.length < 3) return null;
  const [cx, cz] = centroid(pts);
  const geometry = new THREE.ExtrudeGeometry(shapeFrom(pts, cx, cz), {
    depth: height,
    bevelEnabled: false,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.computeVertexNormals();
  return { geometry, cx, cz };
}

function buildFlatPolygon(pts: XY[]) {
  if (pts.length < 3) return null;
  const [cx, cz] = centroid(pts);
  const geometry = new THREE.ShapeGeometry(shapeFrom(pts, cx, cz));
  geometry.rotateX(-Math.PI / 2);
  return { geometry, cx, cz };
}

function buildRibbon(pts: XY[], width: number, period = 8) {
  if (pts.length < 2) return null;
  const half = width / 2;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i]!;
    const prev = pts[Math.max(i - 1, 0)]!;
    const next = pts[Math.min(i + 1, pts.length - 1)]!;
    const dx = next[0] - prev[0];
    const dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    positions.push(x + nx * half, 0, z + nz * half, x - nx * half, 0, z - nz * half);
    uvs.push(0, cumulative / period, 1, cumulative / period);
    if (i > 0) {
      const a = (i - 1) * 2;
      indices.push(a, i * 2, a + 1, a + 1, i * 2, i * 2 + 1);
    }
    if (i < pts.length - 1) cumulative += Math.hypot(next[0] - x, next[1] - z);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

function buildBuildingGeometry(ring: XY[], height: number) {
  const clean = cleanRing(ring);
  if (clean.length < 3) return null;
  try {
    return buildExtrudedPolygon(clean, height);
  } catch {
    return null;
  }
}

/* ---------- vertical strips (fences, walls, hedges, rails, stair treads) ---------- */

/**
 * Extrudes a polyline into a vertical strip of the given thickness spanning
 * y ∈ [base, top]. Non-indexed, with position / normal / uv so it merges with
 * every other layer geometry. `caps` closes the two ends (used for stair treads).
 */
function buildWallStrip(
  pts: XY[],
  top: number,
  thick: number,
  base = 0,
  caps = false
): THREE.BufferGeometry | null {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const h = thick / 2;
  const tri = (a: V3, b: V3, c: V3, n: V3) => {
    for (const p of [a, b, c]) {
      pos.push(p[0], p[1], p[2]);
      nor.push(n[0], n[1], n[2]);
      uv.push(0, 0);
    }
  };
  const quad = (a: V3, b: V3, c: V3, d: V3, n: V3) => {
    tri(a, b, c, n);
    tri(a, c, d, n);
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i]!;
    const [bx, bz] = pts[i + 1]!;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    const ux = dx / len;
    const uz = dz / len;
    const nx = -uz;
    const nz = ux;
    const a1: XY = [ax + nx * h, az + nz * h];
    const a2: XY = [ax - nx * h, az - nz * h];
    const b1: XY = [bx + nx * h, bz + nz * h];
    const b2: XY = [bx - nx * h, bz - nz * h];
    const P = (p: XY, y: number): V3 => [p[0], y, p[1]];
    quad(P(a1, top), P(b1, top), P(b2, top), P(a2, top), [0, 1, 0]);
    quad(P(a1, base), P(b1, base), P(b1, top), P(a1, top), [nx, 0, nz]);
    quad(P(a2, base), P(b2, base), P(b2, top), P(a2, top), [-nx, 0, -nz]);
    if (caps) {
      quad(P(a1, base), P(a2, base), P(a2, top), P(a1, top), [-ux, 0, -uz]);
      quad(P(b1, base), P(b2, base), P(b2, top), P(b1, top), [ux, 0, uz]);
    }
  }
  if (pos.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

function pathLength(pts: XY[]): number {
  let l = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    l += Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
  }
  return l;
}

/** Point at distance `d` along a polyline (clamped to its end). */
function pointAt(pts: XY[], d: number): XY {
  let rem = d;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (rem <= l || i === pts.length - 2) {
      const t = l > 0 ? Math.min(1, rem / l) : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    rem -= l;
  }
  return pts[0]!;
}

/** Barrier look, driven by `barrier=*`, `fence_type`, `material` and `height`. */
function barrierSpec(tags: Tags): { color: string; top: number; base: number; t: number } {
  const hv = firstNum(tags.height);
  const H = (d: number) => (Number.isFinite(hv) && hv > 0.2 ? Math.min(hv, 8) : d);
  const mat = tags.fence_type ?? tags.material ?? '';
  switch (tags.barrier) {
    case 'fence':
      if (mat === 'chain_link') return { color: '#9aa3ad', top: H(1.8), base: 0, t: 0.04 };
      if (mat === 'metal' || mat === 'railing' || mat === 'iron' || mat === 'steel')
        return { color: '#4b5560', top: H(1.5), base: 0, t: 0.08 };
      if (mat === 'wood' || mat === 'wooden' || mat === 'paling')
        return { color: '#b98a55', top: H(1.4), base: 0, t: 0.1 };
      return { color: '#a8a095', top: H(1.4), base: 0, t: 0.06 };
    case 'hedge':
      return { color: '#4f9a3c', top: H(1.2), base: 0, t: 0.9 };
    case 'retaining_wall':
      return { color: '#9a948a', top: H(1.2), base: 0, t: 0.4 };
    case 'guard_rail':
      return { color: '#c3c9cf', top: 0.75, base: 0.45, t: 0.12 };
    case 'handrail':
      return { color: '#5d6b78', top: 0.95, base: 0.85, t: 0.05 };
    default:
      return {
        color: mat === 'brick' ? '#b5654a' : '#b0aaa0',
        top: H(1.8),
        base: 0,
        t: 0.3,
      };
  }
}

/** Stair treads (rising along the way direction; `incline=down` reverses) + optional handrails. */
function buildStepGeoms(tags: Tags, pts: XY[]) {
  const treads: THREE.BufferGeometry[] = [];
  const rails: THREE.BufferGeometry[] = [];
  const path = tags.incline === 'down' ? [...pts].reverse() : pts;
  const total = pathLength(path);
  if (total < 0.6) return { treads, rails };
  const n = clampInt(tags.step_count, 2, 40, Math.min(40, Math.max(2, Math.round(total / 0.32))));
  const rise = Math.min(n * 0.16, 2.6);
  const w = roadWidth(tags);
  const hr = tags.handrail ?? '';
  const offs =
    hr === 'center'
      ? [0]
      : hr === 'left'
        ? [w / 2]
        : hr === 'right'
          ? [-w / 2]
          : hr && hr !== 'no'
            ? [w / 2, -w / 2]
            : [];
  for (let i = 0; i < n; i++) {
    const a = pointAt(path, (total * i) / n);
    const b = pointAt(path, (total * (i + 1)) / n);
    const h = (rise * (i + 1)) / n;
    const tread = buildWallStrip([a, b], h, w, 0, true);
    if (tread) treads.push(tread);
    if (offs.length) {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l;
      const nz = dx / l;
      for (const o of offs) {
        const r = buildWallStrip(
          [
            [a[0] + nx * o, a[1] + nz * o],
            [b[0] + nx * o, b[1] + nz * o],
          ],
          h + 0.95,
          0.05,
          h + 0.85
        );
        if (r) rails.push(r);
      }
    }
  }
  return { treads, rails };
}

/* ---------- segment helpers (alignment + spatial hashing) ---------- */

const segsOf = (pts: XY[], closed: boolean, r: number): Seg[] =>
  (closed ? pts : pts.slice(0, -1)).map((p, i) => {
    const q = pts[(i + 1) % pts.length]!;
    return { ax: p[0], az: p[1], bx: q[0], bz: q[1], r };
  });

const segBox = (s: Seg): Box => ({
  minX: Math.min(s.ax, s.bx) - s.r,
  maxX: Math.max(s.ax, s.bx) + s.r,
  minZ: Math.min(s.az, s.bz) - s.r,
  maxZ: Math.max(s.az, s.bz) + s.r,
});

/** Unit direction of the closest segment within its own radius, or null. */
function nearestDir(cands: readonly Seg[], x: number, z: number): XY | null {
  let best = Infinity;
  let dx = 0;
  let dz = 0;
  for (const s of cands) {
    const d = distPointSeg(x, z, s.ax, s.az, s.bx, s.bz);
    if (d < s.r && d < best) {
      best = d;
      dx = s.bx - s.ax;
      dz = s.bz - s.az;
    }
  }
  const l = Math.hypot(dx, dz);
  return best === Infinity || l < 1e-6 ? null : [dx / l, dz / l];
}

/** Y-rotation that lays an object's local X axis along / across a direction. */
const alignRotation = (mode: 'along' | 'across', [dx, dz]: XY) =>
  mode === 'along' ? Math.atan2(-dz, dx) : Math.atan2(-dx, -dz);

/* ---------- geometry merging ---------- */

type AttrSpec = readonly (readonly [string, number])[];
const DEFAULT_ATTRS: AttrSpec = [
  ['position', 3],
  ['normal', 3],
  ['uv', 2],
];

function mergeGeometries(
  geoms: readonly THREE.BufferGeometry[],
  attrs: AttrSpec = DEFAULT_ATTRS
): THREE.BufferGeometry | null {
  if (geoms.length === 0) return null;
  const parts = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  const counts = parts.map((g) => g.getAttribute('position').count);
  const total = counts.reduce((a, b) => a + b, 0);
  const out = new THREE.BufferGeometry();
  attrs.forEach(([name, size]) => {
    const arr = new Float32Array(total * size);
    parts.reduce((off, g, i) => {
      const a = g.getAttribute(name);
      if (a) arr.set(a.array as ArrayLike<number>, off);
      return off + counts[i]! * size;
    }, 0);
    out.setAttribute(name, new THREE.Float32BufferAttribute(arr, size));
  });
  return out;
}

/** Copy the triangles of a non-indexed ExtrudeGeometry that belong to one material index. */
function sliceByMaterial(g: THREE.BufferGeometry, materialIndex: number): THREE.BufferGeometry {
  const groups = g.groups.filter((x) => x.materialIndex === materialIndex);
  const out = new THREE.BufferGeometry();
  DEFAULT_ATTRS.forEach(([name, size]) => {
    const src = g.getAttribute(name).array as Float32Array;
    const chunks = groups.map((gr) => src.slice(gr.start * size, (gr.start + gr.count) * size));
    const arr = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    chunks.reduce((off, c) => {
      arr.set(c, off);
      return off + c.length;
    }, 0);
    out.setAttribute(name, new THREE.Float32BufferAttribute(arr, size));
  });
  return out;
}

/* ============================================================
 * 5. TAG CLASSIFIERS
 * ============================================================ */

const is =
  (key: string, ...vals: string[]) =>
  (t: Tags): boolean =>
    vals.includes((t[key] as string | undefined) ?? '');
const has =
  (key: string) =>
  (t: Tags): boolean =>
    !!t[key];
const or =
  (...ps: ((t: Tags) => boolean)[]) =>
  (t: Tags): boolean =>
    ps.some((p) => p(t));

const FOOT_HIGHWAYS = ['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'sidewalk'];
const isFootTags = (tags: Tags): boolean => FOOT_HIGHWAYS.includes(tags.highway ?? '');

function isStandingBuilding(tags: Tags): boolean {
  const v = (tags.building ?? '').toLowerCase();
  if (!v || NON_BUILDING_VALUES.has(v)) return false;
  if (
    tags.location === 'underground' ||
    tags.tunnel === 'yes' ||
    tags.tunnel === 'building_passage'
  )
    return false;
  const layer = parseFloat(tags.layer ?? '0');
  if (Number.isFinite(layer) && layer < 0) return false;
  if (tags['demolished:building'] || tags['abandoned:building'] || tags['disused:building'])
    return false;
  if (tags.area === 'no') return false;
  if (tags.amenity === 'parking' || tags.parking) return false;
  if (tags.leisure === 'pitch' || tags.leisure === 'swimming_pool' || tags.leisure === 'park')
    return false;
  if (tags.natural === 'water' || tags.highway) return false;
  return true;
}

function classifyNonBuilding(tags: Tags): WayKind {
  if (tags.amenity === 'parking_space') return 'parking_space';
  if (tags.amenity === 'parking' || tags.parking) return 'parking';
  if (tags.natural === 'tree_row') return 'tree_row';
  if (
    tags.landuse === 'flowerbed' ||
    tags.natural === 'flowerbed' ||
    tags.natural === 'flower_bed' ||
    tags.leisure === 'flowerbed'
  )
    return 'flowerbed';
  if (
    is('leisure', 'park', 'garden', 'pitch', 'playground')(tags) ||
    is('natural', 'grassland', 'scrub', 'heath')(tags) ||
    is(
      'landuse',
      'grass',
      'forest',
      'meadow',
      'recreation_ground',
      'village_green',
      'cemetery'
    )(tags)
  )
    return 'park';
  if (
    tags.natural === 'water' ||
    tags.landuse === 'reservoir' ||
    tags.water ||
    tags.leisure === 'swimming_pool'
  )
    return 'water';
  if (tags.highway === 'steps') return 'steps';
  if (tags.highway) return isFootTags(tags) ? 'footway' : 'road';
  if (tags.railway) return 'rail';
  if (is('barrier', 'wall', 'fence', 'hedge', 'retaining_wall', 'guard_rail', 'handrail')(tags))
    return 'barrier';
  if (is('power', 'line', 'minor_line', 'cable')(tags)) return 'power_line';
  if (tags.landuse) return 'landuse';
  return 'ignore';
}

function classifyWay(tags: Tags): WayKind {
  if (!tags.building) return classifyNonBuilding(tags);
  if (tags.building.toLowerCase() === 'roof') return 'canopy';
  return isStandingBuilding(tags) ? 'building' : classifyNonBuilding(tags);
}

const NODE_RULES: readonly (readonly [(t: Tags) => boolean, NodeKind])[] = [
  // --- street furniture / comfort ---
  [or(is('amenity', 'lounger'), is('leisure', 'sunbed')), 'lounger'],
  [is('man_made', 'planter'), 'planter'],
  [is('amenity', 'shelter'), 'shelter'],
  // --- barriers / access ---
  [is('barrier', 'bollard'), 'bollard'],
  [is('barrier', 'turnstile'), 'turnstile'],
  // --- transport / bicycles ---
  [is('amenity', 'bicycle_repair_station'), 'bicycle_repair_station'],
  [is('highway', 'cyclist_waiting_aid'), 'cyclist_waiting_aid'],
  [is('amenity', 'parking_space'), 'parking_space'],
  [(t) => t.amenity === 'vending_machine' && t.vending === 'parking_tickets', 'parking_meter'],
  [is('amenity', 'trolley_bay'), 'trolley_bay'],
  [is('traffic_calming', 'bump', 'hump', 'cushion', 'table'), 'speed_bump'],
  // --- utilities / emergency ---
  [is('man_made', 'manhole'), 'manhole'],
  [is('man_made', 'street_cabinet'), 'street_cabinet'],
  [is('emergency', 'defibrillator'), 'defibrillator'],
  [is('emergency', 'first_aid_kit'), 'first_aid_kit'],
  [is('emergency', 'fire_alarm_box', 'fire_alarm'), 'fire_alarm'],
  [is('man_made', 'surveillance'), 'surveillance'],
  [is('man_made', 'water_tank'), 'water_tank'],
  [is('man_made', 'air_conditioner'), 'air_conditioner'],
  // --- signage ---
  [is('amenity', 'notice_board'), 'notice_board'],
  [is('highway', 'milestone'), 'milestone'],
  // --- nature ---
  [or(is('natural', 'flower'), is('landuse', 'flowerbed')), 'flower'],
  // --- indoor ---
  [is('highway', 'elevator'), 'elevator'],
  [is('amenity', 'locker'), 'locker'],
  [(t) => !!t.door && t.door !== 'no', 'door'],
  // --- originals ---
  [is('natural', 'tree', 'shrub'), 'tree'],
  [is('amenity', 'bench'), 'bench'],
  [is('amenity', 'chair', 'seats'), 'chair'],
  [or(is('amenity', 'desk'), is('furniture', 'desk')), 'desk'],
  [or(is('amenity', 'table', 'picnic_table'), is('leisure', 'picnic_table')), 'table'],
  [is('historic', 'memorial', 'monument'), 'monument'],
  [or(is('tourism', 'artwork'), is('man_made', 'statue'), is('historic', 'statue')), 'statue'],
  [is('emergency', 'fire_hydrant'), 'fire_hydrant'],
  [is('man_made', 'flagpole'), 'flagpole'],
  [is('man_made', 'water_tower'), 'water_tower'],
  [or(is('man_made', 'tower'), has('tower')), 'tower'],
  [is('amenity', 'atm'), 'atm'],
  [is('amenity', 'bank'), 'bank'],
  [
    is(
      'shop',
      'supermarket',
      'convenience',
      'grocery',
      'greengrocer',
      'butcher',
      'bakery',
      'general',
      'department_store'
    ),
    'grocery',
  ],
  [has('shop'), 'shop'],
  [is('amenity', 'cafe'), 'cafe'],
  [is('amenity', 'restaurant'), 'restaurant'],
  [is('amenity', 'fast_food'), 'fast_food'],
  [or(is('amenity', 'toilets'), has('toilets')), 'toilet'],
  [or(is('amenity', 'shelter', 'shed'), is('building', 'shed', 'roof')), 'shed'],
  [is('amenity', 'waste_basket', 'bin'), 'waste_basket'],
  [is('amenity', 'waste_disposal', 'waste'), 'waste_disposal'],
  [is('amenity', 'drinking_water'), 'drinking_water'],
  [is('amenity', 'recycling'), 'recycling'],
  [is('amenity', 'fountain'), 'fountain'],
  [is('amenity', 'vending_machine', 'vending'), 'vending'],
  [or(is('amenity', 'clock'), is('man_made', 'clock')), 'clock'],
  [is('amenity', 'telephone', 'phone'), 'phone'],
  [is('amenity', 'post_box'), 'post_box'],
  [is('amenity', 'bicycle_parking'), 'bicycle_parking'],
  [is('amenity', 'motorcycle_parking'), 'motorcycle_parking'],
  [is('amenity', 'parking_entrance'), 'parking_entrance'],
  [is('highway', 'street_lamp'), 'street_lamp'],
  [is('highway', 'traffic_signals'), 'traffic_signals'],
  [or(is('highway', 'bus_stop'), is('public_transport', 'platform')), 'bus_stop'],
  [is('highway', 'crossing'), 'crossing'],
  [is('power', 'pole', 'minor_line'), 'power_pole'],
  [is('power', 'tower'), 'power_tower'],
  [is('barrier', 'gate'), 'gate'],
  [is('barrier', 'lift_gate'), 'lift_gate'],
  [is('information', 'board', 'map'), 'info_board'],
  [is('information', 'guidepost', 'route_marker'), 'guidepost'],
  [is('tourism', 'information'), 'info_board'],
  [or(is('natural', 'water'), is('leisure', 'swimming_pool')), 'ignore'],
];

function classifyNode(tags: Tags): NodeKind {
  if (isAnnotationOnly(tags)) return 'ignore';
  return NODE_RULES.find(([pred]) => pred(tags))?.[1] ?? 'generic';
}

/** Compact, hashable look-variant string derived from a node's tags ('' = default look). */
function variantOf(kind: NodeKind, t: Tags): string {
  switch (kind) {
    case 'bench':
      return [t.material ?? 'wood', t.backrest === 'no' ? 0 : 1, clampInt(t.seats, 1, 6, 3)].join(
        '|'
      );
    case 'table':
      return t.amenity === 'table' ? 'plain' : 'picnic';
    case 'waste_basket':
      return t.waste ?? 'trash';
    case 'street_lamp':
      return [
        t.lamp_type === 'sodium' ? 'sodium' : 'led',
        clampInt(t.height, 3, 12, 5),
        t.mount === 'wall' ? 'wall' : 'pole',
      ].join('|');
    case 'toilet':
      return `${t.fee === 'yes' ? 1 : 0}|${t.wheelchair === 'yes' ? 1 : 0}`;
    case 'shelter':
      return t.shelter_type ?? 'weather_shelter';
    case 'clock':
      return t.display === 'digital' ? 'digital' : 'analog';
    case 'bicycle_parking':
      return `${t.bicycle_parking ?? 'stands'}|${clampInt(t.capacity, 2, 12, 4)}`;
    case 'parking_space':
      return t.parking_space === 'disabled' ? 'disabled' : 'regular';
    case 'fire_hydrant':
      return t['fire_hydrant:type'] === 'underground' ? 'underground' : 'pillar';
    case 'manhole':
      return t.manhole ?? 'sewer';
    case 'vending':
      return t.vending ?? 'drinks';
    case 'door':
      return t.door ?? 'hinged';
    case 'speed_bump':
      return t.traffic_calming === 'cushion' ? 'cushion' : 'bump';
    case 'surveillance':
      return (t['surveillance:type'] ?? 'camera') === 'camera' ? 'camera' : 'dome';
    default:
      return '';
  }
}

/** Features whose orientation is taken from the nearest road ('across') or building wall ('along'). */
const ALIGN: Partial<Record<NodeKind, 'along' | 'across'>> = {
  speed_bump: 'across',
  door: 'along',
};

const treeSize = (t: Tags): number => {
  const h = firstNum(t.height);
  return Number.isFinite(h) && h > 0 ? THREE.MathUtils.clamp(h / 6, 0.6, 2.2) : 1;
};

/* ============================================================
 * 6. TEXTURE FACTORIES
 * ============================================================ */

const facadeCache = new Map<BuildingKind, THREE.CanvasTexture>();

function makeFacadeTexture(kind: BuildingKind): THREE.CanvasTexture {
  const cached = facadeCache.get(kind);
  if (cached) return cached;
  const pal = PALETTE[kind];
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;

  const bg = ctx.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, shadeHex(pal.wall, 0.06));
  bg.addColorStop(0.7, pal.wall);
  bg.addColorStop(1, shadeHex(pal.wall, -0.06));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);

  const rnd = seededRand(kind.length * 7717 + 29);
  for (let i = 0; i < 420; i++) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.045)';
    ctx.beginPath();
    ctx.arc(rnd() * S, rnd() * S, rnd() * 1.4 + 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = shadeHex(pal.wall, -0.12);
  ctx.fillRect(0, 0, S, 8);
  ctx.fillStyle = shadeHex(pal.wall, 0.18);
  ctx.fillRect(0, 8, S, 3);
  ctx.fillStyle = shadeHex(pal.wall, -0.16);
  ctx.fillRect(0, S - 20, S, 20);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(0, S - 20, S, 2);

  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };

  const win = (x: number, y: number, w: number, h: number, warm = false) => {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(x - 5, y - 5, w + 10, h + 10);
    ctx.fillStyle = 'rgba(28,32,50,0.92)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    if (warm) {
      g.addColorStop(0, '#ffe9b0');
      g.addColorStop(1, '#ffb84d');
    } else {
      g.addColorStop(0, '#cfeaff');
      g.addColorStop(0.55, '#9ccdf2');
      g.addColorStop(1, '#5f8fc4');
    }
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(25,30,48,0.8)';
    ctx.lineWidth = 2;
    line(x + w / 2, y, x + w / 2, y + h);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.7);
    ctx.lineTo(x + w * 0.45, y);
    ctx.lineTo(x + w * 0.75, y);
    ctx.lineTo(x + w * 0.2, y + h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(x - 6, y + h + 5, w + 12, 3);
  };

  if (kind === 'academic') {
    ctx.fillStyle = pal.accent;
    ctx.fillRect(0, 13, S, 7);
    win(32, 44, 80, 128);
    win(144, 44, 80, 128);
  } else if (kind === 'office') {
    const gx = 16,
      gy = 26,
      gw = S - 32,
      gh = S - 66;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(gx - 5, gy - 5, gw + 10, gh + 10);
    ctx.fillStyle = 'rgba(28,32,50,0.92)';
    ctx.fillRect(gx - 1, gy - 1, gw + 2, gh + 2);
    const g = ctx.createLinearGradient(gx, gy, gx + gw, gy + gh);
    g.addColorStop(0, '#bfe6ff');
    g.addColorStop(0.5, '#8fc3ee');
    g.addColorStop(1, '#4d7fb5');
    ctx.fillStyle = g;
    ctx.fillRect(gx, gy, gw, gh);
    ctx.strokeStyle = 'rgba(25,30,48,0.75)';
    ctx.lineWidth = 2;
    for (let x = gx + 32; x < gx + gw; x += 32) line(x, gy, x, gy + gh);
    line(gx, gy + gh / 2, gx + gw, gy + gh / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    ctx.moveTo(gx, gy + gh * 0.8);
    ctx.lineTo(gx + gw * 0.5, gy);
    ctx.lineTo(gx + gw * 0.72, gy);
    ctx.lineTo(gx + gw * 0.22, gy + gh);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'sports') {
    win(18, 46, S - 36, 88);
    ctx.fillStyle = pal.accent;
    ctx.fillRect(0, 148, S, 12);
    ctx.fillStyle = 'rgba(28,32,50,0.9)';
    ctx.fillRect(S / 2 - 34, 176, 68, 40);
    ctx.fillStyle = pal.accent;
    ctx.fillRect(S / 2 - 34, 194, 68, 4);
  } else if (kind === 'construction') {
    ctx.strokeStyle = 'rgba(90,70,25,0.5)';
    ctx.lineWidth = 3;
    for (let x = 0; x <= S; x += 32) line(x, 0, x, S);
    for (let y = 40; y <= S; y += 40) line(0, y, S, y);
    ctx.fillStyle = 'rgba(28,32,50,0.9)';
    ctx.fillRect(34, 60, 66, 74);
    ctx.fillRect(156, 60, 66, 74);
    const g = ctx.createLinearGradient(0, 60, 0, 134);
    g.addColorStop(0, '#fff2a0');
    g.addColorStop(1, '#e0a83c');
    ctx.fillStyle = g;
    ctx.fillRect(38, 64, 58, 66);
    ctx.fillRect(160, 64, 58, 66);
    for (let x = -20; x < S + 20; x += 24) {
      ctx.fillStyle = '#ffd93d';
      ctx.beginPath();
      ctx.moveTo(x, S - 44);
      ctx.lineTo(x + 12, S - 44);
      ctx.lineTo(x, S - 24);
      ctx.lineTo(x - 12, S - 24);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(30,30,30,0.85)';
      ctx.beginPath();
      ctx.moveTo(x + 12, S - 44);
      ctx.lineTo(x + 24, S - 44);
      ctx.lineTo(x + 12, S - 24);
      ctx.lineTo(x, S - 24);
      ctx.closePath();
      ctx.fill();
    }
  } else if (kind === 'shed') {
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= S; x += 12) line(x, 0, x, S);
    ctx.fillStyle = 'rgba(60,45,30,0.9)';
    ctx.fillRect(S * 0.2, S * 0.42, S * 0.6, S * 0.46);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 3;
    ctx.strokeRect(S * 0.2 + 4, S * 0.42 + 4, S * 0.6 - 8, S * 0.46 - 8);
    line(S * 0.2 + 6, S * 0.42 + 6, S * 0.8 - 6, S * 0.88 - 6);
    line(S * 0.8 - 6, S * 0.42 + 6, S * 0.2 + 6, S * 0.88 - 6);
    win(24, 26, 56, 40, true);
  } else if (kind === 'monument') {
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 2;
    for (let y = 0; y <= S; y += 32) {
      line(0, y, S, y);
      const off = (y / 32) % 2 === 0 ? 0 : 32;
      for (let x = off; x <= S; x += 64) line(x, y, x, y + 32);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    for (let y = 0; y <= S; y += 32) ctx.fillRect(0, y + 2, S, 2);
    ctx.fillStyle = '#8a6b2f';
    ctx.fillRect(S / 2 - 44, S / 2 - 20, 88, 40);
    ctx.strokeStyle = '#d4af37';
    ctx.lineWidth = 3;
    ctx.strokeRect(S / 2 - 44, S / 2 - 20, 88, 40);
  } else if (kind === 'cafeteria') {
    const sw = 32;
    for (let i = 0, x = 0; x < S; i++, x += sw) {
      ctx.fillStyle = i % 2 === 0 ? pal.accent : '#ffffff';
      ctx.fillRect(x, 12, sw, 30);
      ctx.beginPath();
      ctx.arc(x + sw / 2, 42, sw / 2, 0, Math.PI);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 12, S, 30);
    win(30, 96, 72, 76, true);
    win(154, 96, 72, 76, true);
  } else if (kind === 'residential') {
    win(32, 48, 70, 88, true);
    win(154, 48, 70, 88, true);
    for (const bx of [24, 146]) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.strokeRect(bx, 142, 86, 26);
      for (let x = bx + 12; x < bx + 86; x += 12) line(x, 142, x, 168);
    }
  } else {
    ctx.fillStyle = 'rgba(40,52,58,0.92)';
    ctx.fillRect(S * 0.24, S * 0.38, S * 0.52, S * 0.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    for (let y = S * 0.38 + 8; y < S * 0.88; y += 10) line(S * 0.24 + 4, y, S * 0.76 - 4, y);
    win(S / 2 - 32, 26, 64, 32);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.repeat.set(1 / 6.5, 1 / 3.4);
  facadeCache.set(kind, tex);
  return tex;
}

type CenterLine = 'yellow-dash' | 'white-dash' | 'none';
const roadTexCache = new Map<string, THREE.CanvasTexture>();

function makeRoadTexture(centerLine: CenterLine, edgeLine: boolean) {
  const key = `${centerLine}|${edgeLine}`;
  const cached = roadTexCache.get(key);
  if (cached) return cached;
  const W = 128,
    H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3a3a44';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.025})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.fillRect(W * 0.22, 0, 6, H);
  ctx.fillRect(W * 0.72, 0, 6, H);
  if (edgeLine) {
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(6, 0, 3, H);
    ctx.fillRect(W - 9, 0, 3, H);
  }
  if (centerLine !== 'none') {
    ctx.fillStyle = centerLine === 'yellow-dash' ? '#ffd93d' : '#f0f0f0';
    for (let y = 0; y < H; y += 180) ctx.fillRect(W / 2 - 3, y, 6, 90);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  roadTexCache.set(key, tex);
  return tex;
}

/* ---------- shared building materials ---------- */

const buildingMatCache = new Map<string, THREE.MeshToonMaterial>();

function buildingMaterial(kind: BuildingKind, part: 'roof' | 'side', highlight: boolean) {
  const key = `${kind}|${part}|${highlight}`;
  const cached = buildingMatCache.get(key);
  if (cached) return cached;
  const pal = PALETTE[kind];
  const mat =
    part === 'roof'
      ? new THREE.MeshToonMaterial({ color: pal.roof, gradientMap: toonGradient })
      : new THREE.MeshToonMaterial({
          map: makeFacadeTexture(kind),
          color: '#ffffff',
          gradientMap: toonGradient,
          emissive: highlight ? pal.accent : '#000000',
          emissiveIntensity: highlight ? 0.35 : 0,
        });
  if (highlight) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
  }
  buildingMatCache.set(key, mat);
  return mat;
}

/* ============================================================
 * 7. PART-BASED POINT FEATURES (baked + instanced, tag-variant aware)
 * ============================================================ */

interface Part {
  g: THREE.BufferGeometry;
  at: V3;
  c: string;
  rot?: V3;
  glow?: boolean;
}

const box = (w: number, h: number, d: number, at: V3, c: string, glow = false, rot?: V3): Part => ({
  g: new THREE.BoxGeometry(w, h, d),
  at,
  c,
  glow,
  rot,
});
const cyl = (rt: number, rb: number, h: number, seg: number, at: V3, c: string): Part => ({
  g: new THREE.CylinderGeometry(rt, rb, h, seg),
  at,
  c,
});
const sph = (r: number, at: V3, c: string, glow = false): Part => ({
  g: new THREE.SphereGeometry(r, 10, 10),
  at,
  c,
  glow,
});
const cone = (r: number, h: number, seg: number, at: V3, c: string): Part => ({
  g: new THREE.ConeGeometry(r, h, seg),
  at,
  c,
});
const circ = (r: number, seg: number, at: V3, c: string, glow = true): Part => ({
  g: new THREE.CircleGeometry(r, seg),
  at,
  c,
  glow,
});
const tor = (at: V3, c: string): Part => ({
  g: new THREE.TorusGeometry(0.35, 0.05, 8, 16, Math.PI),
  at,
  c,
});

const COLOR_ATTRS: AttrSpec = [
  ['position', 3],
  ['normal', 3],
  ['color', 3],
];

function bakeParts(parts: Part[]): {
  solid: THREE.BufferGeometry | null;
  glow: THREE.BufferGeometry | null;
} {
  const prep = (p: Part) => {
    if (p.rot) {
      p.g.rotateX(p.rot[0]);
      p.g.rotateY(p.rot[1]);
      p.g.rotateZ(p.rot[2]);
    }
    p.g.translate(...p.at);
    const col = new THREE.Color(p.c);
    const rgb = [col.r, col.g, col.b];
    const n = p.g.getAttribute('position').count;
    p.g.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(
        Float32Array.from({ length: n * 3 }, (_, i) => rgb[i % 3]!),
        3
      )
    );
    return p.g;
  };
  const pick = (glow: boolean) =>
    mergeGeometries(parts.filter((p) => !!p.glow === glow).map(prep), COLOR_ATTRS);
  return { solid: pick(false), glow: pick(true) };
}

interface LabelSpec {
  y: number;
  size: number;
  color: string;
  outline: string;
  outlineWidth: number;
  fallback?: string;
}

interface FeatureDef {
  /** `v` is the tag-derived variant string from `variantOf` ('' for the default look). */
  parts: (v: string) => Part[];
  rotates?: boolean;
  label?: LabelSpec;
}

const WOOD = '#c88c50';
const DARK_WOOD = '#5a4a3a';
const POLE = '#3d434a';
const STEEL = '#8a8f95';
const BENCH_TOP: Record<string, string> = { wood: WOOD, metal: '#7d8894', concrete: '#b5b8ba' };
const WASTE_COLOR: Record<string, string> = {
  trash: '#4c5a3f',
  recycling: '#2196f3',
  glass: '#4caf50',
};
const MANHOLE_COLOR: Record<string, string> = {
  sewer: '#3a3a40',
  drain: '#555a62',
  telecom: '#5b6f88',
  water: '#3f6fa8',
  gas: '#a88a3f',
  electric: '#8a3f3f',
};

const postAt = (x: number, z: number, h: number, c = POLE): Part =>
  cyl(0.06, 0.07, h, 6, [x, h / 2, z], c);

const shopParts = (wall: string, roof: string, awning: string) => (): Part[] => [
  box(5, 3.2, 5, [0, 1.6, 0], wall),
  box(5.4, 0.3, 5.4, [0, 3.35, 0], roof),
  box(5, 0.25, 0.9, [0, 2.7, 2.55], awning),
];
const SHOP_LABEL: LabelSpec = {
  y: 4.4,
  size: 0.9,
  color: '#ffffff',
  outline: '#3a2a20',
  outlineWidth: 0.06,
};
const towerParts = (isWater: boolean) => (): Part[] => {
  const h = isWater ? 8 : 12;
  return [
    cyl(0.8, 1.2, h, 12, [0, h / 2, 0], isWater ? '#c8dce8' : '#b9c2cc'),
    ...(isWater ? [cyl(2.2, 2.2, 3, 16, [0, h + 1.5, 0], '#8fb0c4')] : []),
    cone(1, 1.2, 12, [0, h + 0.6, 0], '#5a5a5a'),
  ];
};
const powerParts = (tall: boolean) => (): Part[] => {
  const h = tall ? 14 : 6;
  return [
    cyl(tall ? 0.4 : 0.12, tall ? 0.6 : 0.18, h, 8, [0, h / 2, 0], '#5d4037'),
    box(tall ? 4 : 1.6, 0.12, 0.12, [0, h, 0], '#5d4037'),
  ];
};
const gateParts = (lift: boolean) => (): Part[] => [
  box(0.3, 2, 0.3, [0, 1, 0], '#e0e0e0'),
  box(2.4, 0.15, 0.15, [1.2, 1.8, 0], lift ? '#ff5e5e' : '#8a8a8a'),
];
const crossGlow = (y: number, z: number, c: string): Part[] => [
  box(0.28, 0.07, 0.02, [0, y, z], c, true),
  box(0.07, 0.28, 0.02, [0, y, z], c, true),
];

const FEATURES = {
  /* ---------- 1. street furniture & public comfort ---------- */
  bench: {
    rotates: true,
    parts: (v) => {
      const [mat = 'wood', back = '1', seats = '3'] = v.split('|');
      const top = BENCH_TOP[mat] ?? WOOD;
      const frame = mat === 'wood' || !mat ? DARK_WOOD : mat === 'concrete' ? '#8f9498' : POLE;
      const len = 0.5 + 0.37 * Number(seats);
      const lx = len / 2 - 0.15;
      return [
        box(len, 0.1, 0.55, [0, 0.45, 0], top),
        ...(back === '1' ? [box(len, 0.1, 0.45, [0, 0.75, -0.22], top, false, [-0.25, 0, 0])] : []),
        box(0.1, 0.45, 0.5, [-lx, 0.22, 0], frame),
        box(0.1, 0.45, 0.5, [lx, 0.22, 0], frame),
      ];
    },
  },
  chair: {
    rotates: true,
    parts: () => [
      box(0.5, 0.08, 0.5, [0, 0.45, 0], '#b8825a'),
      box(0.5, 0.55, 0.08, [0, 0.75, -0.22], '#b8825a'),
      ...([-0.2, 0.2] as const).flatMap((dx) =>
        ([-0.2, 0.2] as const).map((dz) => box(0.06, 0.45, 0.06, [dx, 0.22, dz], DARK_WOOD))
      ),
    ],
  },
  desk: {
    rotates: true,
    parts: () => [
      box(1.2, 0.08, 0.6, [0, 0.75, 0], WOOD),
      ...([-0.55, 0.55] as const).flatMap((dx) =>
        ([-0.25, 0.25] as const).map((dz) => box(0.08, 0.75, 0.08, [dx, 0.375, dz], DARK_WOOD))
      ),
    ],
  },
  table: {
    rotates: true,
    parts: (v) =>
      v === 'plain'
        ? [
            box(1.2, 0.08, 0.8, [0, 0.75, 0], WOOD),
            ...([-0.5, 0.5] as const).flatMap((dx) =>
              ([-0.3, 0.3] as const).map((dz) => box(0.07, 0.75, 0.07, [dx, 0.375, dz], DARK_WOOD))
            ),
          ]
        : [
            box(1.6, 0.1, 0.9, [0, 0.75, 0], WOOD),
            box(1.6, 0.08, 0.3, [0, 0.45, -0.55], WOOD),
            box(1.6, 0.08, 0.3, [0, 0.45, 0.55], WOOD),
          ],
  },
  waste_basket: {
    parts: (v) => [
      cyl(0.28, 0.24, 0.8, 10, [0, 0.4, 0], WASTE_COLOR[v] ?? WASTE_COLOR.trash!),
      cyl(0.3, 0.3, 0.05, 10, [0, 0.82, 0], '#2a2a2a'),
    ],
  },
  street_lamp: {
    parts: (v) => {
      const [lamp = 'led', hs = '5', mount = 'pole'] = v.split('|');
      const h = Number(hs);
      const glow = lamp === 'sodium' ? '#ffb347' : '#eaf6ff';
      return mount === 'wall'
        ? [
            box(0.1, 0.1, 0.9, [0, h - 0.3, 0.45], POLE),
            box(0.4, 0.1, 0.3, [0, h - 0.35, 0.9], POLE),
            box(0.3, 0.05, 0.25, [0, h - 0.42, 0.9], glow, true),
          ]
        : [
            cyl(0.08, 0.12, h, 8, [0, h / 2, 0], POLE),
            box(0.6, 0.15, 0.6, [0, h + 0.05, 0], POLE),
            box(0.5, 0.08, 0.5, [0, h - 0.05, 0], glow, true),
          ];
    },
  },
  lounger: {
    rotates: true,
    parts: () => [
      box(0.7, 0.08, 1.2, [0, 0.3, 0.2], '#f4e2b8'),
      box(0.7, 0.08, 0.7, [0, 0.55, -0.55], '#f4e2b8', false, [0.6, 0, 0]),
      box(0.06, 0.3, 0.9, [-0.3, 0.15, 0.2], STEEL),
      box(0.06, 0.3, 0.9, [0.3, 0.15, 0.2], STEEL),
    ],
  },
  drinking_water: {
    parts: () => [
      box(0.5, 1, 0.4, [0, 0.5, 0], '#7d8894'),
      cyl(0.06, 0.06, 0.12, 8, [0, 1.02, 0], POLE),
    ],
  },
  toilet: {
    parts: (v) => {
      const [fee, wc] = v.split('|');
      return [
        box(3, 3.2, 3, [0, 1.6, 0], '#cfd8dc'),
        box(3.3, 0.25, 3.3, [0, 3.3, 0], '#455a64'),
        ...(fee === '1' ? [box(0.5, 0.3, 0.05, [-0.9, 2.3, 1.53], '#ffd93d')] : []),
        ...(wc === '1' ? [box(0.4, 0.4, 0.05, [0.9, 2.3, 1.53], '#2f6fdc')] : []),
      ];
    },
    label: {
      y: 4.5,
      size: 0.8,
      color: '#1a1a2e',
      outline: '#ffffff',
      outlineWidth: 0.05,
      fallback: 'CR',
    },
  },
  shelter: {
    parts: (v) => {
      if (v === 'gazebo')
        return [
          cyl(2.6, 2.6, 0.15, 8, [0, 0.08, 0], '#cfc9b8'),
          ...([-1.7, 1.7] as const).flatMap((dx) =>
            ([-1.7, 1.7] as const).map((dz) => cyl(0.1, 0.12, 2.8, 8, [dx, 1.5, dz], '#f0ece4'))
          ),
          cone(3.2, 1.8, 8, [0, 3.7, 0], '#a87858'),
        ];
      if (v === 'sun_shelter')
        return [
          ...([-1.9, 1.9] as const).flatMap((dx) =>
            ([-1, 1] as const).map((dz) => cyl(0.08, 0.1, 2.6, 8, [dx, 1.3, dz], '#8a6b4a'))
          ),
          box(4.6, 0.1, 2.6, [0, 2.65, 0], '#2e8b8b'),
        ];
      return [
        ...([-1.9, 1.9] as const).flatMap((dx) =>
          ([-0.9, 0.9] as const).map((dz) => cyl(0.1, 0.12, 2.6, 8, [dx, 1.3, dz], '#8a6b4a'))
        ),
        box(4.4, 0.2, 2.4, [0, 2.7, 0], '#a87858'),
        box(4.2, 2.2, 0.1, [0, 1.4, -0.9], '#9fc9d8'),
        box(1.6, 0.1, 0.5, [0, 0.5, -0.6], WOOD),
      ];
    },
    label: { y: 4.2, size: 0.8, color: '#1a1a2e', outline: '#ffffff', outlineWidth: 0.05 },
  },
  clock: {
    parts: (v) => [
      cyl(0.1, 0.12, 3.2, 8, [0, 1.6, 0], POLE),
      ...(v === 'digital'
        ? [
            box(1.4, 0.6, 0.15, [0, 3.5, 0], '#2a2a2a'),
            box(1.1, 0.3, 0.02, [0, 3.5, 0.09], '#ff3b30', true),
          ]
        : [
            box(1.2, 1.2, 0.15, [0, 3.5, 0], '#2a2a2a'),
            circ(0.5, 20, [0, 3.5, 0.09], '#f8f8f2'),
            box(0.05, 0.35, 0.02, [0, 3.62, 0.1], '#111111'),
            box(0.3, 0.05, 0.02, [0.12, 3.5, 0.1], '#111111'),
          ]),
    ],
  },
  fountain: {
    parts: () => [
      cyl(2, 2.2, 0.7, 24, [0, 0.35, 0], '#cfc9b8'),
      cyl(1.75, 1.75, 0.08, 24, [0, 0.68, 0], '#6fc4ec'),
      cyl(0.3, 0.4, 1.1, 12, [0, 1.2, 0], '#cfc9b8'),
      cone(0.28, 0.9, 12, [0, 1.9, 0], '#9fdcff'),
    ],
  },
  planter: {
    parts: () => [
      box(1.2, 0.5, 0.5, [0, 0.25, 0], '#8a6f5a'),
      box(1.1, 0.1, 0.4, [0, 0.55, 0], '#4f9a3c'),
      sph(0.3, [0, 0.75, 0], '#5fc26b'),
    ],
  },

  /* ---------- 2. barriers & access ---------- */
  bollard: {
    parts: () => [
      cyl(0.1, 0.1, 0.9, 8, [0, 0.45, 0], STEEL),
      cyl(0.105, 0.105, 0.12, 8, [0, 0.62, 0], '#ffd93d'),
    ],
  },
  turnstile: {
    parts: () => [
      box(0.4, 0.1, 0.4, [0, 0.05, 0], STEEL),
      cyl(0.1, 0.1, 1.0, 8, [0, 0.5, 0], STEEL),
      box(1.0, 0.05, 0.05, [0, 0.9, 0], STEEL),
      box(1.0, 0.05, 0.05, [0, 0.9, 0], STEEL, false, [0, (Math.PI * 2) / 3, 0]),
      box(1.0, 0.05, 0.05, [0, 0.9, 0], STEEL, false, [0, (Math.PI * 4) / 3, 0]),
    ],
  },
  gate: { parts: gateParts(false) },
  lift_gate: { parts: gateParts(true) },

  /* ---------- 3. transport & bicycles ---------- */
  bicycle_parking: {
    rotates: true,
    parts: (v) => {
      const [type = 'stands', cap = '4'] = v.split('|');
      const n = Math.max(1, Math.round(Number(cap) / 2));
      const w = n * 0.7 + 0.4;
      return [
        ...Array.from({ length: n }, (_, i) => tor([(i - (n - 1) / 2) * 0.7, 0.4, 0], '#607d8b')),
        ...(type === 'wall_loops' ? [box(w, 1.1, 0.1, [0, 0.55, -0.35], '#b0aaa0')] : []),
        ...(type === 'shed'
          ? [
              ...([-1, 1] as const).flatMap((sx) =>
                ([-0.9, 0.9] as const).map((sz) =>
                  cyl(0.06, 0.06, 2.4, 6, [(sx * w) / 2, 1.2, sz], '#8a6b4a')
                )
              ),
              box(w + 0.4, 0.12, 2.2, [0, 2.45, 0], '#2e8b8b'),
            ]
          : []),
      ];
    },
  },
  bicycle_repair_station: {
    parts: () => [
      cyl(0.07, 0.07, 1.6, 8, [0, 0.8, 0], '#2e8b8b'),
      box(0.35, 0.5, 0.15, [0, 1.3, 0.1], '#ffb347'),
      cyl(0.04, 0.04, 0.5, 6, [0.15, 0.9, 0.15], '#c8c8c8'),
    ],
  },
  cyclist_waiting_aid: {
    parts: () => [postAt(0, 0, 1.0), box(0.5, 0.06, 0.15, [0, 0.3, 0.12], '#ffd93d')],
  },
  bus_stop: {
    parts: () => [
      box(4, 0.15, 2, [0, 2.5, 0], '#2e8b8b'),
      ...([-1.8, 1.8] as const).flatMap((dx) =>
        ([-0.8, 0.8] as const).map((dz) => cyl(0.08, 0.08, 2.5, 8, [dx, 1.25, dz], POLE))
      ),
    ],
    label: { y: 3.4, size: 0.7, color: '#ffffff', outline: '#1a4d8c', outlineWidth: 0.05 },
  },
  parking_space: {
    parts: (v) => [box(2.5, 0.03, 5, [0, 0.075, 0], v === 'disabled' ? '#3d6fd1' : '#6a6a74')],
  },
  parking_meter: {
    parts: () => [
      postAt(0, 0, 1.2),
      box(0.3, 0.5, 0.25, [0, 1.4, 0], '#2f6fdc'),
      box(0.2, 0.12, 0.02, [0, 1.5, 0.13], '#9ee0ff', true),
    ],
  },
  trolley_bay: {
    rotates: true,
    parts: () => [
      box(1.1, 0.05, 2.2, [0, 0.06, 0], STEEL),
      box(0.05, 0.9, 2.2, [-0.5, 0.5, 0], STEEL),
      box(0.05, 0.9, 2.2, [0.5, 0.5, 0], STEEL),
      box(1.05, 0.05, 2.2, [0, 0.95, 0], '#e23b2e'),
    ],
  },
  speed_bump: {
    rotates: true,
    parts: (v) =>
      v === 'cushion'
        ? ([-1, 1] as const).map((sx) => box(0.9, 0.1, 1.2, [sx * 0.8, 0.05, 0], '#f2c230'))
        : [
            box(3.2, 0.12, 0.9, [0, 0.06, 0], '#f2c230'),
            ...([-1.2, -0.4, 0.4, 1.2] as const).map((x) =>
              box(0.35, 0.125, 0.92, [x, 0.062, 0], '#2a2a2a')
            ),
          ],
  },
  traffic_signals: {
    parts: () => [
      cyl(0.08, 0.1, 4, 8, [0, 2, 0], POLE),
      box(0.35, 1, 0.35, [0, 3.4, 0], '#2a2a2a'),
      circ(0.1, 12, [0, 3.7, 0.18], '#ff3b30'),
    ],
  },

  /* ---------- 4. utilities, infrastructure & emergency ---------- */
  fire_hydrant: {
    parts: (v) =>
      v === 'underground'
        ? [cyl(0.2, 0.2, 0.04, 12, [0, 0.045, 0], '#e23b2e'), postAt(0.5, 0, 0.9, '#ffd93d')]
        : [cyl(0.18, 0.22, 0.7, 8, [0, 0.35, 0], '#e23b2e'), sph(0.2, [0, 0.75, 0], '#e23b2e')],
  },
  manhole: {
    parts: (v) => [
      cyl(0.45, 0.45, 0.04, 14, [0, 0.045, 0], MANHOLE_COLOR[v] ?? MANHOLE_COLOR.sewer!),
    ],
  },
  street_cabinet: {
    parts: () => [
      box(0.9, 1.5, 0.5, [0, 0.75, 0], '#7d8a80'),
      box(0.85, 1.4, 0.02, [0, 0.75, 0.26], '#6c786e'),
    ],
  },
  defibrillator: {
    parts: () => [
      postAt(0, 0, 1.4),
      box(0.5, 0.5, 0.25, [0, 1.55, 0], '#2e9e5b'),
      ...crossGlow(1.55, 0.14, '#ffffff'),
    ],
  },
  first_aid_kit: {
    parts: () => [
      postAt(0, 0, 1.4),
      box(0.45, 0.35, 0.2, [0, 1.5, 0], '#f4f4f0'),
      ...crossGlow(1.5, 0.11, '#e23b2e'),
    ],
  },
  fire_alarm: {
    parts: () => [
      postAt(0, 0, 1.4),
      box(0.25, 0.3, 0.15, [0, 1.45, 0], '#e23b2e'),
      box(0.12, 0.1, 0.02, [0, 1.5, 0.09], '#ffffff', true),
    ],
  },
  surveillance: {
    parts: (v) => [
      cyl(0.06, 0.08, 4, 8, [0, 2, 0], POLE),
      ...(v === 'dome'
        ? [sph(0.25, [0, 4.05, 0], '#2a2a2a')]
        : [
            box(0.2, 0.2, 0.5, [0, 4.1, 0.2], '#2a2a2a', false, [0.3, 0, 0]),
            sph(0.04, [0, 4.0, 0.46], '#ff3b30', true),
          ]),
    ],
  },
  water_tank: {
    parts: () => [
      cyl(1.4, 1.4, 3, 16, [0, 1.5, 0], '#9fb7c8'),
      cyl(1.5, 1.5, 0.2, 16, [0, 3.1, 0], '#6f8aa0'),
      box(0.1, 3, 0.3, [1.45, 1.5, 0], '#5a5a5a'),
    ],
  },
  air_conditioner: {
    parts: () => [
      box(1, 0.8, 0.5, [0, 0.4, 0], '#d8dde2'),
      circ(0.28, 16, [0, 0.4, 0.255], '#3a3f45', false),
    ],
  },
  tower: { parts: towerParts(false) },
  water_tower: { parts: towerParts(true) },
  power_pole: { parts: powerParts(false) },
  power_tower: { parts: powerParts(true) },
  recycling: {
    parts: () =>
      (
        [
          [-0.8, '#4caf50'],
          [0, '#2196f3'],
          [0.8, '#ff9800'],
        ] as const
      ).map(([dx, c]) => box(0.7, 1.2, 0.7, [dx, 0.6, 0], c)),
  },
  atm: {
    parts: () => [
      box(1, 2.4, 0.6, [0, 1.2, 0], '#455a64'),
      box(0.7, 0.5, 0.02, [0, 1.6, 0.31], '#9ee0ff', true),
    ],
  },

  /* ---------- 5. signage & information ---------- */
  flagpole: {
    parts: () => [
      cyl(0.5, 0.65, 0.3, 16, [0, 0.15, 0], '#c8c8c0'),
      cyl(0.08, 0.1, 10, 12, [0, 5, 0], '#d0d0d0'),
      sph(0.14, [0, 10.15, 0], '#d4af37'),
    ],
  },
  notice_board: {
    rotates: true,
    parts: () => [
      postAt(-0.9, 0, 2.2),
      postAt(0.9, 0, 2.2),
      box(2, 1.1, 0.1, [0, 1.7, 0], '#8a5a3a'),
      box(1.8, 0.9, 0.02, [0, 1.7, 0.06], '#d7b07a'),
      box(0.35, 0.45, 0.02, [-0.5, 1.7, 0.08], '#ffffff'),
      box(0.35, 0.3, 0.02, [0.2, 1.8, 0.08], '#ffe066'),
      box(0.3, 0.4, 0.02, [0.65, 1.62, 0.08], '#ffb6c1'),
    ],
  },
  info_board: {
    parts: () => [
      cyl(0.07, 0.09, 2, 8, [0, 1, 0], POLE),
      box(2.2, 1.3, 0.1, [0, 2.1, 0], '#1565c0'),
    ],
  },
  guidepost: {
    parts: () => [
      cyl(0.08, 0.1, 2, 8, [0, 1, 0], POLE),
      box(0.9, 0.6, 0.08, [0, 2.1, 0], '#1a4d8c'),
    ],
  },
  milestone: {
    parts: () => [
      box(0.35, 0.7, 0.2, [0, 0.35, 0], '#d8d3c6'),
      sph(0.18, [0, 0.72, 0], '#d8d3c6'),
      box(0.36, 0.1, 0.21, [0, 0.55, 0], '#e23b2e'),
    ],
  },
  statue: {
    parts: () => [
      cyl(0.9, 1.05, 0.6, 12, [0, 0.3, 0], '#c9c4b8'),
      cyl(0.35, 0.5, 1.8, 12, [0, 1.5, 0], '#d8d3c6'),
      sph(0.45, [0, 2.6, 0], '#e2ddd0'),
      cone(0.25, 0.45, 10, [0, 3.2, 0], '#ffd700'),
    ],
  },

  /* ---------- 6. nature ---------- */
  flower: {
    parts: () => [
      cyl(0.4, 0.45, 0.12, 10, [0, 0.06, 0], '#6b4f35'),
      sph(0.14, [0, 0.28, 0], '#ff6b9a'),
      sph(0.14, [0.22, 0.25, 0.05], '#ffd93d'),
      sph(0.14, [-0.2, 0.26, 0.1], '#ffffff'),
      sph(0.14, [0.05, 0.25, -0.22], '#b48cff'),
      sph(0.14, [-0.1, 0.24, -0.15], '#ff8c42'),
    ],
  },

  /* ---------- 7. indoor mapping ---------- */
  elevator: {
    rotates: true,
    parts: () => [
      box(1.8, 2.8, 1.8, [0, 1.4, 0], '#aab4bd'),
      box(0.9, 2.2, 0.02, [0, 1.2, 0.91], '#9ee0ff', true),
      box(2, 0.15, 2, [0, 2.88, 0], '#5a6570'),
    ],
  },
  locker: {
    rotates: true,
    parts: () =>
      (['#3c6ec9', '#e8683a', '#4caf50', '#ffd93d'] as const).map((c, i) =>
        box(0.55, 1.8, 0.5, [(i - 1.5) * 0.6, 0.9, 0], c)
      ),
  },
  vending: {
    rotates: true,
    parts: (v) => [
      box(
        0.9,
        1.9,
        0.8,
        [0, 0.95, 0],
        v === 'food' ? '#ffb300' : v === 'drinks' ? '#d32f2f' : '#607d8b'
      ),
      box(0.6, 1.1, 0.02, [0, 1.1, 0.41], '#fff2c0', true),
    ],
  },
  door: {
    rotates: true,
    parts: (v) =>
      v === 'sliding' || v === 'revolving'
        ? [
            box(1.8, 2.2, 0.16, [0, 1.1, 0], '#9ccdf2'),
            box(1.9, 0.1, 0.18, [0, 2.25, 0], '#455a64'),
          ]
        : [box(1.0, 2.1, 0.16, [0, 1.05, 0], '#6b4a2f'), sph(0.05, [0.35, 1.0, 0.1], '#d4af37')],
  },

  /* ---------- shops & misc ---------- */
  bank: { parts: shopParts('#c8e0ff', '#2f5cad', '#3c6ec9'), label: SHOP_LABEL },
  shop: { parts: shopParts('#b8e0ff', '#3c6ec9', '#ffe066'), label: SHOP_LABEL },
  grocery: { parts: shopParts('#c8e0ff', '#2f5cad', '#4caf50'), label: SHOP_LABEL },
  cafe: { parts: shopParts('#a1887f', '#6d4c41', '#ffb347'), label: SHOP_LABEL },
  restaurant: { parts: shopParts('#d68c6a', '#8a4b30', '#ff5e5e'), label: SHOP_LABEL },
  fast_food: { parts: shopParts('#ffb347', '#c8302e', '#ffe066'), label: SHOP_LABEL },
  shed: {
    parts: () => [
      ...([-1.9, 1.9] as const).flatMap((dx) =>
        ([-1.9, 1.9] as const).map((dz) => cyl(0.11, 0.13, 2.8, 8, [dx, 1.4, dz], '#8a6b4a'))
      ),
      box(3.8, 0.1, 0.1, [0, 2.75, -1.9], '#7a5a3a'),
      box(3.8, 0.1, 0.1, [0, 2.75, 1.9], '#7a5a3a'),
      box(0.1, 0.1, 3.8, [-1.9, 2.75, 0], '#7a5a3a'),
      box(0.1, 0.1, 3.8, [1.9, 2.75, 0], '#7a5a3a'),
      box(4.4, 0.2, 4.4, [0, 2.92, 0], '#a87858'),
      box(4.5, 0.06, 4.5, [0, 3.06, 0], '#c89870'),
    ],
    label: { y: 4.2, size: 0.8, color: '#1a1a2e', outline: '#ffffff', outlineWidth: 0.05 },
  },
  generic: { parts: () => [box(1, 0.8, 1, [0, 0.4, 0], '#d0d0d0')] },
} satisfies Record<string, FeatureDef>;

type FeatureKey = keyof typeof FEATURES;
const featureDef = (k: FeatureKey): FeatureDef => FEATURES[k];

const NODE_ALIAS: Partial<Record<NodeKind, FeatureKey>> = {
  monument: 'statue',
  waste_disposal: 'waste_basket',
  phone: 'generic',
  post_box: 'generic',
};

function renderKeyOf(kind: NodeKind, name?: string): FeatureKey | 'tree' | null {
  if (kind === 'tree') return 'tree';
  if (kind === 'generic') return name ? 'generic' : null;
  const k = NODE_ALIAS[kind] ?? kind;
  return k in FEATURES ? (k as FeatureKey) : null;
}

/**
 * Point features whose glow parts are only "lit" at night. Everything else
 * keeps its emissive accents regardless of ambiance (screens, emergency
 * crosses, traffic lights, etc.).
 */
const NIGHT_ONLY_GLOW: ReadonlySet<FeatureKey> = new Set<FeatureKey>(['street_lamp']);

function grassRadiusFor(kind: NodeKind): number {
  switch (kind) {
    case 'tree':
    case 'statue':
    case 'monument':
      return 1.6;
    case 'flagpole':
      return 1.4;
    case 'fountain':
      return 4.2;
    case 'toilet':
    case 'shed':
    case 'shelter':
    case 'bus_stop':
      return 3;
    case 'shop':
    case 'bank':
    case 'grocery':
    case 'cafe':
    case 'restaurant':
    case 'fast_food':
      return 4;
    case 'bicycle_parking':
    case 'recycling':
    case 'lounger':
    case 'planter':
    case 'notice_board':
    case 'locker':
      return 2;
    case 'water_tank':
    case 'elevator':
      return 2.2;
    case 'air_conditioner':
    case 'street_cabinet':
    case 'vending':
    case 'trolley_bay':
      return 1.2;
    case 'power_pole':
    case 'street_lamp':
    case 'power_tower':
    case 'bollard':
    case 'surveillance':
      return 1;
    case 'bench':
    case 'table':
      return 1.2;
    default:
      return 0.8;
  }
}

/* ============================================================
 * 8. SCENE DATA
 * ============================================================ */

interface RouteSummary {
  ref?: string;
  name?: string;
  network?: string;
}

interface BuildingData {
  id: number;
  tags: Tags;
  kind: BuildingKind;
  height: number;
  ring: XY[];
  cx: number;
  cz: number;
  area: number;
  lat: number;
  lon: number;
  name?: string;
  address?: string;
}

interface PointItem {
  id: number;
  x: number;
  z: number;
  key: FeatureKey | 'tree';
  name?: string;
  shrub: boolean;
  rotation: number;
  /** Tag-derived look variant (see `variantOf`). */
  variant: string;
  /** Tree scale (from `height`). */
  size: number;
  /** `leaf_type=needleleaved` */
  conifer: boolean;
}

interface SceneData {
  nodeMap: Map<number, OsmNode>;
  wayIndex: Map<number, OsmWay>;
  projection: Projection;
  center: LatLon;
  extent: Box;
  campus: XY[];
  wayXY: Map<number, XY[]>;
  buildings: BuildingData[];
  buildingById: Map<number, BuildingData>;
  labelIds: number[];
  canopyRings: XY[][];
  roads: OsmWay[];
  footways: OsmWay[];
  steps: OsmWay[];
  parkings: OsmWay[];
  parkingSpaces: OsmWay[];
  parks: OsmWay[];
  flowerbeds: OsmWay[];
  waters: OsmWay[];
  barriers: OsmWay[];
  powerLines: OsmWay[];
  multipolygons: OsmRelation[];
  routeRelations: RouteSummary[];
  trees: PointItem[];
  features: PointItem[];
  waterPolygons: XY[][];
  flowerbedPolys: XY[][];
  flowers: Flower[];
  pointCircles: { x: number; z: number; r: number }[];
}

function extentFromBounds(doc: OsmDocument, projection: Projection): Box | null {
  if (!doc.bounds) return null;
  const { minLat, maxLat, minLon, maxLon } = doc.bounds;
  if (![minLat, maxLat, minLon, maxLon].every(Number.isFinite)) return null;
  return boundsOf([
    projection({ lat: minLat, lon: minLon }),
    projection({ lat: minLat, lon: maxLon }),
    projection({ lat: maxLat, lon: minLon }),
    projection({ lat: maxLat, lon: maxLon }),
  ]);
}

function buildSceneData(doc: OsmDocument): SceneData {
  const nodeMap = new Map(doc.nodes.map((n) => [n.id, n] as const));
  const wayIndex = new Map(doc.ways.map((w) => [w.id, w] as const));
  const center = computeDocCenter(doc);
  const projection = makeProjection(center);

  // every way is resolved + projected at most once
  const wayXY = new Map<number, XY[]>();
  const xyOf = (way: OsmWay): XY[] | null => {
    const hit = wayXY.get(way.id);
    if (hit) return hit;
    const path = resolveWayPath(way, nodeMap);
    if (!path) return null;
    const xy = latLonPathToXY(path, projection);
    wayXY.set(way.id, xy);
    return xy;
  };

  const classified = doc.ways.map((way) => ({ way, cls: classifyWay(way.tags) }));
  const waysOf = (...ks: WayKind[]) =>
    classified.filter((r) => ks.includes(r.cls)).map((r) => r.way);

  const roads = waysOf('road');
  const footways = waysOf('footway');
  const stepWays = waysOf('steps');
  const parkings = waysOf('parking');
  const parkingSpaces = waysOf('parking_space');
  const parks = waysOf('park', 'landuse');
  const flowerbeds = waysOf('flowerbed');
  const waters = waysOf('water');
  const barriers = waysOf('barrier');
  const powerLines = waysOf('power_line');
  const treeRows = waysOf('tree_row');
  [
    roads,
    footways,
    stepWays,
    parkings,
    parkingSpaces,
    parks,
    flowerbeds,
    waters,
    barriers,
    powerLines,
    treeRows,
  ].forEach((ws) => ws.forEach(xyOf));

  // buildings + canopies
  const records = classified
    .filter((r) => r.cls === 'building' || r.cls === 'canopy')
    .flatMap(({ way, cls }) => {
      const path = resolveWayPath(way, nodeMap);
      if (!path || !isClosedPath(path)) return [];
      const ring = cleanRing(latLonPathToXY(path, projection));
      if (ring.length < 3 || polygonArea(ring) < 6) return [];
      return [{ way, cls, ring }];
    });
  const rejectedBuildings =
    classified.filter((r) => r.cls === 'building' || r.cls === 'canopy').length - records.length;

  const buildings: BuildingData[] = records
    .filter((r) => r.cls === 'building')
    .map(({ way, ring }) => {
      const kind = osmBuildingKind(way.tags);
      const [cx, cz] = centroid(ring);
      const ll = unproject([cx, cz], center);
      return {
        id: way.id,
        tags: way.tags,
        kind,
        height: resolveBuildingHeight(way.tags, kind),
        ring,
        cx,
        cz,
        area: polygonArea(ring),
        lat: ll.lat,
        lon: ll.lon,
        name: bestName(way.tags),
        address: formatAddress(way.tags),
      };
    });
  const canopyRings = records.filter((r) => r.cls === 'canopy').map((r) => r.ring);
  const buildingById = new Map(buildings.map((b) => [b.id, b] as const));
  const labelIds = buildings
    .filter((b) => !!b.name)
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_BUILDING_LABELS)
    .map((b) => b.id);

  // relations
  const multipolygons = doc.relations.filter(
    (r) => r.tags.type === 'multipolygon' || r.tags.type === 'boundary'
  );
  const routeRelations = doc.relations
    .filter((r) => r.tags.type === 'route')
    .map((r) => ({ ref: r.tags.ref, name: r.tags.name, network: r.tags.network }));

  const polysOf = (ways: OsmWay[]) =>
    ways.flatMap((w) => {
      const pts = wayXY.get(w.id);
      return pts && pts.length >= 3 ? [pts] : [];
    });
  const waterPolygons = polysOf(waters);
  const flowerbedPolys = polysOf(flowerbeds);

  // extent
  const extentPts: XY[] = [
    ...buildings.flatMap((b) => b.ring),
    ...canopyRings.flat(),
    ...[roads, footways, stepWays, parkings, parks, waters, barriers].flatMap((ws) =>
      ws.flatMap((w) => wayXY.get(w.id) ?? [])
    ),
  ].filter(isFiniteXY);
  const fallbackBox = boundsOf(extentPts);
  const extent: Box =
    extentFromBounds(doc, projection) ??
    (Number.isFinite(fallbackBox.minX)
      ? fallbackBox
      : { minX: -50, maxX: 50, minZ: -50, maxZ: 50 });

  const margin = Math.max(
    30,
    Math.max(extent.maxX - extent.minX, extent.maxZ - extent.minZ) * 0.05
  );
  const insideExtent = ([x, z]: XY) =>
    isFiniteXY([x, z]) &&
    x >= extent.minX - margin &&
    x <= extent.maxX + margin &&
    z >= extent.minZ - margin &&
    z <= extent.maxZ + margin;

  // lazily-built grids used to orient speed bumps (across roads) and doors (along walls)
  const roadSegAt = lazy(() =>
    buildGrid(
      roads.flatMap((w) => {
        const p = wayXY.get(w.id);
        return p ? segsOf(p, false, 8) : [];
      }),
      segBox
    )
  );
  const wallSegAt = lazy(() =>
    buildGrid(
      buildings.flatMap((b) => segsOf(b.ring, true, 1.5)),
      segBox
    )
  );

  // point features
  const nodePoints = doc.nodes.flatMap((node) => {
    const kind = classifyNode(node.tags);
    if (kind === 'ignore' || node.lat === undefined || node.lon === undefined) return [];
    const p = projection({ lat: node.lat, lon: node.lon });
    if (!insideExtent(p)) return [];
    const name = bestName(node.tags);
    const key = renderKeyOf(kind, name);
    let rotation = (((node.id * 2654435761) >>> 0) % 628) / 100;
    let visible = key !== null;
    const mode = ALIGN[kind];
    if (key && mode) {
      const dir = nearestDir(
        (mode === 'along' ? wallSegAt() : roadSegAt())(p[0], p[1]),
        p[0],
        p[1]
      );
      if (dir) rotation = alignRotation(mode, dir);
      else if (kind === 'door') visible = false; // doors only make sense on a wall
    }
    const item: PointItem | null =
      key && visible
        ? {
            id: node.id,
            x: p[0],
            z: p[1],
            key,
            name,
            shrub: node.tags.natural === 'shrub',
            rotation,
            variant: variantOf(kind, node.tags),
            size: treeSize(node.tags),
            conifer: node.tags.leaf_type === 'needleleaved',
          }
        : null;
    return [{ item, circle: { x: p[0], z: p[1], r: grassRadiusFor(kind) } }];
  });

  // tree rows → individual trees along the line
  const rowTrees = treeRows.flatMap((w): PointItem[] => {
    const pts = wayXY.get(w.id);
    if (!pts || pts.length < 2) return [];
    const total = pathLength(pts);
    const spacing = THREE.MathUtils.clamp(firstNum(w.tags.spacing) || 7, 3, 20);
    const n = Math.min(400, Math.floor(total / spacing) + 1);
    const size = treeSize(w.tags);
    const conifer = w.tags.leaf_type === 'needleleaved';
    return Array.from({ length: n }, (_, i): PointItem => {
      const [x, z] = pointAt(pts, i * spacing);
      return {
        id: w.id * 1000 + i,
        x,
        z,
        key: 'tree',
        shrub: false,
        rotation: 0,
        variant: '',
        size,
        conifer,
      };
    }).filter((t) => insideExtent([t.x, t.z]));
  });

  const pointCircles = [
    ...nodePoints.map((n) => n.circle),
    ...rowTrees.map((t) => ({ x: t.x, z: t.z, r: 1.6 })),
  ];
  const items = nodePoints.flatMap((n) => (n.item ? [n.item] : []));
  const trees = [...items.filter((i) => i.key === 'tree'), ...rowTrees];
  const features = items.filter((i) => i.key !== 'tree');

  // flowerbeds → instanced flowers (rejection-sampled inside each polygon)
  const flowers: Flower[] = [];
  flowerbedPolys.forEach((poly, bi) => {
    if (flowers.length >= MAX_FLOWERS) return;
    const b = boundsOf(poly);
    const target = Math.min(300, Math.round(polygonArea(poly) * 1.5), MAX_FLOWERS - flowers.length);
    const rng = seededRand(bi * 7919 + 13);
    for (let k = 0, tries = 0; k < target && tries < target * 8; tries++) {
      const x = b.minX + rng() * (b.maxX - b.minX);
      const z = b.minZ + rng() * (b.maxZ - b.minZ);
      if (!pointInPolygon(x, z, poly)) continue;
      flowers.push([x, z, Math.floor(rng() * FLOWER_COLORS.length)]);
      k++;
    }
  });

  const campus = paddedHull(
    [...extentPts.filter(insideExtent), ...pointCircles.map((c): XY => [c.x, c.z])],
    12
  );

  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log(
      '[OsmMap3D] scene built:',
      `${buildings.length} buildings (${rejectedBuildings} rejected),`,
      `${canopyRings.length} canopies, ${roads.length} roads, ${footways.length} footways,`,
      `${stepWays.length} steps, ${parkings.length} parkings, ${parkingSpaces.length} spaces,`,
      `${parks.length} green, ${flowerbeds.length} flowerbeds, ${waters.length} water,`,
      `${barriers.length} barriers, ${powerLines.length} power lines,`,
      `${multipolygons.length} multipolygons, ${routeRelations.length} routes,`,
      `${items.length} points, ${rowTrees.length} row trees, ${flowers.length} flowers |`,
      `extent ${Math.round(extent.maxX - extent.minX)} × ${Math.round(extent.maxZ - extent.minZ)} m`
    );
  }

  return {
    nodeMap,
    wayIndex,
    projection,
    center,
    extent,
    campus,
    wayXY,
    buildings,
    buildingById,
    labelIds,
    canopyRings,
    roads,
    footways,
    steps: stepWays,
    parkings,
    parkingSpaces,
    parks,
    flowerbeds,
    waters,
    barriers,
    powerLines,
    multipolygons,
    routeRelations,
    trees,
    features,
    waterPolygons,
    flowerbedPolys,
    flowers,
    pointCircles,
  };
}

/**
 * Locate the building that contains a given geographic coordinate.
 * Returns null when the point isn't inside any building footprint.
 */
function findBuildingAt(scene: SceneData, lat: number, lon: number): BuildingData | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const xy = scene.projection({ lat, lon });
  if (!isFiniteXY(xy)) return null;
  const [x, z] = xy;
  for (const b of scene.buildings) {
    if (pointInPolygon(x, z, b.ring)) return b;
  }
  return null;
}

/* ============================================================
 * 9. MERGED STATIC LAYERS (roads, parks, water, barriers, steps, canopies…)
 * ============================================================ */

interface Layer {
  key: string;
  geometry: THREE.BufferGeometry;
  color?: string;
  tex?: CenterLine;
  basic?: boolean;
  opacity?: number;
  doubleSide?: boolean;
  shadow?: 'none' | 'receive' | 'both';
}

type G = THREE.BufferGeometry | null;

function multipolygonStyle(tags: Tags): { color: string; y: number } {
  const { leisure, sport } = tags;
  if (leisure === 'track' || sport === 'running' || sport === 'athletics')
    return { color: '#c8654a', y: 0.03 };
  if (leisure === 'pitch') {
    if (sport === 'soccer' || sport === 'football') return { color: '#4caf50', y: 0.042 };
    if (sport === 'basketball') return { color: '#d68c6a', y: 0.042 };
    if (sport === 'tennis') return { color: '#5d9c59', y: 0.042 };
    return { color: '#8bc34a', y: 0.042 };
  }
  if (leisure === 'sports_centre' || leisure === 'stadium') return { color: '#4caf50', y: 0.042 };
  if (leisure === 'park' || leisure === 'garden') return { color: '#9ade6b', y: 0.03 };
  if (tags.natural === 'water' || tags.water) return { color: '#6fc4ec', y: 0.1 };
  if (tags.landuse === 'grass' || tags.landuse === 'meadow') return { color: '#9ade6b', y: 0.025 };
  if (tags.landuse === 'flowerbed' || tags.natural === 'flowerbed')
    return { color: '#7b5a3c', y: 0.032 };
  return { color: '#bbbbbb', y: 0.03 };
}

function buildMultipolygonGeometry(relation: OsmRelation, scene: SceneData, y: number): G {
  const mp = assembleMultipolygon(relation, { wayIndex: scene.wayIndex, nodeMap: scene.nodeMap });
  if (!mp) return null;
  const outers = mp.outers.map((r) => r.coords.map((ll) => scene.projection(ll)));
  const inners = mp.inners.map((r) => r.coords.map((ll) => scene.projection(ll)));
  const all = [...outers.flat(), ...inners.flat()];
  if (all.length < 3) return null;
  const [cx, cz] = centroid(all);
  const primary = outers.reduce<XY[] | null>(
    (best, ring) => (!best || polygonArea(ring) > polygonArea(best) ? ring : best),
    null
  );
  if (!primary) return null;
  const shape = shapeFrom(primary, cx, cz);
  inners
    .filter((ring) => ring.length >= 4)
    .forEach((ring) => {
      const hole = new THREE.Path();
      ring.forEach(([x, z], i) => {
        const px = x - cx;
        const py = -(z - cz);
        if (i === 0) hole.moveTo(px, py);
        else hole.lineTo(px, py);
      });
      hole.closePath();
      shape.holes.push(hole);
    });
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(cx, y, cz);
  return geometry;
}

function buildPowerLineGeometry(way: OsmWay, xy: XY[], extent: Box): G {
  const margin = 30;
  const inside = ([x, z]: XY) =>
    x >= extent.minX - margin &&
    x <= extent.maxX + margin &&
    z >= extent.minZ - margin &&
    z <= extent.maxZ + margin;

  const runs = xy
    .reduce<XY[][]>(
      (acc, p) => {
        if (inside(p)) acc[acc.length - 1]!.push(p);
        else if (acc[acc.length - 1]!.length > 0) acc.push([]);
        return acc;
      },
      [[]]
    )
    .filter((r) => r.length >= 2);
  if (runs.length === 0) return null;
  const longest = runs.reduce((a, r) => (r.length > a.length ? r : a));

  const cableCount = parseInt(splitTag(way.tags.cables)[0] ?? '2', 10);
  const width = Number.isFinite(cableCount) ? Math.min(2.4, Math.max(0.6, cableCount * 0.25)) : 1.0;
  const geometry = buildRibbon(longest, width, 8);
  if (!geometry) return null;

  const voltage = parseFloat(splitTag(way.tags.voltage)[0] ?? '0');
  const height =
    Number.isFinite(voltage) && voltage > 0
      ? THREE.MathUtils.clamp((voltage / 1000) * 0.2, 10, 35)
      : 15;
  geometry.translate(0, height, 0);
  return geometry;
}

const lanesOf = (tags: Tags) => parseInt(splitTag(tags.lanes)[0] ?? '2', 10);
const roadWidth = (tags: Tags): number => {
  const w = firstNum(tags.width);
  if (Number.isFinite(w) && w >= 0.5) return Math.min(w, 30);
  if (isFootTags(tags)) return 2.2;
  const lanes = lanesOf(tags);
  return Number.isFinite(lanes) ? Math.max(3, lanes * 3.2) : 5;
};

function buildLayers(scene: SceneData): Layer[] {
  const { wayXY } = scene;
  const items = (ways: OsmWay[]) =>
    ways.flatMap((way) => {
      const pts = wayXY.get(way.id);
      return pts ? [{ way, pts }] : [];
    });
  const flat = (pts: XY[], y: number): G => {
    try {
      const b = buildFlatPolygon(pts);
      if (!b) return null;
      b.geometry.translate(b.cx, y, b.cz);
      return b.geometry;
    } catch {
      return null;
    }
  };
  const ribbon = (pts: XY[], w: number, period: number, y: number): G => {
    const g = buildRibbon(pts, w, period);
    g?.translate(0, y, 0);
    return g;
  };
  const emit = (spec: Omit<Layer, 'geometry'>, geoms: G[]): Layer[] => {
    const merged = mergeGeometries(geoms.filter((g): g is THREE.BufferGeometry => g !== null));
    return merged ? [{ ...spec, geometry: merged }] : [];
  };

  const parkItems = items(scene.parks);
  const isForest = (w: OsmWay) => w.tags.landuse === 'forest';
  const roadItems = items(scene.roads);
  const isYellow = (w: OsmWay) => lanesOf(w.tags) > 1;
  const waterItems = items(scene.waters);
  const isPool = (w: OsmWay) => w.tags.leisure === 'swimming_pool';
  const spaceItems = items(scene.parkingSpaces);
  const isAccessible = (w: OsmWay) => w.tags.parking_space === 'disabled';

  const mpGroups = scene.multipolygons
    .map((rel) => {
      const style = multipolygonStyle(rel.tags);
      return { style, geometry: buildMultipolygonGeometry(rel, scene, style.y) };
    })
    .reduce((m, { style, geometry }) => {
      const k = style.color;
      const list = m.get(k) ?? [];
      list.push(geometry);
      m.set(k, list);
      return m;
    }, new Map<string, G[]>());

  const canopyGeoms = scene.canopyRings.map((ring): G => {
    const b = buildBuildingGeometry(ring, 0.25);
    b?.geometry.translate(b.cx, 2.8, b.cz);
    return b?.geometry ?? null;
  });

  // barriers: one merged mesh per colour (walls, fences, hedges, rails…)
  const barrierGroups = items(scene.barriers).reduce((m, { way, pts }) => {
    const s = barrierSpec(way.tags);
    const list = m.get(s.color) ?? [];
    list.push(buildWallStrip(pts, s.top, s.t, s.base));
    m.set(s.color, list);
    return m;
  }, new Map<string, G[]>());

  // steps: treads + optional handrails
  const stepGeoms = items(scene.steps).map((i) => buildStepGeoms(i.way.tags, i.pts));

  return [
    ...emit(
      { key: 'park', color: '#9ade6b' },
      parkItems.filter((i) => !isForest(i.way)).map((i) => flat(i.pts, 0.025))
    ),
    ...emit(
      { key: 'forest', color: '#6db24e' },
      parkItems.filter((i) => isForest(i.way)).map((i) => flat(i.pts, 0.025))
    ),
    ...emit(
      { key: 'flowerbed', color: '#7b5a3c' },
      items(scene.flowerbeds).map((i) => flat(i.pts, 0.032))
    ),
    ...[...mpGroups].flatMap(([color, geoms]) =>
      emit({ key: `mp-${color}`, color, doubleSide: true }, geoms)
    ),
    ...emit(
      { key: 'pool-base', color: '#cfc9b8' },
      waterItems.filter((i) => isPool(i.way)).map((i) => flat(i.pts, 0.1))
    ),
    ...emit(
      { key: 'water', color: '#6fc4ec', opacity: 0.9 },
      waterItems.map((i) => flat(i.pts, isPool(i.way) ? 0.16 : 0.12))
    ),
    ...emit(
      { key: 'road-yellow', tex: 'yellow-dash', shadow: 'none' },
      roadItems
        .filter((i) => isYellow(i.way))
        .map((i) => ribbon(i.pts, roadWidth(i.way.tags), 8, 0.05))
    ),
    ...emit(
      { key: 'road-white', tex: 'white-dash', shadow: 'none' },
      roadItems
        .filter((i) => !isYellow(i.way))
        .map((i) => ribbon(i.pts, roadWidth(i.way.tags), 8, 0.05))
    ),
    ...emit(
      { key: 'foot', color: '#d8c8a8' },
      items(scene.footways).map((i) => ribbon(i.pts, roadWidth(i.way.tags), 8, 0.045))
    ),
    ...emit(
      { key: 'parking', color: '#4a4a52' },
      items(scene.parkings).map((i) => flat(i.pts, 0.065))
    ),
    ...emit(
      { key: 'pspace', color: '#6a6a74' },
      spaceItems.filter((i) => !isAccessible(i.way)).map((i) => flat(i.pts, 0.07))
    ),
    ...emit(
      { key: 'pspace-acc', color: '#3d6fd1' },
      spaceItems.filter((i) => isAccessible(i.way)).map((i) => flat(i.pts, 0.07))
    ),
    ...emit(
      { key: 'pspace-line', color: '#f0f0f0', basic: true, shadow: 'none' },
      spaceItems.map((i) => ribbon(i.pts, 0.12, 4, 0.08))
    ),
    ...[...barrierGroups].flatMap(([color, geoms]) =>
      emit({ key: `bar-${color}`, color, doubleSide: true, shadow: 'both' }, geoms)
    ),
    ...emit(
      { key: 'steps', color: '#cfc6b4', doubleSide: true, shadow: 'both' },
      stepGeoms.flatMap((s) => s.treads)
    ),
    ...emit(
      { key: 'step-rails', color: '#5d6b78', doubleSide: true, shadow: 'both' },
      stepGeoms.flatMap((s) => s.rails)
    ),
    ...emit(
      { key: 'power', color: '#2d2d35', basic: true, shadow: 'none' },
      items(scene.powerLines).map((i) => buildPowerLineGeometry(i.way, i.pts, scene.extent))
    ),
    ...emit({ key: 'canopy', color: '#2e8b8b', shadow: 'both' }, canopyGeoms),
  ];
}

const StaticLayers = memo(function StaticLayers({ scene }: { scene: SceneData }) {
  const layers = useMemo(() => buildLayers(scene), [scene]);
  useEffect(() => () => layers.forEach((l) => l.geometry.dispose()), [layers]);
  return (
    <>
      {layers.map((l) => (
        <mesh
          key={l.key}
          geometry={l.geometry}
          castShadow={l.shadow === 'both'}
          receiveShadow={l.shadow !== 'none'}
          raycast={noRaycast}
        >
          {l.tex ? (
            <meshBasicMaterial map={makeRoadTexture(l.tex, true)} toneMapped={false} />
          ) : l.basic ? (
            <meshBasicMaterial color={l.color} toneMapped={false} />
          ) : (
            <meshToonMaterial
              color={l.color}
              gradientMap={toonGradient}
              side={l.doubleSide ? THREE.DoubleSide : THREE.FrontSide}
              transparent={l.opacity !== undefined}
              opacity={l.opacity ?? 1}
            />
          )}
        </mesh>
      ))}
    </>
  );
});

/* ============================================================
 * 10. SCENE SUB-COMPONENTS (sky, ground)
 * ============================================================ */

function SkyDome({ radius, ambiance }: { radius: number; ambiance: Ambiance }) {
  const tex = useMemo(
    () => (ambiance === 'night' ? getNightSkyTexture() : getSkyTexture()),
    [ambiance]
  );
  return (
    <mesh raycast={noRaycast}>
      <sphereGeometry args={[radius, 32, 16]} />
      <meshBasicMaterial map={tex} side={THREE.BackSide} fog={false} toneMapped={false} />
    </mesh>
  );
}

function Clouds({ radius, ambiance }: { radius: number; ambiance: Ambiance }) {
  const isNight = ambiance === 'night';
  const topColor = isNight ? '#2c3a63' : '#ffffff';
  const sideColor = isNight ? '#26314f' : '#f4f8ff';
  const clouds = useMemo(() => {
    const r = radius * 0.45;
    return (
      [
        [-0.9, 0.35, -1.1],
        [0.6, 0.4, -0.8],
        [1.0, 0.32, 0.4],
        [-1.2, 0.37, 0.2],
        [0.2, 0.42, 1.1],
        [-0.5, 0.36, 1.0],
        [1.2, 0.4, -0.2],
      ] as const
    ).map(([x, y, z]): V3 => [x * r, y * radius, z * r]);
  }, [radius]);
  return (
    <>
      {clouds.map((p, i) => (
        <group key={i} position={p}>
          <mesh raycast={noRaycast}>
            <sphereGeometry args={[radius * 0.06, 12, 8]} />
            <meshBasicMaterial color={topColor} fog={false} />
          </mesh>
          <mesh position={[radius * 0.055, -radius * 0.01, radius * 0.01]} raycast={noRaycast}>
            <sphereGeometry args={[radius * 0.045, 12, 8]} />
            <meshBasicMaterial color={topColor} fog={false} />
          </mesh>
          <mesh position={[-radius * 0.05, -radius * 0.01, -radius * 0.01]} raycast={noRaycast}>
            <sphereGeometry args={[radius * 0.04, 12, 8]} />
            <meshBasicMaterial color={sideColor} fog={false} />
          </mesh>
        </group>
      ))}
    </>
  );
}

const Ground = memo(function Ground({ scene, ambiance }: { scene: SceneData; ambiance: Ambiance }) {
  const campus = useMemo(() => buildFlatPolygon(scene.campus), [scene.campus]);
  const { extent } = scene;
  const cx = (extent.minX + extent.maxX) / 2;
  const cz = (extent.minZ + extent.maxZ) / 2;
  const span = Math.max(extent.maxX - extent.minX, extent.maxZ - extent.minZ, 60);
  const size = Math.max(2400, span * 4);
  const isNight = ambiance === 'night';
  return (
    <>
      <mesh
        position={[cx, -0.05, cz]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
        raycast={noRaycast}
      >
        <planeGeometry args={[size, size]} />
        <meshToonMaterial color={isNight ? '#3a4a3a' : '#a4b892'} gradientMap={toonGradient} />
      </mesh>
      {campus && (
        <mesh
          geometry={campus.geometry}
          position={[campus.cx, 0.005, campus.cz]}
          receiveShadow
          raycast={noRaycast}
        >
          <meshToonMaterial color={isNight ? '#2f4a2f' : '#7fc25c'} gradientMap={toonGradient} />
        </mesh>
      )}
    </>
  );
});

/* ============================================================
 * 11. BUILDINGS (merged per kind, picked by triangle index)
 * ============================================================ */

interface Owners {
  starts: number[];
  ids: number[];
}
interface BuildingLayer {
  kind: BuildingKind;
  caps: THREE.BufferGeometry;
  sides: THREE.BufferGeometry;
  capOwners: Owners;
  sideOwners: Owners;
}

function mergeOwned(parts: { geom: THREE.BufferGeometry; id: number }[]) {
  const geometry = mergeGeometries(parts.map((p) => p.geom));
  if (!geometry) return null;
  const tris = parts.map((p) => p.geom.getAttribute('position').count / 3);
  const starts = tris.reduce<number[]>((acc, _t, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1]! + tris[i - 1]!);
    return acc;
  }, []);
  return { geometry, owners: { starts, ids: parts.map((p) => p.id) } as Owners };
}

function ownerOf({ starts, ids }: Owners, tri: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= tri) lo = mid;
    else hi = mid - 1;
  }
  return ids[lo]!;
}

function buildBuildingLayers(buildings: BuildingData[]): BuildingLayer[] {
  const byKind = buildings
    .flatMap((b) => {
      const built = buildBuildingGeometry(b.ring, b.height);
      if (!built) return [];
      const caps = sliceByMaterial(built.geometry, 0).translate(built.cx, 0, built.cz);
      const sides = sliceByMaterial(built.geometry, 1).translate(built.cx, 0, built.cz);
      built.geometry.dispose();
      return [{ kind: b.kind, id: b.id, caps, sides }];
    })
    .reduce((m, r) => {
      const list = m.get(r.kind) ?? [];
      list.push(r);
      m.set(r.kind, list);
      return m;
    }, new Map<BuildingKind, { kind: BuildingKind; id: number; caps: THREE.BufferGeometry; sides: THREE.BufferGeometry }[]>());

  return [...byKind].flatMap(([kind, list]) => {
    const c = mergeOwned(list.map((r) => ({ geom: r.caps, id: r.id })));
    const s = mergeOwned(list.map((r) => ({ geom: r.sides, id: r.id })));
    return c && s
      ? [{ kind, caps: c.geometry, sides: s.geometry, capOwners: c.owners, sideOwners: s.owners }]
      : [];
  });
}

const Buildings = memo(function Buildings({
  scene,
  onHover,
  onSelect,
}: {
  scene: SceneData;
  onHover: (id: number | null) => void;
  onSelect: (id: number, info: BuildingClickInfo) => void;
}) {
  const layers = useMemo(() => buildBuildingLayers(scene.buildings), [scene.buildings]);
  useEffect(
    () => () =>
      layers.forEach((l) => {
        l.caps.dispose();
        l.sides.dispose();
      }),
    [layers]
  );

  const handlers = (owners: Owners) => ({
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      if (e.faceIndex != null) onHover(ownerOf(owners, e.faceIndex));
    },
    onPointerOut: () => onHover(null),
    onClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (e.faceIndex == null) return;
      const b = scene.buildingById.get(ownerOf(owners, e.faceIndex));
      if (!b) return;
      onSelect(b.id, {
        id: b.id,
        lat: b.lat,
        lon: b.lon,
        name: b.name,
        address: b.address,
        height: b.height,
        kind: b.kind,
        tags: b.tags,
      });
    },
  });

  return (
    <>
      {layers.map((l) => (
        <group key={l.kind}>
          <mesh
            geometry={l.caps}
            material={buildingMaterial(l.kind, 'roof', false)}
            castShadow
            receiveShadow
            {...handlers(l.capOwners)}
          />
          <mesh
            geometry={l.sides}
            material={buildingMaterial(l.kind, 'side', false)}
            castShadow
            receiveShadow
            {...handlers(l.sideOwners)}
          />
        </group>
      ))}
    </>
  );
});

/** One overlay mesh per hovered / selected building (replaces per-building emissive lerp). */
const BuildingHighlight = memo(function BuildingHighlight({ b }: { b: BuildingData }) {
  const built = useMemo(() => buildBuildingGeometry(b.ring, b.height), [b]);
  useEffect(() => () => built?.geometry.dispose(), [built]);
  if (!built) return null;
  return (
    <mesh
      geometry={built.geometry}
      position={[built.cx, 0, built.cz]}
      material={[buildingMaterial(b.kind, 'roof', true), buildingMaterial(b.kind, 'side', true)]}
      raycast={noRaycast}
      renderOrder={1}
    />
  );
});

const Rooftops = memo(function Rooftops({ buildings }: { buildings: BuildingData[] }) {
  const baked = useMemo(
    () =>
      bakeParts(
        buildings.flatMap((b): Part[] => [
          ...(b.height >= 7
            ? [box(2.4, 1, 1.8, [b.cx + 1.2, b.height + 0.5, b.cz + 0.8], '#9aa3ad')]
            : []),
          ...(b.height >= 10
            ? [
                cyl(0.09, 0.12, 3.2, 6, [b.cx - 1.4, b.height + 1.6, b.cz - 0.8], '#b9c2cc'),
                sph(0.22, [b.cx - 1.4, b.height + 3.3, b.cz - 0.8], '#ff5e5e', true),
              ]
            : []),
        ])
      ),
    [buildings]
  );
  useEffect(
    () => () => {
      baked.solid?.dispose();
      baked.glow?.dispose();
    },
    [baked]
  );
  return (
    <>
      {baked.solid && (
        <mesh geometry={baked.solid} castShadow raycast={noRaycast}>
          <meshToonMaterial vertexColors gradientMap={toonGradient} />
        </mesh>
      )}
      {baked.glow && (
        <mesh geometry={baked.glow} raycast={noRaycast}>
          <meshBasicMaterial vertexColors toneMapped={false} />
        </mesh>
      )}
    </>
  );
});

const BuildingLabel = memo(function BuildingLabel({
  b,
  active,
}: {
  b: BuildingData;
  active: boolean;
}) {
  return (
    <Billboard position={[b.cx, b.height + 3, b.cz]}>
      <Text
        fontSize={1.5}
        color={active ? '#ffffff' : '#1a1a2e'}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.09}
        outlineColor={active ? '#1a1a2e' : '#ffffff'}
        fontWeight={800}
      >
        {b.name!}
      </Text>
    </Billboard>
  );
});

const BuildingDetail = memo(function BuildingDetail({ b }: { b: BuildingData }) {
  const text = useMemo(() => {
    const alts = altNames(b.tags)
      .slice(0, 2)
      .map((a) => `${a.key.replace(/_/g, ' ')}: ${a.value}`);
    const stats = parseNamespacedTags(b.tags)
      .slice(0, 2)
      .map((s) => {
        const q = s.qualifiers.date ? ` (${s.qualifiers.date})` : '';
        return `${s.key.replace(/:/g, ' ')}: ${s.value}${q}`;
      });
    return [...(b.address ? [b.address] : []), ...alts, ...stats].join('\n');
  }, [b]);
  if (!text) return null;
  return (
    <Billboard position={[b.cx, b.height + 1.3, b.cz]}>
      <Text
        fontSize={0.85}
        color="#333333"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.06}
        outlineColor="#ffffff"
        fontWeight={600}
        maxWidth={14}
      >
        {text}
      </Text>
    </Billboard>
  );
});

function BuildingOverlays({
  scene,
  showLabels,
  hoveredId,
  selectedId,
}: {
  scene: SceneData;
  showLabels: boolean;
  hoveredId: number | null;
  selectedId: number | null;
}) {
  const activeIds = useMemo(
    () => [...new Set([hoveredId, selectedId].filter((x): x is number => x !== null))],
    [hoveredId, selectedId]
  );
  const active = useMemo(
    () => activeIds.flatMap((id) => scene.buildingById.get(id) ?? []),
    [activeIds, scene.buildingById]
  );
  const labelIds = useMemo(
    () => [...new Set([...(showLabels ? scene.labelIds : []), ...activeIds])],
    [showLabels, scene.labelIds, activeIds]
  );
  const activeSet = useMemo(() => new Set(activeIds), [activeIds]);

  return (
    <>
      {active.map((b) => (
        <BuildingHighlight key={`hl-${b.id}`} b={b} />
      ))}
      {labelIds.flatMap((id) => {
        const b = scene.buildingById.get(id);
        return b?.name ? [<BuildingLabel key={`lb-${id}`} b={b} active={activeSet.has(id)} />] : [];
      })}
      {active.map((b) => (
        <BuildingDetail key={`dt-${b.id}`} b={b} />
      ))}
    </>
  );
}

/* ============================================================
 * 12. POINT FEATURES (instanced per feature + variant)
 * ============================================================ */

const Instanced = memo(function Instanced({
  geometry,
  items,
  rotates,
  glow,
}: {
  geometry: THREE.BufferGeometry;
  items: PointItem[];
  rotates: boolean;
  glow: boolean;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const d = new THREE.Object3D();
    items.forEach((it, i) => {
      d.position.set(it.x, 0, it.z);
      d.rotation.set(0, rotates ? it.rotation : 0, 0);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [items, rotates]);
  return (
    <instancedMesh
      ref={ref}
      args={[geometry, undefined, items.length]}
      castShadow={!glow}
      receiveShadow={!glow}
      frustumCulled={false}
      raycast={noRaycast}
    >
      {glow ? (
        <meshBasicMaterial vertexColors toneMapped={false} />
      ) : (
        <meshToonMaterial vertexColors gradientMap={toonGradient} />
      )}
    </instancedMesh>
  );
});

/** Baked geometry is cached per (feature, variant) for the whole session. */
const bakedCache = new Map<string, ReturnType<typeof bakeParts>>();
const getBaked = (key: FeatureKey, variant: string) => {
  const ck = `${key}|${variant}`;
  const hit = bakedCache.get(ck);
  if (hit) return hit;
  const b = bakeParts(featureDef(key).parts(variant));
  bakedCache.set(ck, b);
  return b;
};

const FeatureInstances = memo(function FeatureInstances({
  featureKey,
  variant,
  items,
}: {
  featureKey: FeatureKey;
  variant: string;
  items: PointItem[];
}) {
  const ambiance = useAmbiance();
  const baked = useMemo(() => getBaked(featureKey, variant), [featureKey, variant]);
  const rotates = !!featureDef(featureKey).rotates;

  // Lamps (and other night-only emissives) are only lit under `ambiance="night"`.
  const nightOnly = NIGHT_ONLY_GLOW.has(featureKey);
  const showGlow = baked.glow !== null && (!nightOnly || ambiance === 'night');

  return (
    <>
      {baked.solid && (
        <Instanced geometry={baked.solid} items={items} rotates={rotates} glow={false} />
      )}
      {showGlow && baked.glow && (
        <Instanced geometry={baked.glow} items={items} rotates={rotates} glow />
      )}
    </>
  );
});

interface FeatureGroup {
  key: FeatureKey;
  variant: string;
  items: PointItem[];
}

const FeatureLayer = memo(function FeatureLayer({ features }: { features: PointItem[] }) {
  const groups = useMemo(
    () => [
      ...features
        .reduce((m, f) => {
          const k = `${f.key}|${f.variant}`;
          const g = m.get(k);
          if (g) g.items.push(f);
          else m.set(k, { key: f.key as FeatureKey, variant: f.variant, items: [f] });
          return m;
        }, new Map<string, FeatureGroup>())
        .values(),
    ],
    [features]
  );
  return (
    <>
      {groups.map((g) => (
        <FeatureInstances
          key={`${g.key}|${g.variant}`}
          featureKey={g.key}
          variant={g.variant}
          items={g.items}
        />
      ))}
    </>
  );
});

const FOLIAGE_COLORS = ['#4db84d', '#3aa840', '#5fc26b', '#a0d468', '#7dd1a0'].map(
  (c) => new THREE.Color(c)
);
const CONIFER_COLORS = ['#2f7d4a', '#276b3e', '#3a8a55'].map((c) => new THREE.Color(c));

/** Trees, shrubs and tree-row trees. Size follows `height`; `leaf_type=needleleaved` → tall conifer. */
const Trees = memo(function Trees({ trees }: { trees: PointItem[] }) {
  const trunkRef = useRef<THREE.InstancedMesh>(null);
  const foliageRef = useRef<THREE.InstancedMesh>(null);
  const trunks = useMemo(() => trees.filter((t) => !t.shrub), [trees]);
  const trunkGeo = useMemo(() => new THREE.CylinderGeometry(0.22, 0.34, 1.8, 6), []);
  const foliageGeo = useMemo(() => new THREE.IcosahedronGeometry(1, 0), []);

  useLayoutEffect(() => {
    const d = new THREE.Object3D();
    const trunk = trunkRef.current;
    if (trunk) {
      trunks.forEach((t, i) => {
        d.position.set(t.x, 0.9 * t.size, t.z);
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(t.size);
        d.updateMatrix();
        trunk.setMatrixAt(i, d.matrix);
      });
      trunk.instanceMatrix.needsUpdate = true;
    }
    const foliage = foliageRef.current;
    if (foliage) {
      trees.forEach((t, i) => {
        const s = t.shrub ? 1 : 1.6 * t.size;
        const tall = t.conifer && !t.shrub;
        d.position.set(t.x, t.shrub ? 0.7 : 1.3 * t.size + s * (tall ? 1.5 : 1), t.z);
        d.rotation.set(0, 0, 0);
        d.scale.set(tall ? s * 0.75 : s, tall ? s * 1.5 : s, tall ? s * 0.75 : s);
        d.updateMatrix();
        foliage.setMatrixAt(i, d.matrix);
        const palette = tall ? CONIFER_COLORS : FOLIAGE_COLORS;
        foliage.setColorAt(i, palette[Math.abs(Math.round(t.x * 13 + t.z * 7)) % palette.length]!);
      });
      foliage.instanceMatrix.needsUpdate = true;
      if (foliage.instanceColor) foliage.instanceColor.needsUpdate = true;
    }
  }, [trees, trunks]);

  if (trees.length === 0) return null;
  return (
    <>
      {trunks.length > 0 && (
        <instancedMesh
          ref={trunkRef}
          args={[trunkGeo, undefined, trunks.length]}
          castShadow
          frustumCulled={false}
          raycast={noRaycast}
        >
          <meshToonMaterial color="#5c3a20" gradientMap={toonGradient} />
        </instancedMesh>
      )}
      <instancedMesh
        ref={foliageRef}
        args={[foliageGeo, undefined, trees.length]}
        castShadow
        frustumCulled={false}
        raycast={noRaycast}
      >
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient} />
      </instancedMesh>
    </>
  );
});

/** Flowerbed blooms: one instanced mesh, per-instance colour. */
const Flowers = memo(function Flowers({ flowers }: { flowers: Flower[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(() => new THREE.IcosahedronGeometry(0.16, 0), []);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const d = new THREE.Object3D();
    flowers.forEach(([x, z, c], i) => {
      d.position.set(x, 0.22, z);
      d.scale.setScalar(0.8 + ((i * 37) % 5) * 0.1);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
      mesh.setColorAt(i, FLOWER_COLORS[c]!);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [flowers]);
  if (flowers.length === 0) return null;
  return (
    <instancedMesh
      key={flowers.length}
      ref={ref}
      args={[geo, undefined, flowers.length]}
      frustumCulled={false}
      raycast={noRaycast}
    >
      <meshToonMaterial color="#ffffff" gradientMap={toonGradient} />
    </instancedMesh>
  );
});

/** Animated flags: one useFrame drives all of them. */
const Flags = memo(function Flags({ flags }: { flags: PointItem[] }) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    group.current?.children.forEach((m) => {
      m.rotation.y = Math.sin(t * 1.6) * 0.22;
      m.rotation.z = Math.sin(t * 2.1) * 0.05;
    });
  });
  return (
    <group ref={group}>
      {flags.map((f) => (
        <mesh key={f.id} position={[f.x + 0.95, 9.2, f.z]} castShadow raycast={noRaycast}>
          <planeGeometry args={[1.9, 1.3, 10, 4]} />
          <meshToonMaterial color="#0a3d91" side={THREE.DoubleSide} gradientMap={toonGradient} />
        </mesh>
      ))}
    </group>
  );
});

const FeatureLabels = memo(function FeatureLabels({ features }: { features: PointItem[] }) {
  const items = useMemo(
    () =>
      features
        .flatMap((f) => {
          const spec = featureDef(f.key as FeatureKey).label;
          const text = f.name ?? spec?.fallback;
          return spec && text ? [{ id: f.id, x: f.x, z: f.z, spec, text }] : [];
        })
        .slice(0, MAX_FEATURE_LABELS),
    [features]
  );
  return (
    <>
      {items.map(({ id, x, z, spec, text }) => (
        <Billboard key={id} position={[x, spec.y, z]}>
          <Text
            fontSize={spec.size}
            color={spec.color}
            anchorX="center"
            anchorY="middle"
            outlineWidth={spec.outlineWidth}
            outlineColor={spec.outline}
            fontWeight={800}
          >
            {text}
          </Text>
        </Billboard>
      ))}
    </>
  );
});

/* ============================================================
 * 13. GRASS TUFTS (spatial-hash accelerated)
 * ============================================================ */

const GRASS_BUCKET_COLORS = ['#4fae3a', '#63c24b', '#3d9130'];
const GRASS_ROAD_MARGIN = 0.9;
const GRASS_BLDG_MARGIN = 0.7;
const GRASS_DENSITY = 0.6;
const GRASS_MIN = 2_000;
const GRASS_MAX = 60_000;
const GRID_CELL = 12;

function pointInPolygon(x: number, z: number, poly: XY[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distPointSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

const cellId = (i: number, j: number) => (i + 40000) * 100000 + (j + 40000);

function buildGrid<T>(items: readonly T[], bounds: (t: T) => Box) {
  const grid = new Map<number, T[]>();
  items.forEach((item) => {
    const b = bounds(item);
    const i1 = Math.floor(b.maxX / GRID_CELL);
    const j1 = Math.floor(b.maxZ / GRID_CELL);
    for (let i = Math.floor(b.minX / GRID_CELL); i <= i1; i++) {
      for (let j = Math.floor(b.minZ / GRID_CELL); j <= j1; j++) {
        const k = cellId(i, j);
        const bucket = grid.get(k);
        if (bucket) bucket.push(item);
        else grid.set(k, [item]);
      }
    }
  });
  return (x: number, z: number): readonly T[] =>
    grid.get(cellId(Math.floor(x / GRID_CELL), Math.floor(z / GRID_CELL))) ?? EMPTY;
}

function polygonIndex(polys: XY[][]) {
  const items = polys.filter((p) => p.length >= 3).map((pts) => ({ pts, box: boundsOf(pts) }));
  const at = buildGrid(items, (p) => p.box);
  return (x: number, z: number) =>
    at(x, z).some(
      (p) =>
        x >= p.box.minX &&
        x <= p.box.maxX &&
        z >= p.box.minZ &&
        z <= p.box.maxZ &&
        pointInPolygon(x, z, p.pts)
    );
}

function makeGrassTuftGeometry(): THREE.BufferGeometry {
  const positions = (
    [
      [0, 0.55, 0.07],
      [Math.PI / 3, 0.7, 0.08],
      [(Math.PI * 2) / 3, 0.45, 0.06],
      [Math.PI, 0.62, 0.07],
      [(Math.PI * 4) / 3, 0.5, 0.075],
      [(Math.PI * 5) / 3, 0.68, 0.065],
    ] as const
  ).flatMap(([angle, h, w]) => {
    const a = Math.cos(angle) * w;
    const b = Math.sin(angle) * w;
    return [-a, 0, -b, a, 0, b, 0, h, 0];
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  return g;
}

const GrassTufts = memo(function GrassTufts({ scene }: { scene: SceneData }) {
  const buckets = useMemo(() => {
    const {
      campus,
      wayXY,
      roads,
      footways,
      steps,
      buildings,
      parkings,
      parks,
      pointCircles,
      waterPolygons,
      flowerbedPolys,
    } = scene;
    if (campus.length < 3) return [[], [], []] as XY[][];

    const { minX, maxX, minZ, maxZ } = boundsOf(campus);
    const target = Math.round(
      THREE.MathUtils.clamp(polygonArea(campus) * GRASS_DENSITY, GRASS_MIN, GRASS_MAX)
    );

    const waySegs = (ways: OsmWay[]) =>
      ways.flatMap((w) => {
        const pts = wayXY.get(w.id);
        return pts ? segsOf(pts, false, roadWidth(w.tags) / 2 + GRASS_ROAD_MARGIN) : [];
      });
    const segs = [
      ...waySegs(roads),
      ...waySegs(footways),
      ...waySegs(steps),
      ...buildings.flatMap((b) => segsOf(b.ring, true, GRASS_BLDG_MARGIN)),
    ];
    const segAt = buildGrid(segs, segBox);
    const circAt = buildGrid(pointCircles, (c) => ({
      minX: c.x - c.r,
      maxX: c.x + c.r,
      minZ: c.z - c.r,
      maxZ: c.z + c.r,
    }));

    const parkingPolys = parkings.flatMap((w) => {
      const p = wayXY.get(w.id);
      return p ? [p] : [];
    });
    const lawnPolys = parks.flatMap((w) => {
      const p = wayXY.get(w.id);
      return p ? [p] : [];
    });
    const inBuilding = polygonIndex(buildings.map((b) => b.ring));
    const inParking = polygonIndex(parkingPolys);
    const inBlocked = polygonIndex([...waterPolygons, ...flowerbedPolys]);
    const inLawn = polygonIndex(lawnPolys);

    const rng = seededRand(9137);
    const lawn: XY[] = [];
    const open: XY[] = [];
    const maxAttempts = target * 15;
    for (
      let attempts = 0;
      lawn.length + open.length < target && attempts < maxAttempts;
      attempts++
    ) {
      const x = minX + rng() * (maxX - minX);
      const z = minZ + rng() * (maxZ - minZ);
      if (!pointInPolygon(x, z, campus)) continue;
      if (segAt(x, z).some((s) => distPointSeg(x, z, s.ax, s.az, s.bx, s.bz) < s.r)) continue;
      if (inBuilding(x, z) || inParking(x, z) || inBlocked(x, z)) continue;
      if (circAt(x, z).some((c) => Math.hypot(x - c.x, z - c.z) < c.r)) continue;
      const onLawn = inLawn(x, z);
      if (!onLawn && rng() > 0.55) continue;
      (onLawn ? lawn : open).push([x, z]);
    }

    return [...lawn, ...open].reduce<XY[][]>(
      (out, p, i) => {
        out[i % 3]!.push(p);
        return out;
      },
      [[], [], []]
    );
  }, [scene]);

  return (
    <>
      {buckets.map((positions, bi) => (
        <GrassBucket key={bi} positions={positions} color={GRASS_BUCKET_COLORS[bi]!} />
      ))}
    </>
  );
});

function GrassBucket({ positions, color }: { positions: XY[]; color: string }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => makeGrassTuftGeometry(), []);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const rng = seededRand(color.length * 3301 + 11);
    const dummy = new THREE.Object3D();
    positions.forEach(([x, z], i) => {
      const s = 0.7 + rng() * 0.7;
      dummy.position.set(x, 0.04, z);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.set(s, 0.6 + rng() * 0.7, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [positions, color]);

  if (positions.length === 0) return null;
  return (
    <instancedMesh
      key={positions.length}
      ref={ref}
      args={[geometry, undefined, positions.length]}
      receiveShadow
      frustumCulled={false}
      raycast={noRaycast}
    >
      <meshToonMaterial color={color} gradientMap={toonGradient} side={THREE.DoubleSide} />
    </instancedMesh>
  );
}

/* ============================================================
 * 14. CAMERA RIG
 * ============================================================ */

type FocusPoint = { x: number; y: number; z: number; height: number };

function CameraRig({
  focus,
  defaultTarget,
  cancelRef,
}: {
  focus: FocusPoint | null;
  defaultTarget: [number, number, number];
  cancelRef: React.MutableRefObject<(() => void) | null>;
}) {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const invalidate = useThree((s) => s.invalidate);

  const desired = useRef<{ t: THREE.Vector3; p: THREE.Vector3 } | null>(null);
  const wasFocused = useRef(false);
  const userActive = useRef(false);

  useEffect(() => {
    cancelRef.current = () => {
      desired.current = null;
      userActive.current = true;
    };
    return () => {
      cancelRef.current = null;
    };
  }, [cancelRef]);

  useEffect(() => {
    if (!controls) return;
    const onStart = () => {
      desired.current = null;
      userActive.current = true;
    };
    const onEnd = () => {
      userActive.current = false;
    };
    controls.addEventListener('start', onStart);
    controls.addEventListener('end', onEnd);
    return () => {
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('end', onEnd);
    };
  }, [controls]);

  useEffect(() => {
    if (!controls || !camera || userActive.current) return;

    const curTarget = controls.target;
    const dir = camera.position.clone().sub(curTarget);
    if (dir.lengthSq() < 1e-6) dir.set(0.6, 0.75, 0.9);
    dir.normalize();

    if (focus) {
      const dist = THREE.MathUtils.clamp(focus.height * 4 + 24, 30, 90);
      const newTarget = new THREE.Vector3(focus.x, focus.y, focus.z);
      desired.current = { t: newTarget, p: newTarget.clone().add(dir.multiplyScalar(dist)) };
      wasFocused.current = true;
      invalidate();
    } else if (wasFocused.current) {
      const newTarget = new THREE.Vector3(...defaultTarget);
      const dist = Math.max(120, curTarget.distanceTo(camera.position));
      desired.current = { t: newTarget, p: newTarget.clone().add(dir.multiplyScalar(dist)) };
      wasFocused.current = false;
      invalidate();
    }
  }, [focus, defaultTarget, controls, camera, invalidate]);

  useFrame((_, delta) => {
    const d = desired.current;
    if (!controls || !d || userActive.current) return;

    const k = 1 - Math.exp(-delta * 11);
    controls.target.lerp(d.t, k);
    camera.position.lerp(d.p, k);

    if (
      controls.target.distanceToSquared(d.t) < 0.01 &&
      camera.position.distanceToSquared(d.p) < 0.05
    ) {
      controls.target.copy(d.t);
      camera.position.copy(d.p);
      desired.current = null;
    }
    invalidate(); // keep animating under frameloop="demand"
  });

  return null;
}

/* ============================================================
 * 15. SKELETON LOADER
 * ============================================================ */

const SKELETON_CSS = `
  .osm3d-skel-wrap { position: absolute; inset: 0; overflow: hidden; background: linear-gradient(180deg, #e8eef2 0%, #dbe4dd 100%); }
  .osm3d-skel-ground { position: absolute; inset: 0; background: radial-gradient(circle at 50% 58%, #cfe0c0 0%, #b8ccb0 58%, #a4b8a0 100%); }
  .osm3d-skel-block { position: absolute; background: rgba(120, 140, 110, 0.32); border-radius: 4px; animation: osm3d-skel-pulse 2.2s ease-in-out infinite; }
  .osm3d-skel-road { position: absolute; background: rgba(90, 100, 90, 0.22); animation: osm3d-skel-pulse 2.2s ease-in-out infinite; }
  .osm3d-skel-shimmer { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(100deg, rgba(255,255,255,0) 25%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0) 75%); background-size: 250% 100%; animation: osm3d-skel-shimmer 2s ease-in-out infinite; }
  .osm3d-skel-caption { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 10px; pointer-events: none; }
  .osm3d-skel-icon { width: 56px; height: 56px; border-radius: 16px; background: rgba(255,255,255,0.9); border: 1.5px solid rgba(26,26,46,0.18); box-shadow: 0 6px 24px rgba(26,26,46,0.15); display: flex; align-items: center; justify-content: center; color: #4f46e5; font-size: 24px; font-weight: 900; animation: osm3d-skel-pulse 1.6s ease-in-out infinite; }
  .osm3d-skel-title { font-size: 14px; font-weight: 800; color: #1a1a2e; background: rgba(255,255,255,0.8); padding: 4px 12px; border-radius: 8px; box-shadow: 0 2px 8px rgba(26,26,46,0.08); }
  .osm3d-skel-subtitle { font-size: 11px; font-weight: 600; color: #4a5568; background: rgba(255,255,255,0.65); padding: 2px 10px; border-radius: 6px; }
  @keyframes osm3d-skel-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
  @keyframes osm3d-skel-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
`;

const SKEL_ROADS: React.CSSProperties[] = [
  { left: 0, top: '52%', width: '100%', height: 10 },
  { left: '28%', top: 0, width: 8, height: '100%' },
  { left: '74%', top: 0, width: 6, height: '100%' },
];
const SKEL_BLOCKS: React.CSSProperties[] = [
  { left: '12%', top: '36%', width: '14%', height: '18%' },
  { left: '33%', top: '28%', width: '18%', height: '24%' },
  { left: '60%', top: '40%', width: '12%', height: '16%' },
  { left: '46%', top: '58%', width: '16%', height: '20%' },
  { left: '18%', top: '62%', width: '12%', height: '16%' },
  { left: '72%', top: '62%', width: '14%', height: '18%' },
];

const MapSkeleton = memo(function MapSkeleton({
  label,
  phase,
}: {
  label: string;
  phase: 'loading' | 'parsing';
}) {
  const title = phase === 'parsing' ? `Building ${label}…` : `Loading ${label}…`;
  const subtitle =
    phase === 'parsing' ? 'Building 3D scene from OSM data' : 'Parsing OpenStreetMap data';
  return (
    <div className="osm3d-skel-wrap">
      <style>{SKELETON_CSS}</style>
      <div className="osm3d-skel-ground" />
      {SKEL_ROADS.map((s, i) => (
        <div key={`r${i}`} className="osm3d-skel-road" style={s} />
      ))}
      {SKEL_BLOCKS.map((s, i) => (
        <div key={`b${i}`} className="osm3d-skel-block" style={s} />
      ))}
      <div className="osm3d-skel-shimmer" />
      <div className="osm3d-skel-caption">
        <div className="osm3d-skel-icon">◈</div>
        <div className="osm3d-skel-title">{title}</div>
        <div className="osm3d-skel-subtitle">{subtitle}</div>
      </div>
    </div>
  );
});

/* ============================================================
 * 16. MAIN COMPONENT
 * ============================================================ */

export default function OsmMap3D({
  src,
  xml,
  label = 'Osm',
  isLoading = true,
  className,
  zoom = 1,
  labels = true,
  ambiance = 'day',
  center = null,
  onLoad,
  onError,
  onBuildingClick,
}: OsmMap3DProps) {
  const [parse, setParse] = useState<ParseState>({ status: 'idle' });
  const [showLabels, setShowLabels] = useState(labels);
  const [showGrass, setShowGrass] = useState(true);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const cancelFocusRef = useRef<(() => void) | null>(null);

  const isNight = ambiance === 'night';

  // Parent callbacks live in refs so inline lambdas never trigger a re-parse.
  const onLoadRef = useRef(onLoad);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onLoadRef.current = onLoad;
    onErrorRef.current = onError;
  });

  const [parentSize, setParentSize] = useState<{ w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const parent = wrapperRef.current?.parentElement;
    if (!parent) return;

    const measure = () => {
      const r = parent.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const w = Math.round(r.width);
        const h = Math.round(r.height);
        setParentSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
      } else {
        setParentSize(null);
      }
    };

    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(parent);
    window.addEventListener('resize', measure);
    return () => {
      obs.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  /** Load priority: `xml` string → fetch `src` → error. Parse is deferred one macrotask so the skeleton paints. */
  useEffect(() => {
    let cancelled = false;
    const fail = (e: unknown) => {
      if (cancelled) return;
      const err = e instanceof Error ? e : new Error(String(e));
      setParse({ status: 'error', error: err });
      onErrorRef.current?.(err);
    };
    const succeed = (text: string) => {
      const parsed = parseOsm(text);
      if (cancelled) return;
      setParse({ status: 'ready', doc: parsed });
      onLoadRef.current?.(parsed);
    };

    const xmlText = typeof xml === 'string' && /\S/.test(xml) ? xml : null;

    if (xmlText !== null) {
      setParse({ status: 'parsing' });
      const handle = setTimeout(() => {
        if (cancelled) return;
        try {
          succeed(xmlText);
        } catch (e) {
          fail(e);
        }
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(handle);
      };
    }

    if (!src) {
      fail(new Error('OsmMap3D: no "xml" or "src" provided.'));
      return () => {
        cancelled = true;
      };
    }

    setParse({ status: 'parsing' });
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(src, { signal: controller.signal });
        if (!res.ok) {
          const hint =
            res.status === 400
              ? ' — bbox may be too large (max ~0.25 sq. degrees) or invalid.'
              : res.status === 509
                ? ' — OSM API is throttling this client. Try again later.'
                : '';
          throw new Error(`OSM API error (${res.status} ${res.statusText})${hint}`);
        }
        const text = await res.text();
        if (cancelled) return;
        await new Promise<void>((r) => setTimeout(r, 0));
        if (cancelled) return;
        succeed(text);
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') return;
        fail(e);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [src, xml]);

  const doc = parse.status === 'ready' ? parse.doc : null;
  const scene = useMemo(() => (doc ? buildSceneData(doc) : null), [doc]);

  const layout = useMemo(() => {
    if (!scene) {
      return {
        target: [0, 0, 0] as [number, number, number],
        pos: [130, 150, 190] as [number, number, number],
        far: 4000,
        fogNear: 500,
        fogFar: 1400,
        shadowRadius: 450,
        skyRadius: 1500,
        maxDist: 600,
        centerX: 0,
        centerZ: 0,
      };
    }
    const { extent } = scene;
    const cx = (extent.minX + extent.maxX) / 2;
    const cz = (extent.minZ + extent.maxZ) / 2;
    const span = Math.max(extent.maxX - extent.minX, extent.maxZ - extent.minZ, 60);
    return {
      target: [cx, 0, cz] as [number, number, number],
      pos: [cx + span * 0.52 * zoom, span * 0.6 * zoom, cz + span * 0.76 * zoom] as [
        number,
        number,
        number,
      ],
      far: Math.max(4000, span * 8),
      fogNear: Math.max(500, span * 2),
      fogFar: Math.max(1400, span * 5.6),
      shadowRadius: Math.max(450, span * 0.9),
      skyRadius: Math.max(1500, span * 4),
      maxDist: Math.max(600, span * 2.4),
      centerX: cx,
      centerZ: cz,
    };
  }, [scene, zoom]);

  const selectedFocus = useMemo<FocusPoint | null>(() => {
    const b = selectedId === null ? undefined : scene?.buildingById.get(selectedId);
    return b ? { x: b.cx, z: b.cz, y: b.height * 0.45, height: b.height } : null;
  }, [selectedId, scene]);

  /**
   * Focus derived from the `center` prop. Stable across parent re-renders that
   * pass inline `{ lat, lon }` objects — we only depend on the scalar values.
   */
  const centerLat = center?.lat ?? null;
  const centerLon = center?.lon ?? null;
  const centerFocus = useMemo<FocusPoint | null>(() => {
    if (centerLat === null || centerLon === null || !scene) return null;
    const b = findBuildingAt(scene, centerLat, centerLon);
    return b ? { x: b.cx, z: b.cz, y: b.height * 0.45, height: b.height } : null;
  }, [centerLat, centerLon, scene]);

  /** User selection takes precedence over the `center` prop. */
  const activeFocus = selectedFocus ?? centerFocus;

  const flags = useMemo(() => scene?.features.filter((f) => f.key === 'flagpole') ?? [], [scene]);

  /* ---- click → emit ---------------------------------------------- */

  const emitBuildingClick = useCallback(
    (info: BuildingClickInfo | null) => {
      onBuildingClick?.(info);
      wrapperRef.current?.dispatchEvent(
        new CustomEvent<BuildingClickInfo | null>(OSM3D_BUILDING_CLICK_EVENT, {
          detail: info,
          bubbles: true,
          composed: true,
        })
      );
    },
    [onBuildingClick]
  );

  const handleBuildingSelect = useCallback(
    (id: number, info: BuildingClickInfo) => {
      setSelectedId(id);
      emitBuildingClick(info);
    },
    [emitBuildingClick]
  );

  const handlePointerMissed = useCallback(() => {
    setSelectedId(null);
    emitBuildingClick(null);
  }, [emitBuildingClick]);

  const lightTarget = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    lightTarget.position.set(layout.centerX, 0, layout.centerZ);
    lightTarget.updateMatrixWorld();
  }, [lightTarget, layout.centerX, layout.centerZ]);

  const wrapperSizeStyle: React.CSSProperties = parentSize
    ? { width: `${parentSize.w}px`, height: `${parentSize.h}px` }
    : { width: '100%', height: '100%' };

  /* ---- Render: loading skeleton ---------------------------------- */

  const showSkeleton = isLoading || parse.status === 'idle' || parse.status === 'parsing';

  if (showSkeleton) {
    return (
      <div ref={wrapperRef} className={className} style={{ ...wrapperStyle, ...wrapperSizeStyle }}>
        <MapSkeleton label={label} phase={isLoading ? 'loading' : 'parsing'} />
      </div>
    );
  }

  /* ---- Render: error --------------------------------------------- */

  if (parse.status === 'error' || !doc || !scene) {
    const err = parse.status === 'error' ? parse.error : null;
    return (
      <div ref={wrapperRef} className={className} style={{ ...wrapperStyle, ...wrapperSizeStyle }}>
        <div style={{ ...centerPanelStyle, color: '#b02a2a' }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>Failed to load {label}</div>
          <div style={{ fontSize: 12 }}>{err?.message ?? 'Unknown error'}</div>
        </div>
      </div>
    );
  }

  /* ---- Render: canvas -------------------------------------------- */

  // Ambiance-driven palette (kept inline so the memoized scene never rebuilds).
  const fogColor = isNight ? '#0a1024' : '#cfe8ff';
  const hemiSky = isNight ? '#2a3565' : '#bfe3ff';
  const hemiGround = isNight ? '#0f1622' : '#8a9a6a';
  const hemiIntensity = isNight ? 0.18 : 0.55;
  const ambientIntensity = isNight ? 0.14 : 0.35;
  const sunColor = isNight ? '#8a9ac8' : '#ffffff';
  const sunIntensity = isNight ? 0.35 : 1.25;

  return (
    <div ref={wrapperRef} className={className} style={{ ...wrapperStyle, ...wrapperSizeStyle }}>
      {parentSize && (
        <Canvas
          shadows="percentage"
          frameloop={flags.length > 0 ? 'always' : 'demand'}
          dpr={[1, 1.75]}
          camera={{ position: layout.pos, fov: 45, near: 1, far: layout.far }}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          onPointerMissed={handlePointerMissed}
        >
          <AmbianceContext.Provider value={ambiance}>
            <AdaptiveDpr pixelated />
            <fog attach="fog" args={[fogColor, layout.fogNear, layout.fogFar]} />

            <SkyDome radius={layout.skyRadius} ambiance={ambiance} />
            <Clouds radius={layout.skyRadius} ambiance={ambiance} />

            <hemisphereLight args={[hemiSky, hemiGround, hemiIntensity]} />
            <ambientLight intensity={ambientIntensity} />
            <primitive object={lightTarget} />
            <directionalLight
              castShadow
              target={lightTarget}
              position={[layout.centerX + 140, 190, layout.centerZ + 90]}
              color={sunColor}
              intensity={sunIntensity}
              shadow-mapSize-width={2048}
              shadow-mapSize-height={2048}
              shadow-camera-left={-layout.shadowRadius}
              shadow-camera-right={layout.shadowRadius}
              shadow-camera-top={layout.shadowRadius}
              shadow-camera-bottom={-layout.shadowRadius}
              shadow-camera-near={20}
              shadow-camera-far={Math.max(800, layout.shadowRadius * 2)}
              shadow-bias={-0.0004}
            />

            <Ground scene={scene} ambiance={ambiance} />
            <StaticLayers scene={scene} />
            {showGrass && <GrassTufts scene={scene} />}

            <Buildings scene={scene} onHover={setHoveredId} onSelect={handleBuildingSelect} />
            <Rooftops buildings={scene.buildings} />
            <BuildingOverlays
              scene={scene}
              showLabels={showLabels}
              hoveredId={hoveredId}
              selectedId={selectedId}
            />

            <Trees trees={scene.trees} />
            <Flowers flowers={scene.flowers} />
            <FeatureLayer features={scene.features} />
            {flags.length > 0 && <Flags flags={flags} />}
            <FeatureLabels features={scene.features} />

            <OrbitControls
              makeDefault
              regress
              enableDamping
              dampingFactor={0.08}
              target={layout.target}
              minDistance={20}
              maxDistance={layout.maxDist}
              minPolarAngle={0.15}
              maxPolarAngle={Math.PI / 2.15}
              screenSpacePanning={false}
              panSpeed={0.8}
              rotateSpeed={0.7}
              zoomSpeed={0.9}
            />

            <CameraRig
              focus={activeFocus}
              defaultTarget={layout.target}
              cancelRef={cancelFocusRef}
            />
          </AmbianceContext.Provider>
        </Canvas>
      )}

      {!parentSize && (
        <div style={sizeWarningStyle}>
          <strong>Canvas has no size</strong>
          <div style={{ marginTop: 4 }}>
            Give the parent an explicit height — e.g.
            <code style={{ display: 'block', marginTop: 4 }}>
              {"<div style={{ width: '100%', height: '100vh' }}>"}
            </code>
          </div>
        </div>
      )}

      {parentSize && (
        <>
          <div style={hudTopLeft}>
            <div style={{ fontWeight: 900, fontSize: 16, color: '#1a1a2e' }}>{label} — 3D Map</div>
            <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>
              Drag to orbit · Right-drag to pan · Scroll to zoom · Click a building to focus
            </div>
            <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>
              {doc.nodes.length} nodes · {doc.ways.length} ways · {doc.relations.length} relations
              {' · '}
              {isNight ? 'Night' : 'Day'}
            </div>
          </div>

          <div style={hudTopRight}>
            <button onClick={() => setShowLabels((v) => !v)} style={btnStyle(showLabels)}>
              {showLabels ? 'Hide labels' : 'Show labels'}
            </button>
            <button onClick={() => setShowGrass((v) => !v)} style={btnStyle(showGrass)}>
              {showGrass ? 'Hide grass' : 'Show grass'}
            </button>
          </div>

          {scene.routeRelations.length > 0 && (
            <div style={hudBottomRight}>
              <div style={{ fontWeight: 800, marginBottom: 4, color: '#1a1a2e' }}>
                Routes ({scene.routeRelations.length})
              </div>
              {scene.routeRelations.slice(0, 3).map((r, i) => (
                <div key={i} style={{ fontSize: 11, color: '#555' }}>
                  {r.ref ? `Ref ${r.ref}` : (r.name ?? 'unnamed')}
                  {r.network ? ` · ${r.network}` : ''}
                </div>
              ))}
              {scene.routeRelations.length > 3 && (
                <div style={{ fontSize: 11, color: '#888' }}>
                  …and {scene.routeRelations.length - 3} more
                </div>
              )}
            </div>
          )}

          {doc.warnings.length > 0 && (
            <div style={hudBottomLeft}>
              <div style={{ fontWeight: 800, color: '#b02a2a', marginBottom: 4 }}>
                {doc.warnings.length} warning{doc.warnings.length === 1 ? '' : 's'}
              </div>
              {doc.warnings.slice(0, 4).map((w, i) => (
                <div key={i} style={{ fontSize: 11, color: '#555' }}>
                  Line {w.line}: {w.message}
                </div>
              ))}
              {doc.warnings.length > 4 && (
                <div style={{ fontSize: 11, color: '#888' }}>
                  …and {doc.warnings.length - 4} more
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ============================================================
 * 17. STYLES
 * ============================================================ */

const wrapperStyle: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  overflow: 'hidden',
};

const centerPanelStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  background: 'rgba(255,255,255,0.95)',
  border: '2px solid rgba(26,26,46,0.9)',
  borderRadius: 14,
  padding: '16px 22px',
  boxShadow: '0 4px 0 rgba(26,26,46,0.3)',
  fontSize: 14,
  fontWeight: 700,
  color: '#1a1a2e',
};

const hudBase: React.CSSProperties = {
  position: 'absolute',
  background: 'rgba(255,255,255,0.95)',
  border: '2px solid rgba(26,26,46,0.9)',
  borderRadius: 14,
  boxShadow: '0 4px 0 rgba(26,26,46,0.3)',
};

const hudTopLeft: React.CSSProperties = {
  ...hudBase,
  top: 16,
  left: 16,
  padding: '10px 16px',
  pointerEvents: 'none',
  maxWidth: 380,
};

const hudTopRight: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const hudBottomLeft: React.CSSProperties = {
  ...hudBase,
  bottom: 16,
  left: 16,
  padding: '10px 14px',
  maxWidth: 360,
};

const hudBottomRight: React.CSSProperties = {
  ...hudBase,
  bottom: 16,
  right: 16,
  padding: '10px 14px',
  maxWidth: 280,
  pointerEvents: 'none',
};

const sizeWarningStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  background: 'rgba(255,245,180,0.98)',
  border: '2px solid rgba(180,90,20,0.9)',
  borderRadius: 14,
  padding: '14px 20px',
  boxShadow: '0 4px 0 rgba(180,90,20,0.35)',
  maxWidth: 360,
  fontSize: 12,
  color: '#5a3a1a',
  textAlign: 'center',
  pointerEvents: 'none',
};

function btnStyle(active: boolean, bg?: string): React.CSSProperties {
  return {
    background: bg ?? (active ? '#1a1a2e' : '#ffffff'),
    color: bg ? '#1a1a2e' : active ? '#ffffff' : '#1a1a2e',
    border: '2px solid rgba(26,26,46,0.9)',
    borderRadius: 10,
    padding: '8px 14px',
    fontWeight: 800,
    fontSize: 12,
    cursor: 'pointer',
    boxShadow: '0 3px 0 rgba(26,26,46,0.3)',
  };
}
