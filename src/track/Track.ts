import { computeSpeedProfile } from "./speedProfile";
import {
  interpCircular,
  telemetryDistanceRemap,
  telemetrySectors,
  type TelemetryPoint,
  type TelemetrySector,
} from "./telemetry";
import { catmullRomPolyline, type Pt } from "./centerline";
import { halfWidths, racingLine } from "./racingLine";
import { UNITS_PER_METRE } from "./units";

export type TrackTheme = "parco" | "bosco" | "citta" | "porto";

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
  /** Scenery theme for the 3D surroundings (render-only). */
  theme?: TrackTheme;
  /** Street circuit (render-only): barriers at the kerb, sidewalks, no gravel. */
  street?: boolean;
  /** Tunnels between two telemetry sector labels (render-only). */
  tunnels?: [string, string][];
  /** Gear-usage distribution (gears 1..8): the % of the lap spent in each gear,
   *  used to derive the gearbox shift points for this circuit. From
   *  `distribuzione_marce` in circuits.json; defaults applied if absent. */
  gearDistribution?: number[];
  /** Per-corner telemetry (speed/gear at distances around the lap). When present
   *  (with `lapLengthM`) it drives the speed profile and gear boundaries; from
   *  `telemetria` in circuits.json. */
  telemetry?: TelemetryPoint[];
  /** Real lap length in metres (`lunghezza_metri`): scales telemetry distances to
   *  lap fractions so they align with the geometry. */
  lapLengthM?: number;
  /** Real elevation profile: [metres from the start/finish line, metres above the lowest point]. */
  elevation?: [number, number][];
  /** Real asphalt width in metres (from circuits.json). */
  widthM?: number;
  /** Centerline is the real layout (OSM) at UNITS_PER_METRE, starting at the timing line. */
  realGeometry?: boolean;
  /** Real pit lane, entry → exit (world units). */
  pitLane?: Pt[];
  /** Official corners: F1 lap distance (m) and lap fraction along the centerline. */
  corners?: { n: number; letter: string; distM: number; frac: number }[];
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
  /** Track surface height here (world units), from the real elevation profile. */
  h: number;
}

export interface TrackPose {
  x: number;
  y: number;
  tangent: number;
  nx: number;
  ny: number;
  /** Surface height (world units). */
  h: number;
}

/** Real hills read flat at the game's oversized-car scale; exaggerate them a little. */
const ELEVATION_EXAGGERATION = 1.5;

export { UNITS_PER_METRE } from "./units";

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

/** Shoelace area of a closed polyline (sign = winding). */
function loopArea(loop: Pt[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const j = (i + 1) % loop.length;
    a += loop[i].x * loop[j].y - loop[j].x * loop[i].y;
  }
  return a / 2;
}

/** Even-odd ray cast: is (x,y) inside the closed polyline? */
function pointInPolygon(loop: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Closed polyline → its segment list (including the wrap-around segment). */
function loopSegments(loop: Pt[]): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; i < loop.length; i++) segs.push([loop[i], loop[(i + 1) % loop.length]]);
  return segs;
}

/**
 * Nearest forward intersection of the ray (px,py)+t·(dx,dy), t>0, with any
 * segment - i.e. where the centerline normal first crosses a track edge.
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
  /** Gear-boundary speeds (8 ascending relSpeed upper edges) for this circuit. */
  readonly gearBounds: number[];
  /** [min, max] real speed (km/h) this circuit reaches, for the speed readout. */
  readonly speedRangeKmh: [number, number];
  /** Named telemetry sectors at their arc-length positions (empty without
   *  telemetry), for the on-screen "which corner am I in" readout. */
  readonly sectors: TelemetrySector[];
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
  /** Per-sample flag: this station lies where the track overlaps itself (a
   *  figure-8 crossover or near-touching passes). Renderers suppress edge
   *  decorations (kerbs) here so they don't get drawn across the other pass. */
  readonly nearSelf: boolean[];
  /** Smoothed half-width of the drawn asphalt per sample: [+normal side, −normal side]. */
  readonly hw: [Float32Array, Float32Array];
  /** Racing-line lateral offset per sample (world units along +normal). */
  readonly racing: Float32Array;
  /** Car footprint on this circuit (world units), for spacing and contact. */
  readonly carLength: number;
  readonly carWidth: number;
  /** Covered stretches as [startDist, endDist] arc-length ranges (may wrap). */
  readonly tunnels: [number, number][];
  private anchors?: { d: number; f: number }[];

  constructor(def: TrackDef, centerline: Pt[] = buildCenterline(def)) {
    this.def = def;
    this.samples = this.buildSamples(centerline);
    this.length = this.samples[this.samples.length - 1].dist;

    this.bounds = this.computeBounds();
    // startDist is needed before the profile: telemetry distances are measured
    // from the start/finish line, so they're offset by it onto our arc-length.
    this.startDist = this.computeStartDist();

    const anchors = def.corners?.map((c) => ({ d: c.distM, f: c.frac }));
    this.anchors = anchors;
    const { relSpeeds, rawLapTime, gearBounds, speedRangeKmh } = computeSpeedProfile(
      this.samples,
      {
        gearDistribution: def.gearDistribution,
        telemetry: def.telemetry,
        startDist: this.startDist,
        lapLengthM: def.lapLengthM,
        anchors,
      },
    );
    this.samples.forEach((s, i) => (s.relSpeed = relSpeeds[i]));
    this.rawLapTime = rawLapTime;
    this.gearBounds = gearBounds;
    this.speedRangeKmh = speedRangeKmh;
    this.applyElevation();
    this.sectors =
      def.telemetry?.length && def.lapLengthM
        ? telemetrySectors(this.samples, def.telemetry, this.length, this.startDist, def.lapLengthM, anchors)
        : [];

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
    this.nearSelf = this.computeNearSelf();
    this.tunnels = this.computeTunnels();
    const scale = def.scale ?? 1;
    this.carLength = 30 * scale;
    this.carWidth = 11 * scale;
    this.hw = halfWidths(this.samples, def.width / 2, this.edgeLeft, this.edgeRight);
    this.racing = racingLine(this.samples, this.hw, this.carWidth / 2 + 3);
  }

  /**
   * Flag stations where the track overlaps itself: a sample whose space is within
   * roughly a track-width of another sample far away in arc length (a figure-8
   * crossover, or two passes nearly touching). Uses the local half-width so the
   * threshold scales per circuit.
   */
  private computeNearSelf(): boolean[] {
    const n = this.samples.length - 1;
    const half = this.def.width / 2;
    const hw: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      if (this.edgeLeft) {
        const l = this.edgeLeft[i];
        const r = this.edgeRight![i];
        hw[i] = (Math.hypot(l.x - s.x, l.y - s.y) + Math.hypot(r.x - s.x, r.y - s.y)) / 2;
      } else {
        hw[i] = half;
      }
    }
    const flags = new Array<boolean>(n).fill(false);
    const arcGap = this.length * 0.08; // ignore neighbours along the same pass
    for (let i = 0; i < n; i++) {
      const si = this.samples[i];
      for (let j = 0; j < n; j++) {
        const da = Math.abs(si.dist - this.samples[j].dist);
        if (Math.min(da, this.length - da) < arcGap) continue;
        const sj = this.samples[j];
        if (Math.hypot(si.x - sj.x, si.y - sj.y) < (hw[i] + hw[j]) * 1.5) {
          flags[i] = true;
          break;
        }
      }
    }
    return flags;
  }

  /**
   * Sample the two edge loops and, for each centerline sample, find the left and
   * right edge points by casting a ray from the centerline along its ± normal
   * and taking the nearest crossing of either loop. This lands the edge point
   * exactly on the real track boundary at that station (so kerbs/run-off sit on
   * the asphalt edge for any width), and is robust to edited layouts - no
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

    // Edge points lie along each sample's ± normal, so we work with their signed
    // distances. Cast both sides (fall back to half-width when a ray misses).
    const tL: number[] = [];
    const tR: number[] = [];
    const all: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      const l = castRay(segs, s.x, s.y, s.nx, s.ny);
      const r = castRay(segs, s.x, s.y, -s.nx, -s.ny);
      const dl = l ? Math.hypot(l.x - s.x, l.y - s.y) : half;
      const dr = r ? Math.hypot(r.x - s.x, r.y - s.y) : half;
      tL.push(dl);
      tR.push(dr);
      if (l) all.push(dl);
      if (r) all.push(dr);
    }

    // A ray that slips through a gap (near the start/finish or a chicane where
    // loops nearly meet) lands on a far edge - a short spike that would make
    // kerbs, run-off and tire walls jump across the track. Cap overlong casts to
    // a few times the median half-width, then a median-of-5 pass removes the
    // remaining 1–2 sample spikes so the edge stays continuous.
    all.sort((a, b) => a - b);
    const cap = (all.length ? all[all.length >> 1] : half) * 3;
    const smooth = (arr: number[]): number[] => {
      const c = arr.map((v) => Math.min(v, cap));
      return c.map((_, i) => {
        const w = [-2, -1, 0, 1, 2].map((d) => c[(i + d + n) % n]).sort((a, b) => a - b);
        return w[2];
      });
    };
    const sL = smooth(tL);
    const sR = smooth(tR);

    const left: Pt[] = [];
    const right: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      left.push({ x: s.x + s.nx * sL[i], y: s.y + s.ny * sL[i] });
      right.push({ x: s.x - s.nx * sR[i], y: s.y - s.ny * sR[i] });
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

  private outerLoopCache?: Pt[];

  /**
   * Whether (x,y) lies on the asphalt ribbon: inside the outer edge loop and
   * outside every inner island. Always false without real edges. Lets the
   * renderers drop decorations (kerb cells, grandstands) that strayed onto the road.
   */
  onAsphalt(x: number, y: number): boolean {
    if (!this.edgeLoops) return false;
    if (!this.outerLoopCache) {
      this.outerLoopCache = this.edgeLoops.reduce((a, b) =>
        Math.abs(loopArea(a)) >= Math.abs(loopArea(b)) ? a : b,
      );
    }
    const outer = this.outerLoopCache;
    if (!pointInPolygon(outer, x, y)) return false;
    for (const loop of this.edgeLoops) {
      if (loop !== outer && pointInPolygon(loop, x, y)) return false;
    }
    return true;
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
        h: 0,
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

  /**
   * Heights per sample from the real elevation profile, placed through the
   * telemetry distance→arc remap and scaled at the track's own horizontal scale
   * (world units per real metre), so slopes keep their real grade.
   */
  private applyElevation(): void {
    const prof = this.def.elevation;
    const lapM = this.def.lapLengthM;
    if (!prof?.length || !lapM) return;
    const remap = telemetryDistanceRemap(this.samples, this.def.telemetry, this.length, this.startDist, lapM, this.anchors);
    // Street circuits climb through a town: exaggerating them turns hillsides into cliffs.
    const unitsPerM = (this.length / lapM) * (this.def.street ? 1 : ELEVATION_EXAGGERATION);
    const pts = prof.map(([d, e]) => ({ pos: remap(d), h: e * unitsPerM })).sort((a, b) => a.pos - b.pos);
    const pos = pts.map((p) => p.pos);
    const hs = pts.map((p) => p.h);
    for (const s of this.samples) {
      const x = ((((s.dist - this.startDist) % this.length) + this.length) % this.length) / this.length;
      s.h = interpCircular(pos, hs, x);
    }
    this.liftOverpasses(unitsPerM);
  }

  /**
   * Where the lap crosses itself (Suzuka's figure-eight), guarantee headroom:
   * the smoothed elevation profile flattens the real bridge, so the upper pass
   * is raised with a smooth bump until it clears the lower one by ~6 m.
   */
  private liftOverpasses(unitsPerM: number): void {
    const s = this.samples;
    const n = s.length - 1;
    const L = this.length;
    const clear = 6.5 * unitsPerM;
    const reach = this.def.width * 0.8;
    const bumps: { i: number; need: number }[] = [];
    for (let i = 0; i < n; i += 2) {
      for (let j = i + 1; j < n; j += 2) {
        const da = Math.abs(s[i].dist - s[j].dist);
        if (Math.min(da, L - da) < L * 0.1) continue;
        if (Math.hypot(s[i].x - s[j].x, s[i].y - s[j].y) > reach) continue;
        const [up, lo] = s[i].h >= s[j].h ? [i, j] : [j, i];
        const need = clear - (s[up].h - s[lo].h);
        if (need > 0) bumps.push({ i: up, need });
      }
    }
    if (!bumps.length) return;
    // Merge into one bump per crossing (the strongest need at each spot).
    const sigma = L * 0.018;
    const add = new Float64Array(n + 1);
    for (const b of bumps) {
      for (let k = 0; k <= n; k++) {
        const da = Math.abs(s[k].dist - s[b.i].dist);
        const d = Math.min(da, L - da);
        add[k] = Math.max(add[k], b.need * Math.exp(-(d * d) / (2 * sigma * sigma)));
      }
    }
    for (let k = 0; k <= n; k++) s[k].h += add[k];
  }

  private computeTunnels(): [number, number][] {
    const out: [number, number][] = [];
    for (const [from, to] of this.def.tunnels ?? []) {
      const a = this.sectors.find((s) => s.label.startsWith(from));
      const b = this.sectors.find((s) => s.label.startsWith(to));
      if (!a || !b) continue;
      // Exit a little before the next braking point, which sits in daylight.
      out.push([a.dist, this.wrap(b.dist - this.def.width * 1.5)]);
    }
    return out;
  }

  /** Linear interpolation of a per-sample array at an arc-length distance. */
  private sampleAt(arr: ArrayLike<number>, dist: number): number {
    const d = this.wrap(dist);
    const i = this.indexFor(d);
    const n = this.samples.length - 1;
    const a = this.samples[i];
    const b = this.samples[Math.min(i + 1, n)];
    const f = Math.min(Math.max((d - a.dist) / (b.dist - a.dist || 1e-6), 0), 1);
    return arr[i % n] + (arr[(i + 1) % n] - arr[i % n]) * f;
  }

  /** Racing-line lateral offset at a distance (world units, +normal). */
  racingAt(dist: number): number {
    return this.sampleAt(this.racing, dist);
  }

  /** Usable lateral range [min, max] for a car centre at a distance (edges minus half a car). */
  lateralLimits(dist: number): [number, number] {
    const m = this.carWidth / 2 + 1.5;
    return [-(this.sampleAt(this.hw[1], dist) - m), this.sampleAt(this.hw[0], dist) - m];
  }

  /** World units per real metre (uniform on real layouts, lap-averaged on drawn ones). */
  get unitsPerMetre(): number {
    if (this.def.realGeometry) return UNITS_PER_METRE;
    return this.def.lapLengthM ? this.length / this.def.lapLengthM : 1;
  }

  /** Whether an arc-length distance is inside a tunnel. */
  inTunnel(dist: number): boolean {
    const d = this.wrap(dist);
    return this.tunnels.some(([a, b]) => (a <= b ? d >= a && d <= b : d >= a || d <= b));
  }

  /** Surface height at an arc-length distance (auto-wrapped). */
  heightAt(dist: number): number {
    const d = this.wrap(dist);
    const i = this.indexFor(d);
    const a = this.samples[i];
    const b = this.samples[Math.min(i + 1, this.samples.length - 1)];
    const f = Math.min(Math.max((d - a.dist) / (b.dist - a.dist || 1e-6), 0), 1);
    return a.h + (b.h - a.h) * f;
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
      h: a.h + (b.h - a.h) * f,
    };
  }

  /** Name of the telemetry sector nearest an arc-length distance ("" if none). */
  sectorAt(dist: number): string {
    if (!this.sectors.length) return "";
    const d = this.wrap(dist);
    let best = this.sectors[0].label;
    let bestGap = Infinity;
    for (const s of this.sectors) {
      const raw = Math.abs(s.dist - d);
      const gap = Math.min(raw, this.length - raw);
      if (gap < bestGap) {
        bestGap = gap;
        best = s.label;
      }
    }
    return best;
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
