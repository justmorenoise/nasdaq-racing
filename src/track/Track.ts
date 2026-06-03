import { computeSpeedProfile } from "./speedProfile";
import { catmullRomPolyline, type Pt } from "./centerline";

export interface TrackDef {
  id: string;
  name: string;
  /** Reference lap time in seconds for a "neutral" (0%) stock. */
  baseLapTime: number;
  /** Ribbon width in world units (fallback when no real edges; already scaled). */
  width: number;
  /** Per-circuit size lever: multiplies fallback width and car size (default 1). */
  scale?: number;
  /** Per-circuit kerb size lever: multiplies kerb width and cell length
   *  (default 1). Independent of `scale` so narrow circuits (e.g. Suzuka) can
   *  shrink their kerbs without touching the car/width scale. */
  kerbScale?: number;
  /** Sparse control points (Catmull-Rom smoothed). Use this for hand-made ovals;
   *  SVG circuits pass a pre-sampled centerline to the constructor instead. */
  points?: [number, number][];
  /** Optional real track edges (closed loops: one outer + N inner islands), in
   *  world coords. When present the renderer draws the asphalt/kerbs from these
   *  instead of offsetting the centerline by a fixed width. */
  edgeLoops?: Pt[][];
  /** Start/finish marker in world coords, if known. */
  startWorld?: Pt;
  /** Travel direction: clockwise or counter-clockwise (as seen on screen). */
  verso?: "cw" | "ccw";
}

export interface TrackSample {
  x: number;
  y: number;
  /** Cumulative arc length from the start/finish line. */
  dist: number;
  /** Heading angle of the centerline (radians). */
  tangent: number;
  /** Unit normal pointing to the left of travel. */
  nx: number;
  ny: number;
  /** Curvature 1/r (always >= 0). */
  curvature: number;
  /** Signed curvature: same magnitude as `curvature`, sign encodes turn
   *  direction. With (nx,ny) pointing left of travel, a positive value bends
   *  the track toward the left (the inside is on the +normal side). */
  signedCurvature: number;
  /** Relative speed shape in [vMin, vMax], filled by the speed profile. */
  relSpeed: number;
}

export interface TrackPose {
  x: number;
  y: number;
  tangent: number;
  nx: number;
  ny: number;
}

/** Scale applied to SVG layouts so they sit in the same world scale (~0..1500). */
export const SVG_SCALE = 3;
const CR_SUBDIV = 22;

/** Signed polygon area (shoelace). In screen coords (y down), > 0 == clockwise. */
function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}

/** Reverse a closed polyline if its winding doesn't match the requested verso. */
export function orientByVerso(pts: Pt[], verso?: "cw" | "ccw"): Pt[] {
  if (verso) {
    const winding = signedArea(pts) > 0 ? "cw" : "ccw";
    if (winding !== verso) pts.reverse();
  }
  return pts;
}

/**
 * Build the dense centerline for a hand-made (Catmull-Rom) track, oriented so
 * that increasing arc length travels in the requested direction. SVG circuits
 * pass their already-sampled centerline to the constructor instead.
 */
export function buildCenterline(def: TrackDef): Pt[] {
  if (!def.points) throw new Error(`Track ${def.id} has no points`);
  return orientByVerso(catmullRomPolyline(def.points, CR_SUBDIV), def.verso);
}

type Seg = [Pt, Pt];

/** Closed polyline → its segment list (including the wrap-around segment). */
function loopSegments(loop: Pt[]): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; i < loop.length; i++) segs.push([loop[i], loop[(i + 1) % loop.length]]);
  return segs;
}

/**
 * Nearest forward intersection of the ray (px,py)+t·(dx,dy), t>0, with any
 * segment — i.e. where the centerline normal first crosses a track edge.
 */
function castRay(segs: Seg[], px: number, py: number, dx: number, dy: number): Pt | null {
  let bestT = Infinity;
  let hit: Pt | null = null;
  for (const [a, b] of segs) {
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const det = ex * dy - dx * ey;
    if (Math.abs(det) < 1e-9) continue; // parallel
    const qx = a.x - px;
    const qy = a.y - py;
    const t = (ex * qy - ey * qx) / det; // distance along the ray
    const u = (dx * qy - dy * qx) / det; // position along the segment
    if (t > 1e-6 && u >= 0 && u <= 1 && t < bestT) {
      bestT = t;
      hit = { x: px + dx * t, y: py + dy * t };
    }
  }
  return hit;
}

export class Track {
  readonly def: TrackDef;
  readonly samples: TrackSample[];
  readonly length: number;
  readonly rawLapTime: number;
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Arc-length of the start/finish line (0 if no marker is known). */
  readonly startDist: number;
  /** Real track edges, when the layout provides them (else null → the renderer
   *  falls back to offsetting the centerline by a fixed width). The loops are the
   *  raw sampled edges (one outer + N inner islands); edgeLeft/edgeRight hold, per
   *  centerline sample, the point on the edge to its left (+normal) / right
   *  (-normal). */
  readonly edgeLoops: Pt[][] | null;
  readonly edgeLeft: Pt[] | null;
  readonly edgeRight: Pt[] | null;
  /** Flattened segments of all edge loops, for ray queries (clearance checks). */
  private edgeSegments: Seg[] = [];

  constructor(def: TrackDef, centerline: Pt[] = buildCenterline(def)) {
    this.def = def;
    this.samples = this.buildSamples(centerline);
    this.length = this.samples[this.samples.length - 1].dist;

    const { relSpeeds, rawLapTime } = computeSpeedProfile(this.samples);
    this.samples.forEach((s, i) => (s.relSpeed = relSpeeds[i]));
    this.rawLapTime = rawLapTime;

    this.bounds = this.computeBounds();
    this.startDist = this.computeStartDist();

    if (def.edgeLoops) {
      const e = this.computeEdges(def.edgeLoops);
      this.edgeLoops = e.loops;
      this.edgeLeft = e.left;
      this.edgeRight = e.right;
    } else {
      this.edgeLoops = null;
      this.edgeLeft = null;
      this.edgeRight = null;
    }
  }

  /**
   * Sample the two edge loops and, for each centerline sample, find the left and
   * right edge points by casting a ray from the centerline along its ± normal
   * and taking the nearest crossing of either loop. This lands the edge point
   * exactly on the real track boundary at that station (so kerbs/run-off sit on
   * the asphalt edge for any width), and is robust to edited layouts — no
   * progress/arc-length pairing to drift. Falls back to a fixed half-width when
   * a ray finds no crossing (centerline outside the ribbon). Works with any
   * number of loops, so a circuit whose infield is split into several islands
   * (e.g. Monaco) is handled by casting against every loop.
   */
  private computeEdges(loops: Pt[][]): {
    loops: Pt[][];
    left: Pt[];
    right: Pt[];
  } {
    const n = this.samples.length - 1;
    const half = this.def.width / 2;
    const segs = loops.flatMap(loopSegments);
    this.edgeSegments = segs;

    // First pass: raw casts on both sides, collecting hit distances.
    const lh: (Pt | null)[] = [];
    const rh: (Pt | null)[] = [];
    const dists: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      const l = castRay(segs, s.x, s.y, s.nx, s.ny);
      const r = castRay(segs, s.x, s.y, -s.nx, -s.ny);
      lh.push(l);
      rh.push(r);
      if (l) dists.push(Math.hypot(l.x - s.x, l.y - s.y));
      if (r) dists.push(Math.hypot(r.x - s.x, r.y - s.y));
    }

    // A ray that slips through a gap (e.g. near the start/finish or a chicane
    // where loops nearly meet) lands on a far edge, which would make kerbs and
    // run-off jump across the track. Clamp any cast longer than a few times the
    // median half-width back along its own normal.
    dists.sort((a, b) => a - b);
    const cap = (dists.length ? dists[dists.length >> 1] : half) * 3;
    const clamp = (px: number, py: number, dx: number, dy: number, hit: Pt | null): Pt => {
      if (!hit) return { x: px + dx * half, y: py + dy * half };
      const t = Math.hypot(hit.x - px, hit.y - py);
      return t > cap ? { x: px + dx * cap, y: py + dy * cap } : hit;
    };

    const left: Pt[] = [];
    const right: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      left.push(clamp(s.x, s.y, s.nx, s.ny, lh[i]));
      right.push(clamp(s.x, s.y, -s.nx, -s.ny, rh[i]));
    }
    return { loops, left, right };
  }

  /**
   * Distance from (px,py) along the unit direction (dx,dy) to the nearest edge
   * crossing, or Infinity with no real edges / no hit. Used to size scenery (the
   * pit complex) so it never reaches across a narrow infield onto the far track.
   */
  edgeRayDistance(px: number, py: number, dx: number, dy: number): number {
    const hit = castRay(this.edgeSegments, px, py, dx, dy);
    return hit ? Math.hypot(hit.x - px, hit.y - py) : Infinity;
  }

  /** Nearest centerline arc-length to the start/finish marker. */
  private computeStartDist(): number {
    const marker = this.def.startWorld;
    if (!marker) return 0;
    let best = 0;
    let bestD = Infinity;
    for (const s of this.samples) {
      const d = (s.x - marker.x) ** 2 + (s.y - marker.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s.dist;
      }
    }
    return best;
  }

  /**
   * Compute geometry (tangent, normal, curvature, arc length) from a closed
   * polyline using central finite differences. The loop closes implicitly; a
   * final duplicate-of-first sample is appended to simplify interpolation.
   */
  private buildSamples(pts: Pt[]): TrackSample[] {
    const n = pts.length;
    const samples: TrackSample[] = [];
    let dist = 0;
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const cur = pts[i];
      const next = pts[(i + 1) % n];
      const dx = (next.x - prev.x) / 2;
      const dy = (next.y - prev.y) / 2;
      const ddx = next.x - 2 * cur.x + prev.x;
      const ddy = next.y - 2 * cur.y + prev.y;
      const speed = Math.hypot(dx, dy) || 1e-6;
      const cross = dx * ddy - dy * ddx;
      const curvature = Math.abs(cross) / (speed * speed * speed);
      const signedCurvature = cross / (speed * speed * speed);
      if (i > 0) dist += Math.hypot(cur.x - pts[i - 1].x, cur.y - pts[i - 1].y);
      samples.push({
        x: cur.x,
        y: cur.y,
        dist,
        tangent: Math.atan2(dy, dx),
        nx: -dy / speed,
        ny: dx / speed,
        curvature: Number.isFinite(curvature) ? curvature : 0,
        signedCurvature: Number.isFinite(signedCurvature) ? signedCurvature : 0,
        relSpeed: 0,
      });
    }
    const first = samples[0];
    const last = pts[n - 1];
    samples.push({
      ...first,
      dist: dist + Math.hypot(first.x - last.x, first.y - last.y),
    });
    return samples;
  }

  private computeBounds() {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const s of this.samples) {
      if (s.x < minX) minX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.x > maxX) maxX = s.x;
      if (s.y > maxY) maxY = s.y;
    }
    return { minX, minY, maxX, maxY };
  }

  /** Wrap a distance into [0, length). */
  wrap(dist: number): number {
    const L = this.length;
    return ((dist % L) + L) % L;
  }

  private indexFor(dist: number): number {
    const s = this.samples;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].dist <= dist) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Centerline pose at an arc-length distance (auto-wrapped). */
  poseAt(dist: number): TrackPose {
    const d = this.wrap(dist);
    const i = this.indexFor(d);
    const a = this.samples[i];
    const b = this.samples[Math.min(i + 1, this.samples.length - 1)];
    const span = b.dist - a.dist || 1e-6;
    const f = Math.min(Math.max((d - a.dist) / span, 0), 1);
    const tx = Math.cos(a.tangent) * (1 - f) + Math.cos(b.tangent) * f;
    const ty = Math.sin(a.tangent) * (1 - f) + Math.sin(b.tangent) * f;
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      tangent: Math.atan2(ty, tx),
      nx: a.nx + (b.nx - a.nx) * f,
      ny: a.ny + (b.ny - a.ny) * f,
    };
  }

  /** Relative speed shape at a distance (auto-wrapped). */
  relSpeedAt(dist: number): number {
    const d = this.wrap(dist);
    const i = this.indexFor(d);
    const a = this.samples[i];
    const b = this.samples[Math.min(i + 1, this.samples.length - 1)];
    const span = b.dist - a.dist || 1e-6;
    const f = Math.min(Math.max((d - a.dist) / span, 0), 1);
    return a.relSpeed + (b.relSpeed - a.relSpeed) * f;
  }
}
