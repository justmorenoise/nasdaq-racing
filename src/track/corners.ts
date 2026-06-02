import { CONFIG } from "../config";
import type { Track, TrackSample } from "./Track";

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

  // Smoothed |signed curvature| → per-track normalized severity (sqrt to match
  // the speed profile's feel: even gentle corners register).
  const win = 2;
  const k = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let d = -win; d <= win; d++) {
      sum += Math.abs(s[(i + d + n) % n].signedCurvature);
    }
    k[i] = sum / (win * 2 + 1);
  }
  const kRef = percentile(k, sc.cornerPercentile) || 1e-6;
  const sev = k.map((v) => Math.min(1.5, Math.sqrt(v / kRef)));

  // Anchor the circular walk at a sample that is definitely not a corner so
  // runs never straddle the array wrap.
  let anchor = 0;
  while (anchor < n && sev[anchor] >= sc.cornerExit) anchor++;
  if (anchor >= n) anchor = 0; // (degenerate: whole loop is curved)

  // Hysteresis: enter a corner above `cornerEnter`, stay until below `cornerExit`.
  const isCorner = new Array<boolean>(n).fill(false);
  let inRun = false;
  for (let step = 0; step < n; step++) {
    const i = (anchor + step) % n;
    if (inRun) {
      if (sev[i] < sc.cornerExit) inRun = false;
    } else if (sev[i] > sc.cornerEnter) {
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
    if (segLen(gap) < sc.mergeGapFrac * L) {
      for (const i of gap) isCorner[i] = true;
    }
  }

  const runs: CornerRun[] = [];
  for (const indices of segments(isCorner, anchor, n, true)) {
    if (segLen(indices) < sc.minRunFrac * L) continue;
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
    if (segLen(indices) < sc.minStraightFrac * L) continue;
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
