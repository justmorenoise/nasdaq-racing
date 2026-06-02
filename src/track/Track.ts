import { computeSpeedProfile } from "./speedProfile";
import {
  catmullRomPolyline,
  sampleSvgPath,
  type Pt,
} from "./centerline";

export interface TrackDef {
  id: string;
  name: string;
  /** Reference lap time in seconds for a "neutral" (0%) stock. */
  baseLapTime: number;
  /** Ribbon width in world units. */
  width: number;
  /** Sparse control points (Catmull-Rom smoothed). Use this OR `svgPath`. */
  points?: [number, number][];
  /** An SVG path `d` (centerline) sampled directly. Use this OR `points`. */
  svgPath?: string;
  /** Optional real track edges (two closed SVG subpaths: outer + inner). When
   *  present the renderer draws the asphalt/kerbs from these instead of
   *  offsetting the centerline by a fixed width. */
  edges?: [string, string];
  /** Start/finish marker location in source (pre-scale) coords, if known. */
  startMarker?: [number, number];
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
const SVG_SAMPLES = 520;
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

/**
 * Build the dense centerline polyline a track definition implies, oriented so
 * that increasing arc length travels in the requested direction (`verso`).
 */
export function buildCenterline(def: TrackDef): Pt[] {
  let pts: Pt[];
  if (def.svgPath) pts = sampleSvgPath(def.svgPath, SVG_SAMPLES, SVG_SCALE);
  else if (def.points) pts = catmullRomPolyline(def.points, CR_SUBDIV);
  else throw new Error(`Track ${def.id} has neither points nor svgPath`);

  if (def.verso) {
    const winding = signedArea(pts) > 0 ? "cw" : "ccw";
    if (winding !== def.verso) pts.reverse();
  }
  return pts;
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
   *  falls back to offsetting the centerline by a fixed width). The two loops
   *  are the raw sampled edges; edgeLeft/edgeRight hold, per centerline sample,
   *  the point on the edge to its left (+normal) / right (-normal). */
  readonly edgeLoops: [Pt[], Pt[]] | null;
  readonly edgeLeft: Pt[] | null;
  readonly edgeRight: Pt[] | null;

  constructor(def: TrackDef, centerline: Pt[] = buildCenterline(def)) {
    this.def = def;
    this.samples = this.buildSamples(centerline);
    this.length = this.samples[this.samples.length - 1].dist;

    const { relSpeeds, rawLapTime } = computeSpeedProfile(this.samples);
    this.samples.forEach((s, i) => (s.relSpeed = relSpeeds[i]));
    this.rawLapTime = rawLapTime;

    this.bounds = this.computeBounds();
    this.startDist = this.computeStartDist();

    if (def.edges) {
      const e = this.computeEdges(def.edges);
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
   * Sample the two edge loops and, for each centerline sample, find the nearest
   * point on each loop, classifying them as the left/right edge by the sign of
   * their offset along the centerline normal. Falls back to a fixed half-width
   * offset for the rare sample where both nearest points land on the same side.
   */
  private computeEdges(edges: [string, string]): {
    loops: [Pt[], Pt[]];
    left: Pt[];
    right: Pt[];
  } {
    const loopA = sampleSvgPath(edges[0], SVG_SAMPLES, SVG_SCALE);
    const loopB = sampleSvgPath(edges[1], SVG_SAMPLES, SVG_SCALE);
    const n = this.samples.length - 1;
    const half = this.def.width / 2;

    // Orient both edge loops the same rotational way as the centerline and align
    // their start, so we can pair points by *progress*: searching only a window
    // around the expected position prevents snapping to a different, nearby part
    // of the track (e.g. where two straights run close together).
    const clSign = Math.sign(signedArea(this.samples.slice(0, n)));
    const orient = (loop: Pt[]) =>
      Math.sign(signedArea(loop)) !== clSign ? loop.reverse() : loop;
    orient(loopA);
    orient(loopB);
    const startOf = (loop: Pt[]) => {
      const s0 = this.samples[0];
      let bi = 0;
      let bd = Infinity;
      loop.forEach((p, k) => {
        const d = (p.x - s0.x) ** 2 + (p.y - s0.y) ** 2;
        if (d < bd) {
          bd = d;
          bi = k;
        }
      });
      return bi;
    };
    const aStart = startOf(loopA);
    const bStart = startOf(loopB);
    const winNearest = (loop: Pt[], start: number, frac: number, x: number, y: number) => {
      const M = loop.length;
      const W = Math.max(8, Math.round(0.12 * M));
      const c = start + Math.round(frac * M);
      let best = loop[((c % M) + M) % M];
      let bd = Infinity;
      for (let d = -W; d <= W; d++) {
        const p = loop[(((c + d) % M) + M) % M];
        const dd = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (dd < bd) {
          bd = dd;
          best = p;
        }
      }
      return best;
    };

    const left: Pt[] = [];
    const right: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      const f = i / n;
      const a = winNearest(loopA, aStart, f, s.x, s.y);
      const b = winNearest(loopB, bStart, f, s.x, s.y);
      const sa = (a.x - s.x) * s.nx + (a.y - s.y) * s.ny;
      const sb = (b.x - s.x) * s.nx + (b.y - s.y) * s.ny;
      if (sa >= 0 && sb < 0) {
        left.push(a);
        right.push(b);
      } else if (sb >= 0 && sa < 0) {
        left.push(b);
        right.push(a);
      } else {
        left.push({ x: s.x + s.nx * half, y: s.y + s.ny * half });
        right.push({ x: s.x - s.nx * half, y: s.y - s.ny * half });
      }
    }
    return { loops: [loopA, loopB], left, right };
  }

  /** Nearest centerline arc-length to the start/finish marker. */
  private computeStartDist(): number {
    if (!this.def.startMarker) return 0;
    const scale = this.def.svgPath ? SVG_SCALE : 1;
    const mx = this.def.startMarker[0] * scale;
    const my = this.def.startMarker[1] * scale;
    let best = 0;
    let bestD = Infinity;
    for (const s of this.samples) {
      const d = (s.x - mx) ** 2 + (s.y - my) ** 2;
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
