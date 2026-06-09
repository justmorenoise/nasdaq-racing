/**
 * Per-circuit gearbox model. A car's gear comes from a circuit-specific *usage
 * distribution* (how much of the lap is spent in each gear), not a fixed ratio:
 * twisty high-downforce tracks (Monaco) sit in 2nd–4th, power tracks (Monza, Spa)
 * live in 7th–8th. The distribution (`distribuzione_marce` in circuits.json) sets
 * where the gear boundaries fall along the speed range, so the shifts match the
 * real character of each track — and 1st gear is essentially never used (only the
 * single slowest point) unless a circuit gives it real weight (e.g. Monaco's
 * hairpin).
 */

/** Fallback gear-usage (% of lap by distance, gears 1..8) for tracks without one. */
export const DEFAULT_GEAR_DISTRIBUTION = [0, 6, 11, 14, 15, 16, 19, 19];

/**
 * Gear→speed boundaries from a usage distribution. The boundary between gear g
 * and g+1 is the arc-length-weighted speed *quantile* matching the cumulative
 * distribution, so "38% in 8th" puts the 8th-gear band over the fastest 38% of
 * the lap. Returns 8 ascending UPPER edges in relSpeed (last = vMax); a gear with
 * 0% collapses to a zero-width band.
 */
export function computeGearBounds(
  relSpeeds: number[],
  segLen: number[],
  total: number,
  distribution: number[],
  vMax: number,
): number[] {
  const n = distribution.length;
  const distTotal = distribution.reduce((a, b) => a + b, 0) || 1;
  const cum: number[] = [];
  let c = 0;
  for (let g = 0; g < n; g++) {
    c += distribution[g] / distTotal;
    cum.push(c);
  }

  // Speeds sorted ascending, carrying their arc-length weight.
  const pairs = relSpeeds
    .map((v, i) => ({ v, w: segLen[i] }))
    .sort((a, b) => a.v - b.v);

  const bounds = new Array<number>(n).fill(vMax);
  let acc = 0;
  let g = 0;
  // Leading gears with no usage are disabled (edge below any real speed) so they
  // are never selected — e.g. 1st gear on power circuits like Monza/Spa, where
  // even the slowest point (the speed-profile floor) should be in 2nd, not 1st.
  while (g < n - 1 && cum[g] <= 1e-9) {
    bounds[g] = -Infinity;
    g++;
  }
  for (let i = 0; i < pairs.length && g < n - 1; i++) {
    acc += pairs[i].w / total;
    while (g < n - 1 && acc >= cum[g]) {
      bounds[g] = pairs[i].v;
      g++;
    }
  }
  bounds[n - 1] = vMax;
  return bounds;
}

/** Instantaneous gear (1..8) for a relSpeed given the circuit's boundaries. */
export function gearAtSpeed(relSpeed: number, bounds: number[]): number {
  for (let g = 0; g < bounds.length; g++) {
    if (relSpeed <= bounds[g] + 1e-9) return g + 1;
  }
  return bounds.length;
}
