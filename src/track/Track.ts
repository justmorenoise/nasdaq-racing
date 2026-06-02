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

  constructor(def: TrackDef, centerline: Pt[] = buildCenterline(def)) {
    this.def = def;
    this.samples = this.buildSamples(centerline);
    this.length = this.samples[this.samples.length - 1].dist;

    const { relSpeeds, rawLapTime } = computeSpeedProfile(this.samples);
    this.samples.forEach((s, i) => (s.relSpeed = relSpeeds[i]));
    this.rawLapTime = rawLapTime;

    this.bounds = this.computeBounds();
    this.startDist = this.computeStartDist();
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
      const curvature = Math.abs(dx * ddy - dy * ddx) / (speed * speed * speed);
      if (i > 0) dist += Math.hypot(cur.x - pts[i - 1].x, cur.y - pts[i - 1].y);
      samples.push({
        x: cur.x,
        y: cur.y,
        dist,
        tangent: Math.atan2(dy, dx),
        nx: -dy / speed,
        ny: dx / speed,
        curvature: Number.isFinite(curvature) ? curvature : 0,
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
