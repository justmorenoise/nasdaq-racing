import type { TrackSample } from "./Track";
import type { Pt } from "./centerline";

/** Circular moving median + mean, to strip spikes from per-sample widths. */
export function smoothCircular(v: ArrayLike<number>, med: number, avg: number): number[] {
  const n = v.length;
  const m = Array.from({ length: n }, (_, i) => {
    const w: number[] = [];
    for (let d = -med; d <= med; d++) w.push(v[(i + d + n) % n]);
    w.sort((a, b) => a - b);
    return w[w.length >> 1];
  });
  return m.map((_, i) => {
    let s = 0;
    for (let d = -avg; d <= avg; d++) s += m[(i + d + n) % n];
    return s / (avg * 2 + 1);
  });
}

/**
 * Per-sample half-widths of the drawn asphalt on each side (+normal / −normal),
 * from the real edges when the layout has them, clamped and de-spiked.
 */
export function halfWidths(
  samples: TrackSample[],
  half: number,
  edgeLeft: Pt[] | null,
  edgeRight: Pt[] | null,
): [Float32Array, Float32Array] {
  const n = samples.length - 1;
  const L: number[] = [];
  const R: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (edgeLeft && edgeRight) {
      L.push(Math.hypot(edgeLeft[i].x - s.x, edgeLeft[i].y - s.y));
      R.push(Math.hypot(edgeRight[i].x - s.x, edgeRight[i].y - s.y));
    } else {
      L.push(half);
      R.push(half);
    }
  }
  const clamp = (v: number) => Math.max(half * 0.55, Math.min(half * 1.6, v));
  return [Float32Array.from(smoothCircular(L.map(clamp), 6, 3)), Float32Array.from(smoothCircular(R.map(clamp), 6, 3))];
}

/**
 * The racing line as a lateral offset (world units along the +normal): the
 * minimum-curvature path through the corridor between the edges (less
 * `margin`). That is what a driver approximates — wide on entry, clipping the
 * apex, wide on exit, and through a chicane an almost straight cut from one
 * kerb to the other rather than a zig-zag.
 *
 * Minimising Σ|P(i−1) − 2P(i) + P(i+1)|² with P(i) = C(i) + n(i)·o(i) is a
 * banded quadratic problem; projected Gauss–Seidel solves it, one offset at a
 * time (each moves to the point its neighbours' bending stencil asks for, then
 * is clamped to the corridor). Plain Gauss–Seidel damps long wavelengths far
 * too slowly, so it runs coarse-to-fine: on every 8th sample, then 4th, 2nd
 * and all, each level starting from the previous one's solution.
 */
export function racingLine(samples: TrackSample[], hw: [Float32Array, Float32Array], margin: number): Float32Array {
  const n = samples.length - 1;
  const off = new Float32Array(n);
  const hi = new Float32Array(n);
  const lo = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    hi[i] = Math.max(0, hw[0][i] - margin);
    lo[i] = -Math.max(0, hw[1][i] - margin);
  }
  for (const stride of [8, 4, 2, 1]) {
    const idx: number[] = [];
    for (let i = 0; i < n; i += stride) idx.push(i);
    const m = idx.length;
    if (m < 8) continue;
    const px = new Float64Array(m);
    const py = new Float64Array(m);
    const place = (k: number) => {
      const s = samples[idx[k]];
      px[k] = s.x + s.nx * off[idx[k]];
      py[k] = s.y + s.ny * off[idx[k]];
    };
    for (let k = 0; k < m; k++) place(k);
    const iters = stride === 1 ? 600 : 1500;
    for (let it = 0; it < iters; it++) {
      let moved = 0;
      for (let k = 0; k < m; k++) {
        const a = (k - 2 + m) % m, b = (k - 1 + m) % m, c = (k + 1) % m, d = (k + 2) % m;
        const tx = (-px[a] + 4 * px[b] + 4 * px[c] - px[d]) / 6;
        const ty = (-py[a] + 4 * py[b] + 4 * py[c] - py[d]) / 6;
        const i = idx[k];
        const s = samples[i];
        const want = off[i] + ((tx - px[k]) * s.nx + (ty - py[k]) * s.ny) * 1.0;
        const next = Math.max(lo[i], Math.min(hi[i], want));
        moved = Math.max(moved, Math.abs(next - off[i]));
        off[i] = next;
        place(k);
      }
      if (moved < 0.001) break;
    }
    // Carry the solution to the in-between samples for the next, finer level.
    if (stride > 1) {
      for (let k = 0; k < m; k++) {
        const i0 = idx[k];
        const i1 = idx[(k + 1) % m];
        const span = (i1 - i0 + n) % n || n;
        for (let t = 1; t < span; t++) {
          const i = (i0 + t) % n;
          const v = off[i0] + ((off[i1] - off[i0]) * t) / span;
          off[i] = Math.max(lo[i], Math.min(hi[i], v));
        }
      }
    }
  }
  return off;
}
