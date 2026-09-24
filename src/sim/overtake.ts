import { CONFIG } from "../config";
import type { Track } from "../track/Track";
import type { Car } from "./Car";

/** Forward on-track distance from car a to car b (a chasing b). */
function forwardGap(a: Car, b: Car, length: number): number {
  return (((b.progress - a.progress) % length) + length) % length;
}

/** Absolute lateral position of a car (world units along +normal). */
export function lateralOf(car: Car, track: Track): number {
  const [lo, hi] = track.lateralLimits(car.progress);
  return Math.max(lo, Math.min(hi, track.racingAt(car.progress) + car.latOff));
}

/**
 * Which side the next corner turns (+1 = toward +normal), weighted over the
 * stretch just ahead; 0 on a straight.
 */
function nextCornerSide(track: Track, from: number): number {
  let k = 0;
  for (let d = 40; d <= 320; d += 20) k += track.samples[indexAt(track, from + d)].signedCurvature;
  return Math.abs(k) < 0.002 ? 0 : Math.sign(k);
}

function indexAt(track: Track, dist: number): number {
  const s = track.samples;
  const d = track.wrap(dist);
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid].dist <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Lateral racecraft. Each car runs the racing line unless it is:
 *  - attacking: closing on the car ahead, it commits to a side — the inside of
 *    the next corner, or on a straight the side away from the defender — pulls
 *    alongside, and only rejoins the line once clear by a car length and a bit;
 *  - defending: with an attacker still behind, it edges toward that side to
 *    cover the move (never all the way, it has to make the corner).
 * Targets drive a critically damped spring on each car's offset, so every
 * move swings out and back in smoothly instead of sliding on rails.
 */
export function updateLanes(order: Car[], track: Track, dt: number): void {
  const L = track.length;
  const len = track.carLength;
  const sep = track.carWidth * 1.3;
  const window = len * 3.5;
  const byName = new Map(order.map((c) => [c.symbol, c]));

  for (const car of order) {
    let target = 0;
    const [lo, hi] = track.lateralLimits(car.progress);
    const racing = track.racingAt(car.progress);

    // Finish or drop a pass in progress.
    if (car.passing) {
      const other = byName.get(car.passing);
      const gap = other ? forwardGap(car, other, L) : Infinity;
      const done = !other || (gap > L / 2 && L - gap > len * 1.3) || (gap < L / 2 && gap > window * 1.5);
      if (done) car.passing = null;
    }

    // Start a pass on the car just ahead when catching it.
    if (!car.passing) {
      let ahead: Car | null = null;
      let best = window;
      for (const o of order) {
        if (o === car) continue;
        const g = forwardGap(car, o, L);
        if (g > 0 && g < best) {
          best = g;
          ahead = o;
        }
      }
      if (ahead && (car.worldSpeed > ahead.worldSpeed * 1.004 || car.targetProgress > ahead.targetProgress)) {
        const aLat = lateralOf(ahead, track);
        let side = nextCornerSide(track, car.progress) || (aLat > racing ? -1 : 1);
        const fits = (sd: number) => {
          const want = aLat + sd * sep;
          return want >= lo - 0.5 && want <= hi + 0.5;
        };
        if (!fits(side)) side = -side;
        if (fits(side)) {
          car.passing = ahead.symbol;
          car.passSide = side;
        }
      }
    }

    if (car.passing) {
      const other = byName.get(car.passing)!;
      target = lateralOf(other, track) + car.passSide * sep - racing;
    } else {
      for (const o of order) {
        if (o.passing !== car.symbol) continue;
        const g = forwardGap(o, car, L);
        if (g < L / 2 && g > len * 2.5) {
          // Attacker still a few lengths back: a light covering move.
          target = o.passSide * sep * 0.25;
        } else {
          // Attacker close or alongside: leave it a car's width of room — give
          // up the apex rather than squeeze it into the wall.
          const aLat = lateralOf(o, track);
          const clear = o.passSide > 0 ? Math.min(racing, aLat - sep) : Math.max(racing, aLat + sep);
          target = clear - racing;
        }
      }
    }
    car.latTarget = Math.max(lo - racing, Math.min(hi - racing, target));

    // Critically damped spring toward the target offset.
    const w = CONFIG.overtake.laneOmega;
    const acc = w * w * (car.latTarget - car.latOff) - 2 * w * car.latVel;
    car.latVel += acc * dt;
    car.latOff += car.latVel * dt;
  }
}
