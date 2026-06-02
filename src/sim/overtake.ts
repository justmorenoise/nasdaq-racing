import { CONFIG } from "../config";
import type { Track } from "../track/Track";
import type { Car } from "./Car";

/** Stable per-symbol preferred passing side (+1 / -1). */
function preferredSide(symbol: string): number {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) | 0;
  return h % 2 === 0 ? 1 : -1;
}

/** Forward on-track distance from car a to car b (a chasing b). */
function forwardGap(a: Car, b: Car, length: number): number {
  const d = (b.progress - a.progress) % length;
  return (d + length) % length;
}

/**
 * Sets each car's `targetLane`. A car closing on the one physically ahead of it
 * on track pulls out to a passing lane; otherwise it eases back to the racing
 * line. Driven by on-track proximity (not race position), so the side-by-side
 * happens exactly where cars are actually near each other. Reversible: if the
 * pace flips, the gap reopens and everyone returns to line.
 */
export function updateLanes(order: Car[], track: Track): void {
  const length = track.length;
  const window = length * CONFIG.overtake.catchGapFrac;
  const laneMag = 2 * CONFIG.overtake.laneWidthFrac;

  for (const car of order) {
    // Find the nearest car ahead on track within the closing window.
    let ahead: Car | null = null;
    let bestGap = Infinity;
    for (const other of order) {
      if (other === car) continue;
      const gap = forwardGap(car, other, length);
      if (gap > 0 && gap < window && gap < bestGap) {
        bestGap = gap;
        ahead = other;
      }
    }

    if (ahead && car.worldSpeed > ahead.worldSpeed * 1.01) {
      let side = preferredSide(car.symbol);
      // Don't pull into the same side the car ahead occupies.
      if (Math.sign(ahead.targetLane) === side && Math.abs(ahead.targetLane) > 0.25) {
        side = -side;
      }
      car.targetLane = side * laneMag;
    } else {
      car.targetLane = 0; // racing line
    }
  }
}
