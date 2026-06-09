import { CONFIG } from "../config";
import { computeGearBounds, DEFAULT_GEAR_DISTRIBUTION } from "./gearbox";
import type { TrackSample } from "./Track";

/**
 * Derive a relative speed profile from track curvature so cars brake for corners
 * (harder for tight ones) and accelerate out onto straights toward a top speed —
 * without real telemetry, and independent of the track's coordinate scale.
 *
 * 1. Cornering severity = curvature relative to this track's own distribution
 *    (a high percentile maps to vMin), so the tightest corners are slowest and
 *    open corners only shed a little speed. Scale-invariant by construction.
 * 2. Forward pass: limit how fast speed can rise (acceleration).
 * 3. Backward pass: limit how fast speed must drop before a corner (braking).
 *    Both limits are expressed per lap-fraction, so the feel is scale-invariant.
 *
 * Returns per-sample relative speeds and the "raw" lap time (∫ ds/v) used to
 * scale a car to its target lap time elsewhere.
 */
export function computeSpeedProfile(
  samples: TrackSample[],
  gearDistribution?: number[],
): {
  relSpeeds: number[];
  rawLapTime: number;
  gearBounds: number[];
} {
  const { vMin, vMax, accel, brake, corneringPercentile, corneringExp, smoothing } =
    CONFIG.profile;
  const n = samples.length;

  // Segment lengths + total (for lap-fraction stepping).
  const segLen = new Array<number>(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    segLen[i] =
      Math.hypot(samples[j].x - samples[i].x, samples[j].y - samples[i].y) ||
      1e-6;
    total += segLen[i];
  }

  // Smooth curvature to tame finite-difference noise.
  const curv = smoothCurvature(samples, smoothing);

  // Reference curvature: a high percentile so a single spike doesn't set the
  // scale. Curvature at/above this maps to vMin.
  const kRef = percentile(curv, corneringPercentile) || 1e-6;

  // Base cornering speed from relative curvature severity. The exponent shapes
  // how quickly speed bleeds off with curvature: <1 brakes early even for gentle
  // bends, →1 keeps medium/fast corners near top speed (only the tightest slow).
  const v = curv.map((k) => {
    const severity = Math.min(1, Math.pow(k / kRef, corneringExp)); // 0 straight .. 1 tightest
    return vMax - (vMax - vMin) * severity;
  });

  // Accel/brake limiting in lap-fraction space, twice around the closed loop.
  for (let pass = 0; pass < 2; pass++) {
    for (let s = 0; s < n; s++) {
      const i = s % n;
      const prev = (i - 1 + n) % n;
      const dsFrac = segLen[prev] / total;
      v[i] = Math.min(v[i], Math.sqrt(v[prev] * v[prev] + 2 * accel * dsFrac));
    }
    for (let s = 0; s < n; s++) {
      const i = (n - 1 - (s % n) + n) % n;
      const next = (i + 1) % n;
      const dsFrac = segLen[i] / total;
      v[i] = Math.min(v[i], Math.sqrt(v[next] * v[next] + 2 * brake * dsFrac));
    }
  }

  // Integrate raw lap time: ∫ ds / v.
  let rawLapTime = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    rawLapTime += segLen[i] / Math.max(0.5 * (v[i] + v[j]), 1e-6);
  }

  // Gear shift points from this circuit's gear-usage distribution.
  const gearBounds = computeGearBounds(
    v,
    segLen,
    total,
    gearDistribution ?? DEFAULT_GEAR_DISTRIBUTION,
    vMax,
  );

  return { relSpeeds: v, rawLapTime, gearBounds };
}

function smoothCurvature(samples: TrackSample[], window: number): number[] {
  const n = samples.length;
  if (window <= 0) return samples.map((s) => s.curvature);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let d = -window; d <= window; d++) {
      sum += samples[(i + d + n) % n].curvature;
    }
    out[i] = sum / (window * 2 + 1);
  }
  return out;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}
