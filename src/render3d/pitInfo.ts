import { CONFIG } from "../config";
import { UNITS_PER_METRE, type Track, type TrackSample } from "../track/Track";

/** Circuit centre, for "which side is outside" decisions. */
export function trackCentre(track: Track): { cx: number; cy: number } {
  const b = track.bounds;
  return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2 };
}

/** +1 if the +normal at this sample points away from the circuit interior. */
export function outwardSign(track: Track, s: TrackSample): number {
  const { cx, cy } = trackCentre(track);
  return (s.x - cx) * s.nx + (s.y - cy) * s.ny >= 0 ? 1 : -1;
}

/** Sample indices within ±`halfLen` arc length of a centre distance, in travel order. */
export function windowAround(track: Track, centerDist: number, halfLen: number): number[] {
  const s = track.samples;
  const n = s.length - 1;
  const L = track.length;
  let mid = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(track.wrap(s[i].dist - centerDist + L / 2) - L / 2);
    if (d < bestD) {
      bestD = d;
      mid = i;
    }
  }
  const out: number[] = [mid];
  let back = 0;
  for (let k = 1; k < n; k++) {
    const i = (mid - k + n) % n;
    const j = (i + 1) % n;
    back += Math.hypot(s[j].x - s[i].x, s[j].y - s[i].y);
    if (back > halfLen) break;
    out.unshift(i);
  }
  let fwd = 0;
  for (let k = 1; k < n; k++) {
    const i = (mid + k) % n;
    const j = (i - 1 + n) % n;
    fwd += Math.hypot(s[i].x - s[j].x, s[i].y - s[j].y);
    if (fwd > halfLen) break;
    out.push(i);
  }
  return out;
}

export interface PitInfo {
  /** Track samples alongside the pit lane. */
  window: Set<number>;
  /** Side of the track the pits are on (+1 = +normal). */
  side: number;
  /** Real layouts: distance from the track's edge to the pit lane's centre, per window sample. */
  laneOffset?: Map<number, number>;
}

/**
 * The pit straight: alongside the real pit lane when the layout has one (the
 * longest stretch where the lane runs parallel beside the track), else a
 * window around the start line on the inside.
 */
export function pitInfo(track: Track): PitInfo {
  const real = track.def.pitLane && track.def.pitLane.length > 4 ? realPit(track, track.def.pitLane) : null;
  if (real) return real;
  const pw = windowAround(track, track.startDist, CONFIG.scenery.pitLaneLen / 2);
  const side = pw.length >= 3 ? -outwardSign(track, track.samples[pw[Math.floor(pw.length / 2)]]) : 0;
  return { window: new Set(pw), side };
}

function realPit(track: Track, lane: { x: number; y: number }[]): PitInfo | null {
  const s = track.samples;
  const n = s.length - 1;
  const U = UNITS_PER_METRE;
  const lat = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    let q = lane[0];
    for (const p of lane) {
      const d = (p.x - s[i].x) ** 2 + (p.y - s[i].y) ** 2;
      if (d < best) {
        best = d;
        q = p;
      }
    }
    const l = (q.x - s[i].x) * s[i].nx + (q.y - s[i].y) * s[i].ny;
    const along = Math.sqrt(Math.max(0, best - l * l));
    const hw = l >= 0 ? track.hw[0][i] : track.hw[1][i];
    // Beside the track (not where the lane merges), and abreast rather than ahead.
    lat[i] = Math.abs(l) > hw + 4 * U && Math.abs(l) < hw + 60 * U && along < 8 * U ? l : 0;
  }
  let best: number[] = [];
  let cur: number[] = [];
  for (let k = 0; k <= 2 * n; k++) {
    const i = k % n;
    if (lat[i] !== 0 && (!cur.length || Math.sign(lat[i]) === Math.sign(lat[cur[cur.length - 1]])) && cur.length < n) {
      cur.push(i);
    } else {
      if (cur.length > best.length) best = cur;
      cur = lat[i] !== 0 ? [i] : [];
    }
  }
  if (best.length < 6) return null;
  const side = Math.sign(lat[best[0]]);
  const laneOffset = new Map<number, number>();
  for (const i of best) laneOffset.set(i, Math.abs(lat[i]) - track.hw[side > 0 ? 0 : 1][i]);
  return { window: new Set(best), side, laneOffset };
}
