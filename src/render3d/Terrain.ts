import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
} from "three";
import { CONFIG } from "../config";
import type { Track, TrackTheme } from "../track/Track";

/** Deterministic PRNG so a circuit's landscape is the same on every visit. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Smooth value noise with a seeded lattice. */
class ValueNoise {
  private perm: Float32Array;
  constructor(rand: () => number) {
    this.perm = new Float32Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = rand();
  }
  private lat(i: number, j: number): number {
    return this.perm[(((i * 73856093) ^ (j * 19349663)) >>> 0) % 512];
  }
  at(x: number, y: number): number {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = this.lat(i, j);
    const b = this.lat(i + 1, j);
    const c = this.lat(i, j + 1);
    const d = this.lat(i + 1, j + 1);
    return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1;
  }
  fbm(x: number, y: number, oct = 4): number {
    let s = 0;
    let amp = 0.5;
    let f = 1;
    for (let o = 0; o < oct; o++) {
      s += this.at(x * f, y * f) * amp;
      f *= 2.03;
      amp *= 0.5;
    }
    return s;
  }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface ThemeRelief {
  /** Hill amplitude (world units) away from the circuit. */
  hills: number;
  /** Extra mountain relief far from the circuit (harbour backdrop). */
  mountains: number;
}

const RELIEF: Record<TrackTheme, ThemeRelief> = {
  parco: { hills: 70, mountains: 0 },
  bosco: { hills: 150, mountains: 120 },
  citta: { hills: 35, mountains: 0 },
  porto: { hills: 50, mountains: 520 },
};

/** Muted, reference-matched palette (olive grass, warm dirt, grey rock). */
const PAL = {
  grassA: new Color(0x93ab62),
  grassB: new Color(0x7f9a52),
  grassC: new Color(0xa3b872),
  forest: new Color(0x5f7b43),
  dirt: new Color(0xb49d74),
  rock: new Color(0x9a938a),
  snow: new Color(0xf1f1ed),
  sand: new Color(0xdac9a0),
};

export interface Water {
  level: number;
  contains(x: number, y: number): boolean;
}

/**
 * The landscape the circuit sits in: a low-poly, flat-shaded heightfield.
 * Near the track the ground follows the track's real elevation (a harmonic
 * fill solved outward from the track corridor, kept just under the asphalt and
 * under the lower pass at crossovers); further out themed hills, forested
 * ridges or a harbour's mountain backdrop take over. `heightAt` lets every
 * other layer stand its objects on the ground.
 */
export class Terrain {
  readonly mesh: Mesh;
  readonly skirt: Mesh;
  readonly water: Water | null = null;
  private x0: number;
  private y0: number;
  private cell: number;
  private nx: number;
  private ny: number;
  private hgt: Float32Array;
  /** Distance of each node to the centerline (approximate EDT). */
  readonly dist: Float32Array;
  private faceCenters: Float32Array;
  private colors: Float32Array;
  readonly corridor: number;
  /** Height the grid's border settles to (and the horizon skirt sits at). */
  private rimH = 0;

  constructor(private track: Track) {
    const b = track.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    const margin = Math.max(2200, span * 0.9);
    this.cell = Math.min(60, Math.max(28, span / 170));
    this.x0 = b.minX - margin;
    this.y0 = b.minY - margin;
    this.nx = Math.ceil((b.maxX - b.minX + margin * 2) / this.cell) + 1;
    this.ny = Math.ceil((b.maxY - b.minY + margin * 2) / this.cell) + 1;
    const N = this.nx * this.ny;
    this.hgt = new Float32Array(N);
    this.dist = new Float32Array(N);
    this.corridor = track.def.width / 2 + CONFIG.scenery.runOffWidth + 22;

    const theme = track.def.theme ?? "parco";
    const rand = mulberry32(hashString(track.def.id + ":terrain"));
    const noise = new ValueNoise(rand);

    const nearest = this.featureTransform();
    const fixed = this.trackFloor(nearest);
    this.relax(fixed);

    // Harbour: pick the waterfront side (where the track hugs its bounds).
    if (theme === "porto") this.water = this.makeSea();

    const relief = RELIEF[theme];
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const k = j * this.nx + i;
        if (fixed[k]) continue;
        const x = this.x0 + i * this.cell;
        const y = this.y0 + j * this.cell;
        const d = this.dist[k];
        const w = smooth(this.corridor, this.corridor + 520, d);
        let h = this.hgt[k] + noise.fbm(x / 1400, y / 1400) * relief.hills * w;
        if (relief.mountains) {
          const far = smooth(900, 3200, d);
          const ridge = 1 - Math.abs(noise.fbm(x / 1700 + 11, y / 1700 - 7, 5));
          h += ridge * ridge * relief.mountains * far;
        }
        if (this.water) {
          const s = this.shoreDistance(x, y);
          if (s > -260) h = Math.min(h, this.water.level + 6 + Math.max(0, -s) * 0.12);
          if (s > 0) h = Math.min(h, this.water.level - 8 - s * 0.2);
        }
        this.hgt[k] = h;
      }
    }

    this.rimH = this.blendRim(fixed);
    const built = this.buildMesh(noise);
    this.mesh = built.mesh;
    this.faceCenters = built.centers;
    this.colors = built.colors;
    this.skirt = this.buildSkirt();
  }

  private idx(i: number, j: number): number {
    return j * this.nx + i;
  }

  /**
   * Approximate Euclidean distance transform with nearest-feature propagation:
   * each track sample seeds its grid node, then two chamfer sweeps carry the
   * nearest sample index across the grid.
   */
  private featureTransform(): Int32Array {
    const { nx, ny, cell } = this;
    const s = this.track.samples;
    const near = new Int32Array(nx * ny).fill(-1);
    this.dist.fill(Infinity);
    const nodeDist = (k: number, si: number) => {
      const i = k % nx;
      const j = (k - i) / nx;
      return Math.hypot(this.x0 + i * cell - s[si].x, this.y0 + j * cell - s[si].y);
    };
    for (let si = 0; si < s.length - 1; si++) {
      const i = Math.round((s[si].x - this.x0) / cell);
      const j = Math.round((s[si].y - this.y0) / cell);
      const k = this.idx(i, j);
      const d = nodeDist(k, si);
      if (d < this.dist[k]) {
        this.dist[k] = d;
        near[k] = si;
      }
    }
    const relaxFrom = (k: number, n: number) => {
      const si = near[n];
      if (si < 0) return;
      const d = nodeDist(k, si);
      if (d < this.dist[k]) {
        this.dist[k] = d;
        near[k] = si;
      }
    };
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const k = this.idx(i, j);
          if (i > 0) relaxFrom(k, k - 1);
          if (j > 0) {
            relaxFrom(k, k - nx);
            if (i > 0) relaxFrom(k, k - nx - 1);
            if (i < nx - 1) relaxFrom(k, k - nx + 1);
          }
        }
      }
      for (let j = ny - 1; j >= 0; j--) {
        for (let i = nx - 1; i >= 0; i--) {
          const k = this.idx(i, j);
          if (i < nx - 1) relaxFrom(k, k + 1);
          if (j < ny - 1) {
            relaxFrom(k, k + nx);
            if (i < nx - 1) relaxFrom(k, k + nx + 1);
            if (i > 0) relaxFrom(k, k + nx - 1);
          }
        }
      }
    }
    return near;
  }

  /**
   * Nodes inside the track corridor are pinned just below the track surface —
   * below the *lowest* pass nearby, so an overpass never gets buried.
   */
  private trackFloor(near: Int32Array): Uint8Array {
    const fixed = new Uint8Array(this.nx * this.ny);
    const s = this.track.samples;
    const r2 = this.corridor * this.corridor;
    // Bucket samples for the crossover check.
    const bucket = new Map<string, number[]>();
    const bc = this.corridor;
    s.forEach((p, i) => {
      const key = `${Math.floor(p.x / bc)},${Math.floor(p.y / bc)}`;
      const l = bucket.get(key) ?? [];
      l.push(i);
      bucket.set(key, l);
    });
    for (let k = 0; k < fixed.length; k++) {
      if (this.dist[k] >= this.corridor || near[k] < 0) continue;
      const i = k % this.nx;
      const j = (k - i) / this.nx;
      const x = this.x0 + i * this.cell;
      const y = this.y0 + j * this.cell;
      let hMin = s[near[k]].h;
      const bx = Math.floor(x / bc);
      const by = Math.floor(y / bc);
      for (let a = -1; a <= 1; a++) {
        for (let c = -1; c <= 1; c++) {
          for (const si of bucket.get(`${bx + a},${by + c}`) ?? []) {
            const dx = s[si].x - x;
            const dy = s[si].y - y;
            if (dx * dx + dy * dy < r2) hMin = Math.min(hMin, s[si].h);
          }
        }
      }
      this.hgt[k] = hMin - 1.6;
      fixed[k] = 1;
    }
    return fixed;
  }

  /** Harmonic fill of the free nodes (SOR), so the land flows out of the track. */
  private relax(fixed: Uint8Array): void {
    const { nx, ny } = this;
    let sum = 0;
    let n = 0;
    for (let k = 0; k < fixed.length; k++) {
      if (fixed[k]) {
        sum += this.hgt[k];
        n++;
      }
    }
    const mean = n ? sum / n : 0;
    for (let k = 0; k < fixed.length; k++) if (!fixed[k]) this.hgt[k] = mean;
    const w = 1.85;
    for (let it = 0; it < 260; it++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          if (fixed[k]) continue;
          const l = this.hgt[i > 0 ? k - 1 : k + 1];
          const r = this.hgt[i < nx - 1 ? k + 1 : k - 1];
          const u = this.hgt[j > 0 ? k - nx : k + nx];
          const d = this.hgt[j < ny - 1 ? k + nx : k - nx];
          const avg = (l + r + u + d) / 4;
          this.hgt[k] += w * (avg - this.hgt[k]);
        }
      }
    }
  }

  private seaSide: { horizontal: boolean; dir: number; shore: number } | null = null;

  private makeSea(): Water {
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
    const gap = 150;
    const horizontal = side === "minY" || side === "maxY";
    const dir = side === "minX" || side === "minY" ? -1 : 1;
    const shore = side === "minX" ? b.minX - gap : side === "maxX" ? b.maxX + gap : side === "minY" ? b.minY - gap : b.maxY + gap;
    this.seaSide = { horizontal, dir, shore };
    const level = Math.min(...s.map((p) => p.h)) - 10;
    return { level, contains: (x, y) => this.shoreDistance(x, y) > 0 };
  }

  /** Signed distance past the shoreline (positive = out at sea). */
  shoreDistance(x: number, y: number): number {
    const s = this.seaSide;
    if (!s) return -Infinity;
    return ((s.horizontal ? y : x) - s.shore) * s.dir;
  }

  get seaInfo() {
    return this.seaSide;
  }

  /** Ground height at a point (bilinear over the grid; clamped at its edges). */
  heightAt(x: number, y: number): number {
    const fx = Math.max(0, Math.min(this.nx - 1.001, (x - this.x0) / this.cell));
    const fy = Math.max(0, Math.min(this.ny - 1.001, (y - this.y0) / this.cell));
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const k = this.idx(i, j);
    const a = this.hgt[k];
    const b = this.hgt[k + 1];
    const c = this.hgt[k + this.nx];
    const d = this.hgt[k + this.nx + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }

  /** Distance to the centerline at a point (from the grid EDT). */
  trackDistance(x: number, y: number): number {
    const i = Math.round(Math.max(0, Math.min(this.nx - 1, (x - this.x0) / this.cell)));
    const j = Math.round(Math.max(0, Math.min(this.ny - 1, (y - this.y0) / this.cell)));
    return this.dist[this.idx(i, j)];
  }

  private buildMesh(noise: ValueNoise): { mesh: Mesh; centers: Float32Array; colors: Float32Array } {
    const { nx, ny, cell } = this;
    const tris = (nx - 1) * (ny - 1) * 2;
    const pos = new Float32Array(tris * 9);
    const col = new Float32Array(tris * 9);
    const centers = new Float32Array(tris * 2);
    const c = new Color();
    let t = 0;
    const P = (i: number, j: number) => [this.x0 + i * cell, this.hgt[this.idx(i, j)], this.y0 + j * cell] as const;
    let hMax = -Infinity;
    for (const v of this.hgt) hMax = Math.max(hMax, v);
    const snowLine = this.water ? hMax * 0.72 : Infinity;
    const emit = (a: readonly number[], b: readonly number[], d: readonly number[]) => {
      // Wind every face counter-clockwise seen from above (front face up).
      const cross = (d[2] - a[2]) * (b[0] - a[0]) - (d[0] - a[0]) * (b[2] - a[2]);
      if (cross < 0) [b, d] = [d, b];
      pos.set([a[0], a[1], a[2], d[0], d[1], d[2], b[0], b[1], b[2]], t * 9);
      const cx = (a[0] + b[0] + d[0]) / 3;
      const cy = (a[2] + b[2] + d[2]) / 3;
      const ch = (a[1] + b[1] + d[1]) / 3;
      centers[t * 2] = cx;
      centers[t * 2 + 1] = cy;
      // Slope from the face normal's vertical component.
      const ux = d[0] - a[0], uy = d[1] - a[1], uz = d[2] - a[2];
      const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
      const nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
      const up = Math.abs(nyv) / (Math.hypot(nxv, nyv, nzv) || 1);
      const n = noise.at(cx / 180, cy / 180);
      c.copy(PAL.grassA).lerp(n > 0 ? PAL.grassC : PAL.grassB, Math.abs(n) * 0.9);
      if (up < 0.93) c.lerp(PAL.forest, 0.4);
      if (up < 0.8) c.lerp(PAL.dirt, 0.6);
      if (up < 0.62) c.copy(PAL.rock);
      if (ch > snowLine && up > 0.55) c.copy(PAL.snow);
      if (this.water) {
        const s = this.shoreDistance(cx, cy);
        if (s > -60) c.copy(PAL.sand);
      }
      for (let v = 0; v < 3; v++) col.set([c.r, c.g, c.b], t * 9 + v * 3);
      t++;
    };
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const p00 = P(i, j), p10 = P(i + 1, j), p01 = P(i, j + 1), p11 = P(i + 1, j + 1);
        if ((i + j) % 2) {
          emit(p00, p10, p11);
          emit(p00, p11, p01);
        } else {
          emit(p00, p10, p01);
          emit(p10, p11, p01);
        }
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.name = "terrain";
    return { mesh, centers, colors: col };
  }

  /** Recolour ground faces (e.g. city streets): `fn` returns a colour or null to keep. */
  paintFaces(fn: (x: number, y: number) => number | null): void {
    const c = new Color();
    const n = this.faceCenters.length / 2;
    for (let t = 0; t < n; t++) {
      const hex = fn(this.faceCenters[t * 2], this.faceCenters[t * 2 + 1]);
      if (hex == null) continue;
      c.setHex(hex);
      for (let v = 0; v < 3; v++) this.colors.set([c.r, c.g, c.b], t * 9 + v * 3);
    }
    (this.mesh.geometry.getAttribute("color") as Float32BufferAttribute).needsUpdate = true;
  }

  /**
   * Ease the outer band of the grid down to one rim height, so the flat horizon
   * skirt meets it seamlessly (a skirt at an arbitrary level would cut through
   * the landscape and bury low stretches of the track).
   */
  private blendRim(fixed: Uint8Array): number {
    let lo = Infinity;
    for (let k = 0; k < this.hgt.length; k++) if (fixed[k]) lo = Math.min(lo, this.hgt[k]);
    const rim = (this.water ? this.water.level : lo) - 25;
    const band = 30;
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const e = Math.min(i, j, this.nx - 1 - i, this.ny - 1 - j);
        if (e >= band) continue;
        const k = this.idx(i, j);
        const t = smooth(0, band, e);
        this.hgt[k] = rim + (this.hgt[k] - rim) * t;
      }
    }
    return rim;
  }

  /** A huge flat plane at the rim height so the tilted camera never sees the edge. */
  private buildSkirt(): Mesh {
    const size = Math.max(this.nx, this.ny) * this.cell * 8;
    const geo = new PlaneGeometry(size, size).rotateX(-Math.PI / 2);
    const mesh = new Mesh(geo, new MeshLambertMaterial({ color: PAL.grassB }));
    mesh.position.set(this.x0 + (this.nx * this.cell) / 2, this.rimH - 0.3, this.y0 + (this.ny * this.cell) / 2);
    mesh.receiveShadow = true;
    return mesh;
  }
}
