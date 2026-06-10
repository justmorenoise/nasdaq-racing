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
 * Base speed profile from telemetry. The telemetry stations *are* the profile:
 * the real speed at a sequence of points around the lap (apices, plus — where the
 * data provides them — the braking/approach/exit points that shape each corner).
 * So the profile is a **direct interpolation** of those speeds, and the caller
 * skips its accel/brake passes (which would pull straights back below their data
 * speed and erase the late braking the data encodes).
 *
 * The only hard part is *where* each station sits: a circuit SVG is a stylised
 * drawing, so its arc-length is **not** a linear function of real track distance
 * (at Monza the first chicane sits ~250 m *ahead* of where `distM/lapLength`
 * predicts, the Parabolica ~400 m *behind*). So the corner apices (telemetry speed
 * minima) are matched to the geometric corners (curvature peaks) *in lap order*
 * (`alignTelemetry` → `monotonicMatch`), and those matched pairs anchor a
 * piecewise-linear distance→arc remap that places every other station — absorbing
 * the non-linear distortion. The profile then passes through each station's speed
 * exactly, at the spot where the track actually bends.
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

  const aligned = alignTelemetry(samples, telemetry, length, startDist, lapLengthM);

  if (!aligned || aligned.length < 2) {
    // Degenerate (no detectable corners): drop each speed at its raw distance.
    const v = new Array<number>(n).fill(vMax);
    const startFrac = startDist / length;
    for (const p of telemetry) {
      const frac = (((startFrac + p.distM / lapLengthM) % 1) + 1) % 1;
      const idx = nearestSampleIndex(samples, frac * length);
      const rel = relAt(p.kmh);
      if (rel < v[idx]) v[idx] = rel;
    }
    return v;
  }

  const pos = aligned.map((s) => s.pos);
  const rel = aligned.map((s) => relAt(s.kmh));
  const v = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const x = ((((samples[i].dist - startDist) % length) + length) % length) / length;
    v[i] = interpCircular(pos, rel, x);
  }
  return v;
}

/**
 * Linear interpolation of `rel` over the lap-fraction positions `pos` (ascending,
 * in [0,1)), wrapping around the start/finish line (the segment from the last
 * station back to the first crosses pos = 1 → 0).
 */
function interpCircular(pos: number[], rel: number[], x: number): number {
  const P = pos.length;
  if (x < pos[0] || x >= pos[P - 1]) {
    const a = pos[P - 1];
    const b = pos[0] + 1;
    const xe = x < pos[0] ? x + 1 : x;
    const t = b > a ? (xe - a) / (b - a) : 0;
    return rel[P - 1] + (rel[0] - rel[P - 1]) * t;
  }
  let lo = 0;
  let hi = P - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pos[mid] <= x) lo = mid;
    else hi = mid;
  }
  const t = pos[hi] > pos[lo] ? (x - pos[lo]) / (pos[hi] - pos[lo]) : 0;
  return rel[lo] + (rel[hi] - rel[lo]) * t;
}

/** A telemetry station placed on the track geometry. */
interface AlignedStation {
  /** Arc-length fraction from the start/finish line. */
  pos: number;
  kmh: number;
  gear: number;
  label?: string;
}

/**
 * Place every telemetry station on the track geometry. The corner apices (speed
 * minima) are matched to curvature peaks in lap order; the matched pairs (plus the
 * start/finish line) anchor a piecewise-linear distance→arc remap that positions
 * every other station, absorbing the non-linear drawing distortion. Returns the
 * stations ordered around the lap, or null when nothing is detectable. Shared by
 * the speed profile and the sector labels so both sit on the same geometry.
 */
function alignTelemetry(
  samples: TrackSample[],
  telemetry: TelemetryPoint[],
  length: number,
  startDist: number,
  lapLengthM: number,
): AlignedStation[] | null {
  const geom = curvaturePeaks(samples, startDist, length);
  if (!geom.length) return null;

  const minIdx = speedMinimaIndices(telemetry);
  if (!minIdx.length) return null;

  const match = monotonicMatch(
    minIdx.map((i) => (((telemetry[i].distM / lapLengthM) % 1) + 1) % 1),
    geom.map((g) => g.pos),
  );

  // distM → lap-fraction anchors: start/finish line + each matched apex.
  const anchors = [{ d: 0, f: 0 }];
  const posByIdx = new Map<number, number>();
  for (let c = 0; c < minIdx.length; c++) {
    const g = match[c];
    if (g < 0) continue;
    anchors.push({ d: telemetry[minIdx[c]].distM, f: geom[g].pos });
    posByIdx.set(minIdx[c], geom[g].pos);
  }
  anchors.push({ d: lapLengthM, f: 1 });
  anchors.sort((a, b) => a.d - b.d);

  const remap = (distM: number): number => {
    const d = ((distM % lapLengthM) + lapLengthM) % lapLengthM;
    let i = 0;
    while (i < anchors.length - 1 && d >= anchors[i + 1].d) i++;
    const a = anchors[i];
    const b = anchors[Math.min(i + 1, anchors.length - 1)];
    const t = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
    return ((a.f + (b.f - a.f) * t) % 1 + 1) % 1;
  };

  const stations: AlignedStation[] = telemetry.map((p, i) => ({
    pos: posByIdx.has(i) ? (posByIdx.get(i) as number) : remap(p.distM),
    kmh: p.kmh,
    gear: p.gear,
    label: p.label,
  }));
  stations.sort((a, b) => a.pos - b.pos);
  return stations;
}

/**
 * Telemetry stations that are local speed minima around the lap (corner apices).
 * Only **named** stations count: unlabeled rows are gear-anchor helper points (they
 * pin `gearBounds`/refine straight speeds), and a low-speed anchor sitting between
 * faster neighbours would otherwise read as a false apex and get matched to a
 * curvature peak, corrupting the distance→arc alignment. Indices are into the full
 * `telemetry` array. Comparison uses each named station's named neighbours.
 */
function speedMinimaIndices(telemetry: TelemetryPoint[]): number[] {
  const named = telemetry.map((_, i) => i).filter((i) => telemetry[i].label);
  const m = named.length;
  if (m <= 2) return named;
  const out: number[] = [];
  for (let k = 0; k < m; k++) {
    const prev = telemetry[named[(k - 1 + m) % m]].kmh;
    const cur = telemetry[named[k]].kmh;
    const next = telemetry[named[(k + 1) % m]].kmh;
    if (cur <= prev && cur <= next && (cur < prev || cur < next)) out.push(named[k]);
  }
  return out.length ? out : named;
}

/** A named stretch of track at an arc-length distance (for the on-screen readout). */
export interface TelemetrySector {
  dist: number;
  label: string;
  kmh: number;
  gear: number;
}

/**
 * Named telemetry stations at their true arc-length positions, so the UI can show
 * which sector a car is in. Reuses `alignTelemetry` (same geometry as the speed
 * profile); falls back to raw-distance placement when alignment isn't possible.
 */
export function telemetrySectors(
  samples: TrackSample[],
  telemetry: TelemetryPoint[],
  length: number,
  startDist: number,
  lapLengthM: number,
): TelemetrySector[] {
  const aligned = alignTelemetry(samples, telemetry, length, startDist, lapLengthM);
  const toDist = (pos: number) => (((startDist + pos * length) % length) + length) % length;

  if (aligned) {
    return aligned
      .filter((s) => s.label)
      .map((s) => ({ dist: toDist(s.pos), label: s.label as string, kmh: s.kmh, gear: s.gear }))
      .sort((a, b) => a.dist - b.dist);
  }

  const startFrac = startDist / length;
  return telemetry
    .filter((p) => p.label)
    .map((p) => ({
      dist: toDist((((startFrac + p.distM / lapLengthM) % 1) + 1) % 1),
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

/** A detected corner: peak sample index and its normalised lap position (from the
 *  start/finish line). */
interface CornerPeak {
  idx: number;
  pos: number;
}

/**
 * Curvature peaks = corner apices. Smooths curvature, keeps prominent local
 * maxima, and merges those closer than a min lap-gap. Positions are normalised
 * from the start/finish line so they share the telemetry's coordinate.
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
      .map(({ idx }) => {
        const rel = ((samples[idx].dist - startDist) % length + length) % length;
        return { idx, pos: rel / length };
      })
      // Peaks come out in sample-index order (from the SVG path start); the match
      // needs them ordered from the start/finish line, like the telemetry.
      .sort((a, b) => a.pos - b.pos)
  );
}

/**
 * Assign each corner apex a geometric corner, preserving lap order and minimising
 * total positional displacement (a small DP). Geometric corners may be skipped
 * (more peaks than apices); an apex left unmatched returns -1. Absorbs the
 * non-linear drawing distortion because it matches by *order*, not absolute distance.
 */
function monotonicMatch(tele: number[], geom: number[]): number[] {
  const T = tele.length;
  const G = geom.length;
  const SKIP = 1; // penalty for leaving an apex unmatched
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
      dp[t][g] = best;
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
 * Telemetry calibrates the model: the real km/h range (for the speed readout) and
 * the speed→gear relationship. Corner *positions* come from the geometry.
 */
export function telemetrySpeedRange(telemetry: TelemetryPoint[]): [number, number] {
  const kmhs = telemetry.map((t) => t.kmh);
  return [Math.min(...kmhs), Math.max(...kmhs)];
}

/**
 * Gear boundaries (8 ascending relSpeed upper edges) from the telemetry (speed,
 * gear) pairs. The km/h are mapped onto [vMin,vMax] (slowest corner → vMin, top
 * speed → vMax), the same range the speed profile uses, so a sample's speed maps
 * to the gear that telemetry uses at that speed. The edge between gear g and g+1
 * sits midway between the fastest point still in gear ≤g and the slowest in gear
 * >g; a gear never seen (e.g. 1st at Monza) gets a −∞ edge.
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
