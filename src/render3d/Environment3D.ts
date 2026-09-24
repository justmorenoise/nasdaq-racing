import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CONFIG } from "../config";
import type { Track, TrackTheme } from "../track/Track";
import { Solids } from "./Solids";

type Blocker = { x: number; y: number; r: number };

/** Deterministic PRNG so a circuit's surroundings are the same on every visit. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const PINE_GREENS = [0x2f6b3a, 0x3a7a41, 0x4a8a45, 0x356f3c];
const LEAF_GREENS = [0x5d9c45, 0x6aa84f, 0x4d8a3c, 0x78b24f];
const AUTUMN = [0xd08a2e, 0xc9772b, 0xe0a63f];
const FACADES = [0xeadbc3, 0xf2e6d0, 0xdcbd9d, 0xe8cfa2, 0xc9d1d8, 0xf1efe9, 0xe3b9a0, 0xd6c7a8];
const ROOFS = [0x8a8f96, 0xb5593d, 0x9aa1a8, 0xa4664a];

interface ThemeSpec {
  /** Candidate spacing for the tree scatter (world units). */
  treeStep: number;
  /** Keep a tree where the grove noise exceeds this (−1 = everywhere). */
  treeThreshold: number;
  pineShare: number;
  buildings: boolean;
  water: boolean;
}

const THEMES: Record<TrackTheme, ThemeSpec> = {
  parco: { treeStep: 52, treeThreshold: 0.25, pineShare: 0.35, buildings: false, water: false },
  bosco: { treeStep: 40, treeThreshold: -0.55, pineShare: 0.75, buildings: false, water: false },
  citta: { treeStep: 70, treeThreshold: 0.75, pineShare: 0.1, buildings: true, water: false },
  porto: { treeStep: 60, treeThreshold: 0.55, pineShare: 0.5, buildings: true, water: true },
};

/**
 * The world around the circuit, themed per track (circuits.json `tema`):
 * instanced low-poly pines and round trees scattered in groves, city blocks of
 * pastel buildings, and for harbour circuits a sea with a quay and moored boats.
 * Everything keeps clear of the track, its run-off and the trackside scenery.
 */
export class Environment3D {
  readonly group = new Group();
  private rand: () => number;
  private grid = new Map<string, { x: number; y: number }[]>();
  private cell = 120;
  private spec: ThemeSpec;
  private water: ((x: number, y: number) => boolean) | null = null;

  private blockers: Blocker[];

  constructor(
    private track: Track,
    blockers: Blocker[],
  ) {
    this.blockers = [...blockers];
    this.rand = mulberry32(hashString(track.def.id));
    this.spec = THEMES[track.def.theme ?? "parco"];
    for (const s of track.samples) {
      const k = this.key(s.x, s.y);
      let b = this.grid.get(k);
      if (!b) this.grid.set(k, (b = []));
      b.push({ x: s.x, y: s.y });
    }
    if (this.spec.water) this.sea();
    if (this.spec.buildings) this.city();
    this.trees();
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }

  /** Distance from (x, y) to the centerline, capped at `cap`. */
  private trackDist(x: number, y: number, cap: number): number {
    const r = Math.ceil(cap / this.cell);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    let best = cap;
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const b = this.grid.get(`${cx + i},${cy + j}`);
        if (!b) continue;
        for (const p of b) best = Math.min(best, Math.hypot(p.x - x, p.y - y));
      }
    }
    return best;
  }

  private free(x: number, y: number, clearance: number, radius: number): boolean {
    if (this.water?.(x, y)) return false;
    if (this.trackDist(x, y, clearance + radius) < clearance + radius) return false;
    for (const b of this.blockers) if (Math.hypot(b.x - x, b.y - y) < b.r + radius) return false;
    return true;
  }

  /** Groves: smooth pseudo-noise in [-1, 1]-ish. */
  private grove(x: number, y: number, seed: number): number {
    return (
      Math.sin(x / 430 + seed) * Math.sin(y / 370 + seed * 1.7) * 0.7 +
      Math.sin((x + y) / 260 + seed * 2.3) * 0.3 +
      Math.sin((x - y) / 180 + seed * 0.7) * 0.2
    );
  }

  private area(margin: number) {
    const b = this.track.bounds;
    return { x0: b.minX - margin, x1: b.maxX + margin, y0: b.minY - margin, y1: b.maxY + margin };
  }

  private trees(): void {
    const sp = this.spec;
    const a = this.area(1100);
    const seed = this.rand() * 100;
    const clearance = this.track.def.width / 2 + CONFIG.scenery.runOffWidth + 55;
    const pines: Matrix4[] = [];
    const rounds: Matrix4[] = [];
    const pineCols: number[] = [];
    const roundCols: number[] = [];
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    for (let x = a.x0; x < a.x1; x += sp.treeStep) {
      for (let y = a.y0; y < a.y1; y += sp.treeStep) {
        const px = x + (this.rand() - 0.5) * sp.treeStep * 0.9;
        const py = y + (this.rand() - 0.5) * sp.treeStep * 0.9;
        if (this.grove(px, py, seed) < sp.treeThreshold + (this.rand() - 0.5) * 0.25) continue;
        const s = 0.7 + this.rand() * 0.6;
        if (!this.free(px, py, clearance, 14 * s)) continue;
        q.setFromAxisAngle(up, this.rand() * Math.PI * 2);
        const m = new Matrix4().compose(new Vector3(px, 0, py), q, new Vector3(s, s * (0.85 + this.rand() * 0.3), s));
        const autumn = this.rand() < 0.08;
        if (this.rand() < sp.pineShare) {
          pines.push(m);
          pineCols.push(autumn ? AUTUMN[(this.rand() * AUTUMN.length) | 0] : PINE_GREENS[(this.rand() * PINE_GREENS.length) | 0]);
        } else {
          rounds.push(m);
          roundCols.push(autumn ? AUTUMN[(this.rand() * AUTUMN.length) | 0] : LEAF_GREENS[(this.rand() * LEAF_GREENS.length) | 0]);
        }
      }
    }

    const trunk = new CylinderGeometry(1.6, 2.2, 12, 5).translate(0, 6, 0);
    const pineCanopy = mergeGeometries([
      new ConeGeometry(13, 26, 7).translate(0, 21, 0),
      new ConeGeometry(9.5, 20, 7).translate(0, 34, 0),
    ]);
    const roundCanopy = new IcosahedronGeometry(13, 0).scale(1, 1.1, 1).translate(0, 22, 0);
    this.instances(trunk, [...pines, ...rounds], [...pines, ...rounds].map(() => 0x6b4a2b));
    this.instances(pineCanopy, pines, pineCols);
    this.instances(roundCanopy, rounds, roundCols);
  }

  private instances(geo: BufferGeometry, mats: Matrix4[], colors: number[]): void {
    if (!mats.length) return;
    const mesh = new InstancedMesh(geo, new MeshLambertMaterial({ flatShading: true }), mats.length);
    const c = new Color();
    mats.forEach((m, k) => {
      mesh.setMatrixAt(k, m);
      mesh.setColorAt(k, c.setHex(colors[k]));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  /**
   * City blocks on a street grid: each block is an asphalt street cell with a
   * paved sidewalk island carrying 1–4 pastel buildings (taller away from the
   * circuit, a few rooftop plant rooms). Blocks too close to the track are left
   * as grass verge.
   */
  private city(): void {
    const g = new Solids();
    const a = this.area(900);
    const block = 110;
    const clearance = this.track.def.width / 2 + CONFIG.scenery.runOffWidth + 50;
    for (let x = a.x0; x < a.x1; x += block) {
      for (let y = a.y0; y < a.y1; y += block) {
        const cx = x + block / 2;
        const cy = y + block / 2;
        if (!this.free(cx, cy, clearance, block * 0.72)) continue;
        this.blockers.push({ x: cx, y: cy, r: block * 0.72 });
        g.box(cx, cy, 1, 0, block / 2, block / 2, 0, 0.3, 0x6b6f76); // street
        const inner = block / 2 - 9;
        g.box(cx, cy, 1, 0, inner, inner, 0, 0.9, 0xb9b3a8, 0xd9d3c7); // sidewalk
        if (this.rand() < 0.1) {
          // A small square with a couple of trees instead of buildings.
          g.box(cx, cy, 1, 0, inner - 6, inner - 6, 0.9, 1.1, 0x6aa84f);
          continue;
        }
        const far = Math.min(1, this.trackDist(cx, cy, 800) / 800);
        // Split the block into 1, 2 or 4 lots.
        const split = this.rand() < 0.4 ? 1 : this.rand() < 0.5 ? 2 : 4;
        const lots: [number, number, number, number][] =
          split === 1
            ? [[cx, cy, inner - 3, inner - 3]]
            : split === 2
              ? [
                  [cx - inner / 2, cy, inner / 2 - 2, inner - 3],
                  [cx + inner / 2, cy, inner / 2 - 2, inner - 3],
                ]
              : [
                  [cx - inner / 2, cy - inner / 2, inner / 2 - 2, inner / 2 - 2],
                  [cx + inner / 2, cy - inner / 2, inner / 2 - 2, inner / 2 - 2],
                  [cx - inner / 2, cy + inner / 2, inner / 2 - 2, inner / 2 - 2],
                  [cx + inner / 2, cy + inner / 2, inner / 2 - 2, inner / 2 - 2],
                ];
        for (const [lx, ly, hw, hd] of lots) {
          const h = 20 + this.rand() * 30 + far * this.rand() * 80;
          g.box(lx, ly, 1, 0, hw, hd, 0.9, h, FACADES[(this.rand() * FACADES.length) | 0], ROOFS[(this.rand() * ROOFS.length) | 0]);
          if (this.rand() < 0.35) {
            g.box(lx + (this.rand() - 0.5) * hw * 0.8, ly + (this.rand() - 0.5) * hd * 0.8, 1, 0, 4, 4, h, h + 6, 0xb9bec4);
          }
        }
      }
    }
    if (!g.empty) this.group.add(g.build());
  }

  /**
   * Sea on the side of the circuit that hugs its bounding box the longest (the
   * waterfront), with a quay along the shore and boats moored off it.
   */
  private sea(): void {
    const b = this.track.bounds;
    const s = this.track.samples;
    const spanX = b.maxX - b.minX;
    const spanY = b.maxY - b.minY;
    const near = (v: number, edge: number, span: number) => Math.abs(v - edge) < span * 0.1;
    const counts = {
      minX: s.filter((p) => near(p.x, b.minX, spanX)).length,
      maxX: s.filter((p) => near(p.x, b.maxX, spanX)).length,
      minY: s.filter((p) => near(p.y, b.minY, spanY)).length,
      maxY: s.filter((p) => near(p.y, b.maxY, spanY)).length,
    };
    const side = (Object.keys(counts) as (keyof typeof counts)[]).reduce((a, k) => (counts[k] > counts[a] ? k : a));
    const gap = 130;
    const shore =
      side === "minX" ? b.minX - gap : side === "maxX" ? b.maxX + gap : side === "minY" ? b.minY - gap : b.maxY + gap;
    const horizontal = side === "minY" || side === "maxY";
    const dir = side === "minX" || side === "minY" ? -1 : 1;
    this.water = (x, y) => ((horizontal ? y : x) - shore) * dir > -20;

    const big = Math.max(spanX, spanY) * 8;
    const geo = new PlaneGeometry(big, big).rotateX(-Math.PI / 2);
    const sea = new Mesh(geo, new MeshLambertMaterial({ color: 0x2f79a8 }));
    const cxm = (b.minX + b.maxX) / 2;
    const cym = (b.minY + b.maxY) / 2;
    if (horizontal) sea.position.set(cxm, 0.25, shore + (dir * big) / 2);
    else sea.position.set(shore + (dir * big) / 2, 0.25, cym);
    sea.receiveShadow = true;
    this.group.add(sea);

    // Quay along the shoreline, then moored boats in a couple of rows.
    const g = new Solids();
    const along0 = horizontal ? b.minX - 600 : b.minY - 600;
    const along1 = horizontal ? b.maxX + 600 : b.maxY + 600;
    const pt = (u: number, v: number) => (horizontal ? { x: u, y: shore + dir * v } : { x: shore + dir * v, y: u });
    const q0 = pt(along0, -30);
    const q1 = pt(along1, -30);
    const q2 = pt(along1, 0);
    const q3 = pt(along0, 0);
    g.prism([q0, q1, q2, q3], 0, 3, 0x9aa0a8, 0xc7ccd2);
    for (let u = along0 + 40; u < along1 - 40; u += 34) {
      for (const [row, v] of [[0, 45], [1, 110]] as const) {
        if (this.rand() < 0.3 + row * 0.25) continue;
        const len = 22 + this.rand() * 26;
        const c = pt(u + (this.rand() - 0.5) * 8, v + (this.rand() - 0.5) * 10);
        const [ax, ay] = horizontal ? [0, 1] : [1, 0];
        g.box(c.x, c.y, ax, ay, len / 2, 5.5, 0, 4.5, 0xf4f4f2, 0xe9e6df); // hull
        g.box(c.x - ax * len * 0.1, c.y - ay * len * 0.1, ax, ay, len * 0.22, 3.6, 4.5, 8.5, 0xffffff, 0xcfd8df); // cabin
      }
    }
    // Lighthouse at the end of the quay.
    const lh = pt(along1 - 200, 60);
    g.box(lh.x, lh.y, 1, 0, 5, 5, 0, 36, 0xd8342c, 0xf4f4f2);
    g.box(lh.x, lh.y, 1, 0, 3.5, 3.5, 36, 42, 0xf4f4f2, 0x2f3542);
    this.group.add(g.build());
  }
}
