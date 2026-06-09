import type { TrackSample } from "./Track";

/** One telemetry station: target speed + gear at a distance (m) around the lap. */
export interface TelemetryPoint {
  label?: string;
  /** Distance from the start/finish line, in metres. */
  distM: number;
  /** Target speed in km/h. */
  kmh: number;
  /** Gear used here (1..8). */
  gear: number;
}

const GEARS = 8;

/**
 * Base speed profile from telemetry. The hard part is *where* each braking zone
 * goes: a circuit SVG is a stylised drawing, so its arc-length is **not** a
 * linear function of real track distance (at Monza the first chicane sits ~250 m
 * *ahead* of where `distM/lapLength` predicts, the Parabolica ~400 m *behind*).
 * Positioning caps by raw distance therefore drops the brake zones on the wrong
 * stretch of tarmac. But positioning purely by curvature fails the other way —
 * the SVG draws the (fast) Parabolica as tight as the (slow) chicane, so the
 * gears come out wrong.
 *
 * So we split the two concerns: **positions come from the geometry** (corner =
 * curvature peak, aligned by construction) and **speeds/gears come from the
 * telemetry**. The telemetry's brake points (local speed minima) are matched to
 * the geometric corners *in lap order* (`matchCorners`, a monotonic
 * least-displacement assignment that absorbs the non-linear drawing distortion).
 * Then two caps are applied:
 *
 *  1. **Per-segment ceiling** — between two consecutive corners the car can only
 *     reach the *fastest telemetry speed recorded in that stretch*. A short
 *     straight between two slow corners (Roggia→Lesmo) keeps a mid gear instead
 *     of snapping to top speed/8th, while a real straight (the Serraglio, the pit
 *     straight) still tops out, so 8th lives only on the genuine fast sections.
 *  2. **Corner floor** — each corner's high-curvature region is capped at its
 *     telemetry speed.
 *
 * The caller's accel/brake passes then grow the approach/exit, so the car holds
 * the segment's top gear then brakes late into the corner, in the telemetry gear,
 * exactly where the track actually bends.
 */
export function telemetryBaseProfile(
  samples: TrackSample[],
  telemetry: TelemetryPoint[],
  length: number,
  startDist: number,
  lapLengthM: number,
  vMin: number,
  vMax: number,
): number[] {
  const n = samples.length;
  const [kmhMin, kmhMax] = telemetrySpeedRange(telemetry);
  const span = Math.max(1, kmhMax - kmhMin);
  const relAt = (kmh: number) => vMin + (vMax - vMin) * ((kmh - kmhMin) / span);

  const v = new Array<number>(n).fill(vMax);
  const matched = matchCorners(samples, telemetry, length, startDist, lapLengthM);

  if (!matched || matched.corners.length < 2) {
    // Degenerate (no detectable corners): drop each cap at its raw distance.
    const startFrac = startDist / length;
    for (const p of telemetry) {
      const frac = (((startFrac + p.distM / lapLengthM) % 1) + 1) % 1;
      const idx = nearestSampleIndex(samples, frac * length);
      const rel = relAt(p.kmh);
      if (rel < v[idx]) v[idx] = rel;
    }
    return v;
  }

  const { corners } = matched;
  const posOf = (i: number) =>
    ((((samples[i].dist - startDist) % length) + length) % length) / length;

  // 1. Per-segment ceiling between consecutive corners (lap order, wrapping).
  const C = corners.length;
  for (let c = 0; c < C; c++) {
    const a = corners[c];
    const b = corners[(c + 1) % C];
    let ceil = Math.max(relAt(a.kmh), relAt(b.kmh));
    for (const p of telemetry) {
      if (inArcDist(p.distM, a.distM, b.distM, lapLengthM)) {
        ceil = Math.max(ceil, relAt(p.kmh));
      }
    }
    for (let i = 0; i < n; i++) {
      if (inArcFrac(posOf(i), a.pos, b.pos) && ceil < v[i]) v[i] = ceil;
    }
  }

  // 2. Corner floor across each corner's high-curvature region.
  for (const cnr of corners) {
    const rel = relAt(cnr.kmh);
    const { lo, hi } = cnr.peak;
    for (let k = lo; k !== (hi + 1) % n; k = (k + 1) % n) {
      if (rel < v[k]) v[k] = rel;
    }
  }
  return v;
}

/** Is distance `d` in the open arc from `a` to `b` (metres, wrapping at `lap`)? */
function inArcDist(d: number, a: number, b: number, lap: number): boolean {
  const w = (x: number) => ((x % lap) + lap) % lap;
  d = w(d);
  a = w(a);
  b = w(b);
  return a < b ? d > a && d < b : d > a || d < b;
}

/** Is fraction `x` in the open arc from `a` to `b` (lap fractions, wrapping at 1)? */
function inArcFrac(x: number, a: number, b: number): boolean {
  return a < b ? x > a && x < b : x > a || x < b;
}

/** A telemetry brake point matched to a geometric corner. */
interface MatchedCorner {
  distM: number;
  kmh: number;
  gear: number;
  /** Arc-length fraction of the corner apex, from the start/finish line. */
  pos: number;
  peak: CornerPeak;
}

/**
 * Match the telemetry's brake points (local speed minima) to the circuit's
 * geometric corners (curvature peaks), preserving lap order. Returns the matched
 * corners (with their geometric apex position) ordered around the lap, or null
 * when nothing is detectable. Shared by the speed profile and the sector labels
 * so both place the telemetry on the same geometry.
 */
function matchCorners(
  samples: TrackSample[],
  telemetry: TelemetryPoint[],
  length: number,
  startDist: number,
  lapLengthM: number,
): { corners: MatchedCorner[] } | null {
  const minima = speedMinima(telemetry);
  const geom = curvaturePeaks(samples, startDist, length);
  if (!minima.length || !geom.length) return null;
  const match = monotonicMatch(
    minima.map((p) => (((p.distM / lapLengthM) % 1) + 1) % 1),
    geom.map((g) => g.pos),
  );
  const corners: MatchedCorner[] = [];
  for (let i = 0; i < minima.length; i++) {
    const g = match[i];
    if (g < 0) continue;
    corners.push({
      distM: minima[i].distM,
      kmh: minima[i].kmh,
      gear: minima[i].gear,
      pos: geom[g].pos,
      peak: geom[g],
    });
  }
  corners.sort((a, b) => a.pos - b.pos);
  return { corners };
}

/** A named stretch of track at an arc-length distance (for the on-screen readout). */
export interface TelemetrySector {
  dist: number;
  label: string;
  kmh: number;
  gear: number;
}

/**
 * Place every named telemetry station at its true arc-length position so the UI
 * can show which sector a car is in. The matched corners are exact anchors; the
 * straights between them are interpolated through a piecewise-linear distance→arc
 * remap built from those anchors (plus the start/finish line), which absorbs the
 * non-linear drawing distortion the same way the speed profile does.
 */
export function telemetrySectors(
  samples: TrackSample[],
  telemetry: TelemetryPoint[],
  length: number,
  startDist: number,
  lapLengthM: number,
): TelemetrySector[] {
  const matched = matchCorners(samples, telemetry, length, startDist, lapLengthM);
  // distM → lap-fraction knots: start/finish line + each matched corner apex.
  const knots = [{ d: 0, f: 0 }];
  if (matched) for (const c of matched.corners) knots.push({ d: c.distM, f: c.pos });
  knots.push({ d: lapLengthM, f: 1 });
  knots.sort((a, b) => a.d - b.d);

  const remap = (distM: number): number => {
    const d = ((distM % lapLengthM) + lapLengthM) % lapLengthM;
    let i = 0;
    while (i < knots.length - 1 && d >= knots[i + 1].d) i++;
    const a = knots[i];
    const b = knots[Math.min(i + 1, knots.length - 1)];
    const t = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
    return ((a.f + (b.f - a.f) * t) % 1 + 1) % 1;
  };

  return telemetry
    .filter((p) => p.label)
    .map((p) => ({
      dist: (((startDist + remap(p.distM) * length) % length) + length) % length,
      label: p.label as string,
      kmh: p.kmh,
      gear: p.gear,
    }))
    .sort((a, b) => a.dist - b.dist);
}

/** Index of the centreline sample whose arc-length is nearest `dist`. */
function nearestSampleIndex(samples: TrackSample[], dist: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].dist < dist) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(samples[lo - 1].dist - dist) < Math.abs(samples[lo].dist - dist)) {
    return lo - 1;
  }
  return lo;
}

/** Telemetry stations that are local speed minima around the lap (brake points). */
function speedMinima(telemetry: TelemetryPoint[]): TelemetryPoint[] {
  const m = telemetry.length;
  if (m <= 2) return telemetry.slice();
  const out: TelemetryPoint[] = [];
  for (let i = 0; i < m; i++) {
    const prev = telemetry[(i - 1 + m) % m].kmh;
    const cur = telemetry[i].kmh;
    const next = telemetry[(i + 1) % m].kmh;
    if (cur <= prev && cur <= next && (cur < prev || cur < next)) out.push(telemetry[i]);
  }
  return out.length ? out : telemetry.slice();
}

/** A detected corner: peak sample index, its high-curvature region [lo,hi] (may
 *  wrap), and its normalised lap position measured from the start/finish line. */
interface CornerPeak {
  idx: number;
  lo: number;
  hi: number;
  pos: number;
}

/**
 * Curvature peaks = corner apices. Smooths curvature, keeps prominent local
 * maxima, merges those closer than a min lap-gap, and grows each into the
 * contiguous region where curvature stays above half its peak (the corner's
 * slow floor). Positions are normalised from the start/finish line so they share
 * the telemetry's coordinate.
 */
function curvaturePeaks(
  samples: TrackSample[],
  startDist: number,
  length: number,
): CornerPeak[] {
  const n = samples.length;
  const win = 2;
  const sm = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let d = -win; d <= win; d++) s += samples[((i + d) % n + n) % n].curvature;
    sm[i] = s / (2 * win + 1);
  }
  const maxC = Math.max(...sm) || 1e-9;
  const thr = maxC * 0.16;
  const minGap = length * 0.025;

  const raw: { idx: number; c: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (sm[i] >= thr && sm[i] >= sm[(i - 1 + n) % n] && sm[i] >= sm[(i + 1) % n]) {
      raw.push({ idx: i, c: sm[i] });
    }
  }
  // Merge peaks closer than minGap (along the loop), keeping the sharper one.
  const merged: { idx: number; c: number }[] = [];
  for (const p of raw) {
    const last = merged[merged.length - 1];
    const gap = last ? Math.abs(samples[p.idx].dist - samples[last.idx].dist) : Infinity;
    if (last && gap < minGap) {
      if (p.c > last.c) merged[merged.length - 1] = p;
    } else {
      merged.push(p);
    }
  }

  return (
    merged
      .map(({ idx, c }) => {
        const floor = c * 0.5;
        let lo = idx;
        while (sm[(lo - 1 + n) % n] >= floor && (lo - 1 + n) % n !== idx) lo = (lo - 1 + n) % n;
        let hi = idx;
        while (sm[(hi + 1) % n] >= floor && (hi + 1) % n !== idx) hi = (hi + 1) % n;
        const rel = ((samples[idx].dist - startDist) % length + length) % length;
        return { idx, lo, hi, pos: rel / length };
      })
      // Peaks come out in sample-index order (from the SVG path start); the match
      // needs them ordered from the start/finish line, like the telemetry.
      .sort((a, b) => a.pos - b.pos)
  );
}

/**
 * Assign each telemetry brake point a geometric corner, preserving lap order and
 * minimising total positional displacement (a small DP). Corners may be skipped
 * (more geometric corners than brake points); a brake point left unmatched
 * returns -1. Absorbs the non-linear drawing distortion because it matches by
 * *order*, not absolute distance.
 */
function monotonicMatch(tele: number[], geom: number[]): number[] {
  const T = tele.length;
  const G = geom.length;
  const SKIP = 1; // penalty for leaving a brake point unmatched
  const INF = Infinity;
  // dp[t][g] = best cost matching tele[t..] using geom[g..].
  const dp: number[][] = Array.from({ length: T + 1 }, () => new Array<number>(G + 1).fill(0));
  const choice: number[][] = Array.from({ length: T + 1 }, () => new Array<number>(G + 1).fill(0));
  for (let t = T - 1; t >= 0; t--) {
    dp[t][G] = dp[t + 1][G] + SKIP; // no corners left → unmatched
    choice[t][G] = -1;
    for (let g = G - 1; g >= 0; g--) {
      const matchCost = Math.abs(tele[t] - geom[g]) + dp[t + 1][g + 1];
      const skipGeom = dp[t][g + 1];
      const skipTele = SKIP + dp[t + 1][g];
      let best = matchCost;
      let ch = g; // matched to geom[g]
      if (skipGeom < best) {
        best = skipGeom;
        ch = -2; // advance geom, keep tele
      }
      if (skipTele < best) {
        best = skipTele;
        ch = -1; // leave tele[t] unmatched
      }
      dp[t][g] = best === INF ? INF : best;
      choice[t][g] = ch;
    }
  }
  const out = new Array<number>(T).fill(-1);
  let t = 0;
  let g = 0;
  while (t < T) {
    if (g >= G) {
      out[t] = -1;
      t++;
      continue;
    }
    const ch = choice[t][g];
    if (ch === -2) {
      g++;
    } else if (ch === -1) {
      out[t] = -1;
      t++;
    } else {
      out[t] = ch;
      t++;
      g++;
    }
  }
  return out;
}

/**
 * Telemetry is used to *calibrate* (not position) the model: the speed→gear
 * relationship and the real km/h range. Corner POSITIONS come from the track
 * geometry (the speed profile dips where the track actually bends), which is
 * exactly aligned by construction — far more robust than trying to line up
 * telemetry distances with an arbitrarily-scaled SVG centreline.
 */
export function telemetrySpeedRange(telemetry: TelemetryPoint[]): [number, number] {
  const kmhs = telemetry.map((t) => t.kmh);
  return [Math.min(...kmhs), Math.max(...kmhs)];
}

/**
 * Gear boundaries (8 ascending relSpeed upper edges) from the telemetry (speed,
 * gear) pairs. The km/h are mapped onto [vMin,vMax] (slowest corner → vMin, top
 * speed → vMax), the same range the curvature speed profile uses, so a sample's
 * speed maps to the gear that telemetry uses at that speed. The edge between gear
 * g and g+1 sits midway between the fastest point still in gear ≤g and the
 * slowest in gear >g; a gear never seen (e.g. 1st at Monza) gets a −∞ edge.
 */
export function gearBoundsFromTelemetry(
  telemetry: TelemetryPoint[],
  vMin: number,
  vMax: number,
): number[] {
  const [kmhMin, kmhMax] = telemetrySpeedRange(telemetry);
  const span = Math.max(1, kmhMax - kmhMin);
  const relAt = (kmh: number) => vMin + (vMax - vMin) * ((kmh - kmhMin) / span);
  const pairs = telemetry.map((t) => ({ rel: relAt(t.kmh), gear: t.gear }));

  const bounds = new Array<number>(GEARS).fill(vMax);
  for (let g = 1; g < GEARS; g++) {
    const low = pairs.filter((p) => p.gear <= g).map((p) => p.rel);
    const high = pairs.filter((p) => p.gear > g).map((p) => p.rel);
    if (!low.length) bounds[g - 1] = -Infinity; // gear never used → disabled
    else if (!high.length) bounds[g - 1] = vMax;
    else bounds[g - 1] = (Math.max(...low) + Math.min(...high)) / 2;
  }
  bounds[GEARS - 1] = vMax;
  for (let g = 1; g < GEARS; g++) {
    if (bounds[g] < bounds[g - 1]) bounds[g] = bounds[g - 1]; // keep ascending
  }
  return bounds;
}
