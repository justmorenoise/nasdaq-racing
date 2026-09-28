/**
 * The terrain heightfield as pure numeric work (no Three.js, no DOM), so it
 * can run in a Web Worker (`terrainWorker.ts`) while the loading screen keeps
 * animating: distance transform to the track, track-level corridor, harmonic
 * fill, themed relief, sea (real coastline or harbour heuristic), lakes and
 * the eased rim. `Terrain` turns the result into the mesh.
 */

export type ThemeName = "parco" | "bosco" | "citta" | "porto";

export interface FieldInput {
  id: string;
  theme: ThemeName;
  width: number;
  runOff: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Track samples interleaved [x, y, h, dist] (closing duplicate excluded). */
  samples: Float32Array;
  length: number;
  /** Mapped coastline segments [x0, y0, x1, y1]…, with the side the sea is on. */
  coast: Float32Array | null;
  seaSign: number;
  /** Mapped inland water polygons, each flattened [x, y, …]. */
  lakes: Float32Array[];
  /** World units per landscape unit (≈ metre): the relief's wavelengths and heights scale with it. */
  unit: number;
}

export interface FieldOutput {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
  corridor: number;
  hgt: Float32Array;
  dist: Float32Array;
  fixed: Uint8Array;
  /** Signed distance past the shore per node (+ = sea), when there is a real coast. */
  seaDist: Float32Array | null;
  /** Harbour heuristic (no real coast): the straight shoreline. */
  seaSide: { horizontal: boolean; dir: number; shore: number } | null;
  waterLevel: number | null;
  lakes: { poly: Float32Array; level: number }[];
  rimH: number;
}

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
export class ValueNoise {
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

/** The noise a circuit's terrain uses (shared by the field and the mesh colours). */
export function terrainNoise(id: string): ValueNoise {
  return new ValueNoise(mulberry32(hashString(id + ":terrain")));
}

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function pointInPoly(poly: { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const RELIEF: Record<ThemeName, { hills: number; mountains: number }> = {
  parco: { hills: 70, mountains: 0 },
  bosco: { hills: 150, mountains: 120 },
  citta: { hills: 35, mountains: 0 },
  porto: { hills: 50, mountains: 520 },
};

/** Exact height on the mesh triangles (same diagonal rule as the mesh). */
export function sampleHeight(hgt: Float32Array, nx: number, ny: number, x0: number, y0: number, cell: number, x: number, y: number): number {
  const fx = Math.max(0, Math.min(nx - 1.001, (x - x0) / cell));
  const fy = Math.max(0, Math.min(ny - 1.001, (y - y0) / cell));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const k = j * nx + i;
  const h00 = hgt[k];
  const h10 = hgt[k + 1];
  const h01 = hgt[k + nx];
  const h11 = hgt[k + nx + 1];
  if ((i + j) % 2) {
    return tx >= ty ? h00 + (h10 - h00) * tx + (h11 - h10) * ty : h00 + (h01 - h00) * ty + (h11 - h01) * tx;
  }
  return tx + ty <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * ty : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - ty);
}

export function computeField(inp: FieldInput): FieldOutput {
  const b = inp.bounds;
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const U = inp.unit;
  // Real layouts: ~6 m cells at least and a margin of ~0.7 of the circuit (the
  // horizon skirt covers beyond); drawn layouts keep their tuned grid.
  const margin = U > 1 ? Math.max(3000, span * 0.7) : Math.max(2200, span * 0.9);
  const cell = U > 1 ? Math.min(48, Math.max(6 * U, span / 220)) : Math.min(40, Math.max(14, span / 220));
  const x0 = b.minX - margin;
  const y0 = b.minY - margin;
  const nx = Math.ceil((b.maxX - b.minX + margin * 2) / cell) + 1;
  const ny = Math.ceil((b.maxY - b.minY + margin * 2) / cell) + 1;
  const N = nx * ny;
  const hgt = new Float32Array(N);
  const dist = new Float32Array(N).fill(Infinity);
  const corridor = inp.width / 2 + inp.runOff + 22;
  const S = inp.samples;
  const ns = S.length / 4;
  const sx = (i: number) => S[i * 4];
  const sy = (i: number) => S[i * 4 + 1];
  const sh = (i: number) => S[i * 4 + 2];
  const sd = (i: number) => S[i * 4 + 3];
  const idx = (i: number, j: number) => j * nx + i;

  // 1. Distance transform with nearest-sample propagation (two chamfer sweeps).
  const near = new Int32Array(N).fill(-1);
  const nodeDist = (k: number, si: number) => {
    const i = k % nx;
    const j = (k - i) / nx;
    return Math.hypot(x0 + i * cell - sx(si), y0 + j * cell - sy(si));
  };
  for (let si = 0; si < ns; si++) {
    const k = idx(Math.round((sx(si) - x0) / cell), Math.round((sy(si) - y0) / cell));
    const d = nodeDist(k, si);
    if (d < dist[k]) {
      dist[k] = d;
      near[k] = si;
    }
  }
  const relaxFrom = (k: number, n: number) => {
    const si = near[n];
    if (si < 0) return;
    const d = nodeDist(k, si);
    if (d < dist[k]) {
      dist[k] = d;
      near[k] = si;
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = idx(i, j);
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
        const k = idx(i, j);
        if (i < nx - 1) relaxFrom(k, k + 1);
        if (j < ny - 1) {
          relaxFrom(k, k + nx);
          if (i < nx - 1) relaxFrom(k, k + nx + 1);
          if (i > 0) relaxFrom(k, k + nx - 1);
        }
      }
    }
  }

  // 2. The corridor beside the road sits level with it; under an overpass
  //    the lower road wins; between passes at different levels it's left free.
  const fixed = new Uint8Array(N);
  const r2 = corridor * corridor;
  const roadR = inp.width / 2 + 14;
  const roadR2 = roadR * roadR;
  const L = inp.length;
  const bucket = new Map<number, number[]>();
  const bkey = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
  for (let i = 0; i < ns; i++) {
    const key = bkey(Math.floor(sx(i) / corridor), Math.floor(sy(i) / corridor));
    const l = bucket.get(key) ?? [];
    l.push(i);
    bucket.set(key, l);
  }
  // Beyond the corridor, a band eased toward the road's level after the fill,
  // so the ground leaves the road in a smooth slope rather than a staircase of
  // pinned cells (visible where two roads sit at different heights).
  const easeBand = cell * 3;
  const blendW = new Float32Array(N);
  const blendH = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    if (dist[k] >= corridor + easeBand || near[k] < 0) continue;
    const i = k % nx;
    const j = (k - i) / nx;
    const x = x0 + i * cell;
    const y = y0 + j * cell;
    const own = near[k];
    let h = sh(own);
    let foreignNear = false;
    const bx = Math.floor(x / corridor);
    const by = Math.floor(y / corridor);
    for (let a = -1; a <= 1; a++) {
      for (let c = -1; c <= 1; c++) {
        for (const q of bucket.get(bkey(bx + a, by + c)) ?? []) {
          const da = Math.abs(sd(q) - sd(own));
          if (Math.min(da, L - da) < corridor * 3) continue;
          const dd = (sx(q) - x) ** 2 + (sy(q) - y) ** 2;
          if (dd < r2) foreignNear = true;
          if (dd < roadR2) h = Math.min(h, sh(q));
        }
      }
    }
    if (foreignNear && dist[k] > roadR && Math.abs(h - sh(own)) < 0.01) continue;
    if (dist[k] >= corridor) {
      blendW[k] = 1 - smooth(corridor, corridor + easeBand, dist[k]);
      blendH[k] = h - 0.9;
      continue;
    }
    hgt[k] = h - 0.9;
    fixed[k] = 1;
  }

  // 3. Harmonic fill of the free nodes: coarse-to-fine SOR (plain SOR on the
  //    full grid needs hundreds of sweeps to carry the corridor's heights out).
  harmonicFill(hgt, fixed, nx, ny);
  for (let k = 0; k < N; k++) if (blendW[k] > 0) hgt[k] += (blendH[k] - hgt[k]) * blendW[k];

  let minH = Infinity;
  for (let i = 0; i < ns; i++) minH = Math.min(minH, sh(i));

  // 4. Sea: real coastline (flood-filled from open water) or harbour heuristic.
  let seaDist: Float32Array | null = null;
  let seaSide: FieldOutput["seaSide"] = null;
  let waterLevel: number | null = null;
  if (inp.coast && inp.coast.length) {
    seaDist = seaMask(inp.coast, inp.seaSign, nx, ny, x0, y0, cell, dist, corridor);
    waterLevel = minH - 4;
  } else if (inp.theme === "porto") {
    seaSide = heuristicSea(inp, ns, sx, sy);
    waterLevel = minH - 10;
  }
  const shore = (x: number, y: number, k: number): number => {
    if (seaDist) return seaDist[k];
    if (seaSide) return ((seaSide.horizontal ? y : x) - seaSide.shore) * seaSide.dir;
    return -Infinity;
  };

  // 5. Relief by theme, and the coast shaping.
  const noise = terrainNoise(inp.id);
  const relief = RELIEF[inp.theme];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (fixed[k]) continue;
      const x = x0 + i * cell;
      const y = y0 + j * cell;
      const d = dist[k];
      const w = smooth(corridor, corridor + 520 * U, d);
      let h = hgt[k] + noise.fbm(x / (1400 * U), y / (1400 * U)) * relief.hills * U * w;
      if (relief.mountains) {
        const far = smooth(900 * U, 3200 * U, d);
        const ridge = 1 - Math.abs(noise.fbm(x / (1700 * U) + 11, y / (1700 * U) - 7, 5));
        h += ridge * ridge * relief.mountains * U * far;
      }
      if (waterLevel !== null) {
        const s = shore(x, y, k);
        if (!seaDist && s > -260 * U) h = Math.min(h, waterLevel + 6 + Math.max(0, -s) * 0.12);
        if (seaDist && s > -30) h = Math.min(h, waterLevel + 3 + Math.max(0, -s) * 0.6);
        if (s > 0) h = Math.min(h, waterLevel - 8 - s * 0.2);
      }
      hgt[k] = h;
    }
  }

  // 6. Lakes: sink each to just under its lowest shore.
  const lakes: FieldOutput["lakes"] = [];
  for (const flat of inp.lakes) {
    const poly: { x: number; y: number }[] = [];
    for (let q = 0; q < flat.length; q += 2) poly.push({ x: flat[q], y: flat[q + 1] });
    if (poly.length < 3) continue;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    let level = Infinity;
    for (const p of poly) {
      bx0 = Math.min(bx0, p.x); by0 = Math.min(by0, p.y); bx1 = Math.max(bx1, p.x); by1 = Math.max(by1, p.y);
      level = Math.min(level, sampleHeight(hgt, nx, ny, x0, y0, cell, p.x, p.y));
    }
    level -= 1.5;
    let carved = 0;
    const i0 = Math.max(0, Math.floor((bx0 - x0) / cell));
    const i1 = Math.min(nx - 1, Math.ceil((bx1 - x0) / cell));
    const j0 = Math.max(0, Math.floor((by0 - y0) / cell));
    const j1 = Math.min(ny - 1, Math.ceil((by1 - y0) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = idx(i, j);
        if (fixed[k] || !pointInPoly(poly, x0 + i * cell, y0 + j * cell)) continue;
        hgt[k] = Math.min(hgt[k], level - 4);
        carved++;
      }
    }
    if (carved) lakes.push({ poly: flat, level });
  }

  // 7. Ease the border down to one rim height for the horizon skirt.
  let lo = Infinity;
  for (let k = 0; k < N; k++) if (fixed[k]) lo = Math.min(lo, hgt[k]);
  const rimH = (waterLevel ?? lo) - 25;
  const band = 30;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const e = Math.min(i, j, nx - 1 - i, ny - 1 - j);
      if (e >= band) continue;
      const k = idx(i, j);
      hgt[k] = rimH + (hgt[k] - rimH) * smooth(0, band, e);
    }
  }

  return { x0, y0, cell, nx, ny, corridor, hgt, dist, fixed, seaDist, seaSide, waterLevel, lakes, rimH };
}

/**
 * Signed distance past the mapped coastline per node, keeping only sea
 * connected to open water (flood fill from far offshore) and never near the
 * track.
 */
function seaMask(
  coast: Float32Array,
  sign: number,
  nx: number,
  ny: number,
  x0: number,
  y0: number,
  cell: number,
  dist: Float32Array,
  corridor: number,
): Float32Array {
  // Signed distance to the nearest coast segment on every node: exact near the
  // coast, then carried outward by nearest-segment propagation (two chamfer
  // sweeps, as for the track), so the cost is linear in the grid.
  const N = nx * ny;
  const near = new Int32Array(N).fill(-1);
  const d2 = new Float32Array(N).fill(Infinity);
  const segDist2 = (k: number, s: number): number => {
    const i = k % nx;
    const x = x0 + i * cell;
    const y = y0 + ((k - i) / nx) * cell;
    const ax = coast[s * 4], ay = coast[s * 4 + 1];
    const dx = coast[s * 4 + 2] - ax, dy = coast[s * 4 + 3] - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1e-9)));
    return (x - ax - dx * t) ** 2 + (y - ay - dy * t) ** 2;
  };
  for (let s = 0; s < coast.length / 4; s++) {
    const ax = coast[s * 4], ay = coast[s * 4 + 1], bx = coast[s * 4 + 2], by = coast[s * 4 + 3];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - x0) / cell) - 1);
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) - x0) / cell) + 1);
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - y0) / cell) - 1);
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by) - y0) / cell) + 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        const d = segDist2(k, s);
        if (d < d2[k] && d < (cell * 2) ** 2) {
          d2[k] = d;
          near[k] = s;
        }
      }
    }
  }
  const relax = (k: number, n: number) => {
    const s = near[n];
    if (s < 0) return;
    const d = segDist2(k, s);
    if (d < d2[k]) {
      d2[k] = d;
      near[k] = s;
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (i > 0) relax(k, k - 1);
        if (j > 0) {
          relax(k, k - nx);
          if (i > 0) relax(k, k - nx - 1);
          if (i < nx - 1) relax(k, k - nx + 1);
        }
      }
    }
    for (let j = ny - 1; j >= 0; j--) {
      for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i;
        if (i < nx - 1) relax(k, k + 1);
        if (j < ny - 1) {
          relax(k, k + nx);
          if (i < nx - 1) relax(k, k + nx + 1);
          if (i > 0) relax(k, k + nx - 1);
        }
      }
    }
  }
  const raw = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const s = near[k];
    if (s < 0) {
      raw[k] = -1e6;
      continue;
    }
    if (dist[k] < corridor + 20) {
      raw[k] = -1;
      continue;
    }
    const i = k % nx;
    const x = x0 + i * cell;
    const y = y0 + ((k - i) / nx) * cell;
    const ax = coast[s * 4], ay = coast[s * 4 + 1];
    const side = (coast[s * 4 + 2] - ax) * (y - ay) - (coast[s * 4 + 3] - ay) * (x - ax);
    raw[k] = (side * sign > 0 ? 1 : -1) * Math.sqrt(d2[k]);
  }
  const sea = new Uint8Array(nx * ny);
  const stack: number[] = [];
  for (let k = 0; k < raw.length; k++) if (raw[k] > 350) {
    sea[k] = 1;
    stack.push(k);
  }
  while (stack.length) {
    const k = stack.pop()!;
    const i = k % nx;
    const j = (k - i) / nx;
    const visit = (n: number) => {
      if (sea[n] || raw[n] <= 0) return;
      sea[n] = 1;
      stack.push(n);
    };
    if (i > 0) visit(k - 1);
    if (i < nx - 1) visit(k + 1);
    if (j > 0) visit(k - nx);
    if (j < ny - 1) visit(k + nx);
  }
  const out = new Float32Array(nx * ny);
  for (let k = 0; k < raw.length; k++) out[k] = sea[k] ? Math.max(1, raw[k]) : Math.min(-1, raw[k] > 0 ? -1 : raw[k]);
  return out;
}

/**
 * Fill the free (non-fixed) nodes with a harmonic interpolation of the fixed
 * ones: solve on a grid 4× coarser (a fixed coarse node takes the mean of the
 * fixed nodes in its block), then start the full grid from its bilinear
 * upsampling and finish with a few SOR sweeps.
 */
function harmonicFill(hgt: Float32Array, fixed: Uint8Array, nx: number, ny: number): void {
  const sor = (h: Float32Array, fx: Uint8Array, w: number, hh: number, iters: number) => {
    for (let it = 0; it < iters; it++) {
      for (let j = 0; j < hh; j++) {
        for (let i = 0; i < w; i++) {
          const k = j * w + i;
          if (fx[k]) continue;
          const l = h[i > 0 ? k - 1 : k + 1];
          const r = h[i < w - 1 ? k + 1 : k - 1];
          const u = h[j > 0 ? k - w : k + w];
          const d = h[j < hh - 1 ? k + w : k - w];
          h[k] += 1.85 * ((l + r + u + d) / 4 - h[k]);
        }
      }
    }
  };
  const F = 4;
  const cw = Math.ceil(nx / F);
  const ch = Math.ceil(ny / F);
  const ch_ = new Float32Array(cw * ch);
  const cf = new Uint8Array(cw * ch);
  const cnt = new Uint16Array(cw * ch);
  let sum = 0;
  let n = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!fixed[k]) continue;
      const c = Math.floor(j / F) * cw + Math.floor(i / F);
      ch_[c] += hgt[k];
      cnt[c]++;
      sum += hgt[k];
      n++;
    }
  }
  const mean = n ? sum / n : 0;
  for (let c = 0; c < cw * ch; c++) {
    if (cnt[c]) {
      ch_[c] /= cnt[c];
      cf[c] = 1;
    } else ch_[c] = mean;
  }
  sor(ch_, cf, cw, ch, 220);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (fixed[k]) continue;
      const fx = Math.min(cw - 1.001, Math.max(0, (i + 0.5) / F - 0.5));
      const fy = Math.min(ch - 1.001, Math.max(0, (j + 0.5) / F - 0.5));
      const ci = Math.floor(fx);
      const cj = Math.floor(fy);
      const tx = fx - ci;
      const ty = fy - cj;
      const a = ch_[cj * cw + ci], b = ch_[cj * cw + ci + 1];
      const c = ch_[(cj + 1) * cw + ci], d = ch_[(cj + 1) * cw + ci + 1];
      hgt[k] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  sor(hgt, fixed, nx, ny, 40);
}

/** Harbour theme without a mapped coast: the bounds side the lap hugs most. */
function heuristicSea(inp: FieldInput, ns: number, sx: (i: number) => number, sy: (i: number) => number): FieldOutput["seaSide"] {
  const b = inp.bounds;
  const spanX = b.maxX - b.minX;
  const spanY = b.maxY - b.minY;
  const counts = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  for (let i = 0; i < ns; i++) {
    if (Math.abs(sx(i) - b.minX) < spanX * 0.1) counts.minX++;
    if (Math.abs(sx(i) - b.maxX) < spanX * 0.1) counts.maxX++;
    if (Math.abs(sy(i) - b.minY) < spanY * 0.1) counts.minY++;
    if (Math.abs(sy(i) - b.maxY) < spanY * 0.1) counts.maxY++;
  }
  const side = (Object.keys(counts) as (keyof typeof counts)[]).reduce((a, k) => (counts[k] > counts[a] ? k : a));
  const gap = 150;
  const horizontal = side === "minY" || side === "maxY";
  const dir = side === "minX" || side === "minY" ? -1 : 1;
  const shore = side === "minX" ? b.minX - gap : side === "maxX" ? b.maxX + gap : side === "minY" ? b.minY - gap : b.maxY + gap;
  return { horizontal, dir, shore };
}
