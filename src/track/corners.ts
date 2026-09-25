import { CONFIG } from "../config";
import { UNITS_PER_METRE, type Track, type TrackSample } from "./Track";

/**
 * A contiguous run of corner samples, in travel order. Index values refer to
 * `track.samples`. The run is split into entry / apex / exit by `apexStart`..
 * `apexEnd` (local positions into `indices`): kerbs hug the inside through the
 * entry and apex, then switch to the outside through the exit.
 */
export interface CornerRun {
  /** Sample indices in travel order (contiguous on the closed loop). */
  indices: number[];
  /** Local positions (into `indices`) bounding the apex window. */
  apexStart: number;
  apexEnd: number;
  /** +1 if the corner bends left (inside is on the +normal side), -1 if right. */
  turnSign: number;
  /** Normalized peak severity (≈1 at the track's tightest corners). */
  peakSeverity: number;
}

/** A contiguous run of low-curvature samples (a straight), in travel order. */
export interface Straight {
  indices: number[];
}

export interface TrackLayout {
  runs: CornerRun[];
  straights: Straight[];
}

/**
 * Segment a track into corner runs and straights from its curvature, deriving
 * everything the scenery needs (kerb sides, run-off, tire walls, stands). All
 * thresholds are normalized per track so they generalize across circuits.
 */
export function computeLayout(track: Track): TrackLayout {
  const sc = CONFIG.scenery;
  const s = track.samples;
  const n = s.length - 1; // last sample duplicates the first
  const L = track.length;

  // Real layouts are in metres (× UNITS_PER_METRE): thresholds become physical
  // (turn radius, run lengths), and the curvature is averaged over ~±12 m so the
  // vertices of the mapped polyline don't read as corners on a straight.
  const real = !!track.def.realGeometry;
  const spacing = L / n;
  const win = real ? Math.max(2, Math.round((12 * UNITS_PER_METRE) / spacing)) : 2;
  const k = new Array<number>(n);
  const ks = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let d = -win; d <= win; d++) {
      sum += s[(i + d + n) % n].signedCurvature;
    }
    ks[i] = sum / (win * 2 + 1);
    k[i] = Math.abs(ks[i]);
  }
  const kRef = percentile(k, sc.cornerPercentile) || 1e-6;
  // Severity (sqrt, to match the speed profile's feel: even gentle corners
  // register). Real: 1 at a 60 m radius, entering a corner under ~420 m.
  const kUnit = real ? 1 / (60 * UNITS_PER_METRE) : kRef;
  const sev = k.map((v) => Math.min(1.5, Math.sqrt(v / kUnit)));
  const enter = real ? Math.sqrt(60 / 420) : sc.cornerEnter;
  const exit = real ? Math.sqrt(60 / 650) : sc.cornerExit;
  const M = real ? UNITS_PER_METRE : 0;
  const minRun = real ? 22 * M : sc.minRunFrac * L;
  const mergeGap = real ? 35 * M : sc.mergeGapFrac * L;
  const minStraight = real ? 220 * M : sc.minStraightFrac * L;

  // Anchor the circular walk at a sample that is definitely not a corner so
  // runs never straddle the array wrap.
  let anchor = 0;
  while (anchor < n && sev[anchor] >= exit) anchor++;
  if (anchor >= n) anchor = 0; // (degenerate: whole loop is curved)

  // Hysteresis: enter a corner above `cornerEnter`, stay until below `cornerExit`.
  const isCorner = new Array<boolean>(n).fill(false);
  let inRun = false;
  for (let step = 0; step < n; step++) {
    const i = (anchor + step) % n;
    if (inRun) {
      if (sev[i] < exit) inRun = false;
    } else if (sev[i] > enter) {
      inRun = true;
    }
    isCorner[i] = inRun;
  }

  // Bridge short straights between corners (e.g. chicanes read as one complex).
  const segLen = (idx: number[]) => {
    let len = 0;
    for (let j = 1; j < idx.length; j++) {
      len += Math.hypot(
        s[idx[j]].x - s[idx[j - 1]].x,
        s[idx[j]].y - s[idx[j - 1]].y,
      );
    }
    return len;
  };
  for (const gap of segments(isCorner, anchor, n, false)) {
    if (segLen(gap) < mergeGap) {
      for (const i of gap) isCorner[i] = true;
    }
  }

  // A chicane is one complex but two bends: split where the turn changes side,
  // so each part gets its own inside kerb.
  const pieces: number[][] = [];
  for (const indices of segments(isCorner, anchor, n, true)) {
    if (!real) {
      pieces.push(indices);
      continue;
    }
    let cur: number[] = [];
    let sign = 0;
    for (const i of indices) {
      const sg = Math.abs(ks[i]) > kUnit * enter * enter * 0.5 ? Math.sign(ks[i]) : sign;
      if (sign && sg !== sign && segLen(cur) >= minRun * 0.6) {
        pieces.push(cur);
        cur = [];
      }
      sign = sg || sign;
      cur.push(i);
    }
    pieces.push(cur);
  }

  const runs: CornerRun[] = [];
  for (const indices of pieces) {
    if (segLen(indices) < minRun) continue;
    let peakLocal = 0;
    let signSum = 0;
    for (let j = 0; j < indices.length; j++) {
      if (sev[indices[j]] > sev[indices[peakLocal]]) peakLocal = j;
      signSum += s[indices[j]].signedCurvature;
    }
    const half = Math.floor((sc.apexFrac * indices.length) / 2);
    runs.push({
      indices,
      apexStart: Math.max(0, peakLocal - half),
      apexEnd: Math.min(indices.length - 1, peakLocal + half),
      turnSign: signSum >= 0 ? 1 : -1,
      peakSeverity: sev[indices[peakLocal]],
    });
  }

  const straights: Straight[] = [];
  for (const indices of segments(isCorner, anchor, n, false)) {
    if (segLen(indices) < minStraight) continue;
    straights.push({ indices });
  }

  return { runs, straights };
}

/**
 * Extract maximal runs of samples whose `flag` matches `want`, walking the
 * closed loop from `anchor` so runs are contiguous in travel order.
 */
function segments(
  flag: boolean[],
  anchor: number,
  n: number,
  want: boolean,
): number[][] {
  const out: number[][] = [];
  let cur: number[] | null = null;
  for (let step = 0; step < n; step++) {
    const i = (anchor + step) % n;
    if (flag[i] === want) {
      if (!cur) cur = [];
      cur.push(i);
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A lateral offset (signed: + = left of travel) clamped so it never reaches
 * past the local turn radius on the concave side. Offsetting an edge toward the
 * inside of a tight corner by more than the radius makes the parallel curve
 * self-intersect (the visible "crossed edges" at hairpins); clamping to a
 * fraction of the radius keeps every derived edge a clean simple curve.
 */
export function clampOffset(s: TrackSample, signedOffset: number): number {
  const k = Math.abs(s.signedCurvature);
  if (k < 1e-6) return signedOffset;
  // Concave side = the side the track turns toward = sign(signedCurvature).
  if (Math.sign(signedOffset) === Math.sign(s.signedCurvature)) {
    const lim = 0.82 / k;
    if (Math.abs(signedOffset) > lim) return Math.sign(signedOffset) * lim;
  }
  return signedOffset;
}

/** Point on the track offset laterally by `signedOffset`, clamped (see above). */
export function offsetPoint(
  s: TrackSample,
  signedOffset: number,
): { x: number; y: number } {
  const o = clampOffset(s, signedOffset);
  return { x: s.x + s.nx * o, y: s.y + s.ny * o };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}
