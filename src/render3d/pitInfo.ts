import { CONFIG } from "../config";
import type { Track, TrackSample } from "../track/Track";

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

/** The pit straight window around the start line and the (inside) side the pits sit on. */
export function pitInfo(track: Track): { window: Set<number>; side: number } {
  const pw = windowAround(track, track.startDist, CONFIG.scenery.pitLaneLen / 2);
  const side = pw.length >= 3 ? -outwardSign(track, track.samples[pw[Math.floor(pw.length / 2)]]) : 0;
  return { window: new Set(pw), side };
}
