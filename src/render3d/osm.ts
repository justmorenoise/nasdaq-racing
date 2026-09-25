import { UNITS_PER_METRE, type Track } from "../track/Track";
import type { Pt } from "../track/centerline";

/**
 * Real-world surroundings from OpenStreetMap (`_risorse/osm/process.py` →
 * `public/osm/<id>.json`, © OpenStreetMap contributors, ODbL), used as a guide
 * for *where* things are around each circuit — stands, buildings, woods,
 * water, roads, car parks, gravel traps — and then drawn in the kit's
 * stylised low-poly look.
 *
 * The drawn circuit is a stylised SVG, so OSM coordinates are fitted onto it:
 *  1. a global similarity (scale, rotation, optional mirror, translation) by
 *     ICP between the OSM `raceway` ways and our centerline;
 *  2. a smooth local correction field from the residuals along the track,
 *     so trackside features follow the drawing's distortions;
 *  3. an outward push near the track, because our asphalt is drawn much wider
 *     than the real one (cars are oversized for readability) — anything
 *     beside the real road lands beside ours instead of on it.
 */

export interface OsmRaw {
  raceway: [number, number][][];
  /** The full lap from the OSM circuit relation (preferred for alignment). */
  lap?: [number, number][][];
  stands: number[][]; // [cx, cy, w, d, angle]
  buildings: number[][]; // [cx, cy, w, d, angle, levels]
  woods: [number, number][][];
  water: [number, number][][];
  coast: [number, number][][];
  roads: { w: number; p: [number, number][] }[];
  crossings: [number, number][];
  trees: [number, number][];
  parking: [number, number][][];
  gravel: [number, number][][];
  walls: [number, number][][];
  /** Fences within ~120 m of the lap (catch and spectator fences). */
  fences?: [number, number][][];
  /** Paved areas (asphalt/concrete, area:highway) beside the lap. */
  paved?: [number, number][][];
  attribution: string;
}

/** An OSM box (stand/building) mapped into track space. */
export interface OsmBox {
  x: number;
  y: number;
  w: number; // metres along its long axis (unscaled; the kit decides its size)
  d: number;
  angle: number; // radians in track space
  levels: number;
}

class Grid {
  private cells = new Map<number, number[]>();
  constructor(
    private pts: Pt[],
    private cell: number,
  ) {
    pts.forEach((p, i) => {
      const k = this.key(Math.floor(p.x / cell), Math.floor(p.y / cell));
      const l = this.cells.get(k);
      if (l) l.push(i);
      else this.cells.set(k, [i]);
    });
  }
  private key(i: number, j: number): number {
    return (i + 32768) * 65536 + (j + 32768);
  }
  /** Nearest point index within `maxR` (or -1). */
  nearest(x: number, y: number, maxR: number): { i: number; d: number } {
    const c = this.cell;
    const r = Math.ceil(maxR / c);
    const ci = Math.floor(x / c);
    const cj = Math.floor(y / c);
    let best = -1;
    let bd = maxR * maxR;
    for (let a = -r; a <= r; a++) {
      for (let b = -r; b <= r; b++) {
        for (const i of this.cells.get(this.key(ci + a, cj + b)) ?? []) {
          const dx = this.pts[i].x - x;
          const dy = this.pts[i].y - y;
          const d = dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      }
    }
    return { i: best, d: Math.sqrt(bd) };
  }
  within(x: number, y: number, r: number): number[] {
    const c = this.cell;
    const n = Math.ceil(r / c);
    const ci = Math.floor(x / c);
    const cj = Math.floor(y / c);
    const out: number[] = [];
    for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) out.push(...(this.cells.get(this.key(ci + a, cj + b)) ?? []));
    return out;
  }
}

interface Similarity {
  s: number;
  cos: number;
  sin: number;
  m: number; // 1 or -1 (mirror on x before rotating)
  tx: number;
  ty: number;
}

function apply(T: Similarity, x: number, y: number): Pt {
  const mx = x * T.m;
  return { x: T.s * (T.cos * mx - T.sin * y) + T.tx, y: T.s * (T.sin * mx + T.cos * y) + T.ty };
}

/** Least-squares similarity mapping src → dst (Umeyama, 2D, fixed mirror). */
function fitSimilarity(src: Pt[], dst: Pt[], m: number): Similarity {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i].x * m;
    sy += src[i].y;
    dx += dst[i].x;
    dy += dst[i].y;
  }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let a = 0, b = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i].x * m - sx;
    const py = src[i].y - sy;
    const qx = dst[i].x - dx;
    const qy = dst[i].y - dy;
    a += px * qx + py * qy;
    b += px * qy - py * qx;
    ss += px * px + py * py;
  }
  const r = Math.hypot(a, b) || 1e-9;
  const cos = a / r;
  const sin = b / r;
  const s = r / (ss || 1e-9);
  return { s, cos, sin, m, tx: dx - s * (cos * sx - sin * sy), ty: dy - s * (sin * sx + cos * sy) };
}

function resample(line: [number, number][], step: number): Pt[] {
  const out: Pt[] = [];
  for (let k = 1; k < line.length; k++) {
    const [ax, ay] = line[k - 1];
    const [bx, by] = line[k];
    const L = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(L / step));
    for (let t = 0; t < n; t++) out.push({ x: ax + ((bx - ax) * t) / n, y: ay + ((by - ay) * t) / n });
  }
  return out;
}

export class OsmWorld {
  readonly mirror: number;
  /** World units per real metre of the global fit. */
  readonly scale: number;
  /** Mean distance (world units) between our centerline and the fitted raceway. */
  readonly residual: number;
  private T: Similarity;
  private samples: Pt[];
  private sampleGrid: Grid;
  private corr: Pt[];
  private sigma = 200;
  private half: number;

  private constructor(
    readonly raw: OsmRaw,
    private track: Track,
  ) {
    const s = track.samples.slice(0, -1);
    this.samples = s.map((p) => ({ x: p.x, y: p.y }));
    this.sampleGrid = new Grid(this.samples, 150);
    this.half = track.def.width / 2;

    const { T, residual, corr } = track.def.realGeometry
      ? // The track *is* the OSM layout, at a uniform scale: nothing to fit.
        { T: { s: UNITS_PER_METRE, cos: 1, sin: 0, m: 1, tx: 0, ty: 0 }, residual: 0, corr: this.samples.map(() => ({ x: 0, y: 0 })) }
      : this.align((raw.lap?.length ? raw.lap : raw.raceway).flatMap((l) => resample(l, 8)));
    this.T = T;
    this.mirror = T.m;
    this.scale = T.s;
    this.residual = residual;
    this.corr = corr;
  }

  static async load(track: Track): Promise<OsmWorld | null> {
    try {
      const res = await fetch(`osm/${track.def.id}.json`);
      if (!res.ok) return null;
      const raw = (await res.json()) as OsmRaw;
      if (!raw.raceway?.length && !raw.lap?.length) return null;
      const w = new OsmWorld(raw, track);
      // A poor fit would scatter the world at random: better no OSM at all.
      return w.residual < track.def.width * 2.5 ? w : null;
    } catch {
      return null;
    }
  }

  /**
   * Coarse search over rotation × mirror, then trimmed ICP. Returns the fit,
   * its residual, and the per-sample residual vectors for the correction field.
   */
  private align(race: Pt[]): { T: Similarity; residual: number; corr: Pt[] } {
    const S = this.samples.filter((_, i) => i % 2 === 0);
    const lap = this.track.def.lapLengthM ?? this.track.length;
    const s0 = this.track.length / lap;
    const cS = S.reduce((a, p) => ({ x: a.x + p.x / S.length, y: a.y + p.y / S.length }), { x: 0, y: 0 });
    const cR = race.reduce((a, p) => ({ x: a.x + p.x / race.length, y: a.y + p.y / race.length }), { x: 0, y: 0 });

    const score = (T: Similarity, pairs = false, coarse = false) => {
      const tr = race.map((p) => apply(T, p.x, p.y));
      const g = new Grid(tr, coarse ? 250 : 120);
      const R = coarse ? 900 : 600;
      const d: { i: number; j: number; d: number }[] = [];
      S.forEach((p, i) => {
        if (coarse && i % 3) return;
        const n = g.nearest(p.x, p.y, R);
        if (n.i >= 0) d.push({ i, j: n.i, d: n.d });
        else d.push({ i, j: -1, d: R });
      });
      d.sort((a, b) => a.d - b.d);
      const keep = d.slice(0, Math.floor(d.length * 0.8));
      const mean = keep.reduce((a, x) => a + x.d, 0) / keep.length;
      return { mean, pairs: pairs ? keep.filter((x) => x.j >= 0).map((x) => [S[x.i], race[x.j]] as const) : [] };
    };

    const candidates: { T: Similarity; mean: number }[] = [];
    for (const m of [1, -1]) {
      for (let a = 0; a < 72; a++) {
        const th = (a / 72) * Math.PI * 2;
        const cos = Math.cos(th);
        const sin = Math.sin(th);
        const T: Similarity = { s: s0, cos, sin, m, tx: 0, ty: 0 };
        const c = apply(T, cR.x, cR.y);
        T.tx = cS.x - c.x;
        T.ty = cS.y - c.y;
        candidates.push({ T, mean: score(T, false, true).mean });
      }
    }
    candidates.sort((a, b) => a.mean - b.mean);
    let best = { T: candidates[0].T, mean: Infinity };
    for (const c of candidates.slice(0, 4)) {
      let T = c.T;
      for (let it = 0; it < 18; it++) {
        const { pairs } = score(T, true);
        T = fitSimilarity(
          pairs.map((p) => p[1]),
          pairs.map((p) => p[0]),
          T.m,
        );
      }
      const mean = score(T).mean;
      if (mean < best.mean) best = { T, mean };
    }
    // Residual field along our centerline.
    const tr = race.map((p) => apply(best.T, p.x, p.y));
    const g = new Grid(tr, 120);
    const corr = this.samples.map((p) => {
      const n = g.nearest(p.x, p.y, 400);
      return n.i < 0 ? { x: 0, y: 0 } : { x: p.x - tr[n.i].x, y: p.y - tr[n.i].y };
    });
    return { T: best.T, residual: best.mean, corr };
  }

  /**
   * OSM metres → track coordinates: global fit, local correction, then an
   * outward push away from the (wider) drawn asphalt. Returns null for points
   * that would still fall on the road.
   */
  map(x: number, y: number, clearance = 6): Pt | null {
    let p = this.mapRaw(x, y);

    const n = this.sampleGrid.nearest(p.x, p.y, 400);
    if (n.i >= 0) {
      const q = this.samples[n.i];
      const realHalf = this.track.def.realGeometry ? this.half : 7.5 * this.scale;
      const push = this.half + clearance - realHalf;
      const fall = Math.max(0, 1 - Math.max(0, n.d - this.half) / 260);
      if (n.d < 0.5) return null;
      const k = (push * fall) / n.d;
      p = { x: p.x + (p.x - q.x) * k, y: p.y + (p.y - q.y) * k };
      if (n.d + push * fall < this.half + clearance * 0.5) return null;
    }
    return p;
  }

  /** Map a polyline/polygon, dropping vertices that land on the track. */
  mapLine(line: [number, number][], clearance = 6): Pt[] {
    const out: Pt[] = [];
    for (const [x, y] of line) {
      const p = this.map(x, y, clearance);
      if (p) out.push(p);
    }
    return out;
  }

  mapBox(b: number[]): OsmBox | null {
    const p = this.map(b[0], b[1], 10);
    if (!p) return null;
    const a = b[4];
    const dir = apply({ ...this.T, tx: 0, ty: 0 }, Math.cos(a), Math.sin(a));
    return { x: p.x, y: p.y, w: b[2], d: b[3], angle: Math.atan2(dir.y, dir.x), levels: b[5] ?? 0 };
  }

  /**
   * Mapped coastline segments [x0, y0, x1, y1]… and the side the sea is on.
   * OSM coastlines keep the water on the right of their direction; with y
   * pointing down that is a positive cross product, and a mirrored fit flips
   * the handedness.
   */
  coastSegments(): { segs: Float32Array; sign: number } | null {
    const out: number[] = [];
    for (const line of this.raw.coast) {
      const pts = line.map(([x, y]) => this.mapRaw(x, y));
      for (let k = 1; k < pts.length; k++) out.push(pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y);
    }
    return out.length ? { segs: Float32Array.from(out), sign: this.mirror } : null;
  }

  /** Global fit + local correction only (no push): for large-scale shapes like coastlines. */
  mapRaw(x: number, y: number): Pt {
    const p = apply(this.T, x, y);
    let wx = 0;
    let cx = 0;
    let cy = 0;
    for (const i of this.sampleGrid.within(p.x, p.y, this.sigma * 2.5)) {
      const q = this.samples[i];
      const w = Math.exp(-((q.x - p.x) ** 2 + (q.y - p.y) ** 2) / (2 * this.sigma * this.sigma));
      wx += w;
      cx += w * this.corr[i].x;
      cy += w * this.corr[i].y;
    }
    return { x: p.x + cx / (wx + 0.35), y: p.y + cy / (wx + 0.35) };
  }

  /** Point-in-polygon tests for the mapped inland water bodies. */
  lakes(): Pt[][] {
    return this.raw.water.map((poly) => poly.map(([x, y]) => this.mapRaw(x, y)));
  }
}
