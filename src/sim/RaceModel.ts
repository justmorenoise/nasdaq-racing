import { CONFIG } from "../config";
import type { PriceUpdate } from "../feed/PriceFeed";
import { getStockDef } from "../data/nasdaq100";
import type { Track, TrackPose } from "../track/Track";
import { Car } from "./Car";
import { updateLanes } from "./overtake";

export interface CarPose extends TrackPose {
  car: Car;
}

/**
 * Owns the cars and advances the simulation. Speed comes from the track's
 * relative profile scaled by an eased per-car pace, so cars slow in corners and
 * the response to new data is smooth. Race order is by cumulative `progress`.
 */
export class RaceModel {
  readonly cars = new Map<string, Car>();
  /** Cars sorted best-first (most progress). */
  order: Car[] = [];

  constructor(
    private track: Track,
    symbols: string[],
  ) {
    this.setSymbols(symbols);
  }

  /** Add/remove cars to match the desired set, preserving existing state. */
  setSymbols(symbols: string[]): void {
    const wanted = new Set(symbols);
    for (const sym of [...this.cars.keys()]) {
      if (!wanted.has(sym)) this.cars.delete(sym);
    }
    symbols.forEach((sym, i) => {
      if (this.cars.has(sym)) return;
      const def = getStockDef(sym);
      if (!def) return;
      const car = new Car(def);
      // Stagger a starting grid just behind the start/finish line; alternate sides.
      const gridGap = this.track.def.width * 0.85;
      car.progress = this.track.startDist - i * gridGap;
      car.lane = car.targetLane = i % 2 === 0 ? -0.4 : 0.4;
      this.cars.set(sym, car);
    });
    this.recomputeOrder();
  }

  /**
   * Late-join seeding: place cars as if the race had already run for `fraction`
   * of a session of `sessionSeconds`, so someone joining mid-session sees a race
   * in progress rather than a standing start. Pace then diverges from live data.
   */
  seedFromFraction(fraction: number, sessionSeconds: number): void {
    if (fraction <= 0) return;
    const lapsApprox = (sessionSeconds * fraction) / this.track.def.baseLapTime;
    const baseDist = lapsApprox * this.track.length;
    let i = 0;
    for (const car of this.cars.values()) {
      // Spread the field with a small per-car offset around the seeded distance.
      car.progress = baseDist - i * this.track.def.width * 0.85;
      i++;
    }
    this.recomputeOrder();
  }

  applyUpdates(updates: PriceUpdate[]): void {
    for (const u of updates) {
      const car = this.cars.get(u.symbol);
      if (!car) continue;
      // A sharp upward move lights up the boost glow.
      const rise = u.changePct - car.changePct;
      if (rise > 0.12) car.boost = Math.min(1, car.boost + rise * 0.9);
      car.changePct = u.changePct;
      car.price = u.price;
    }
  }

  private clampPct(p: number): number {
    return Math.max(
      -CONFIG.changePctClamp,
      Math.min(CONFIG.changePctClamp, p),
    );
  }

  update(dt: number): void {
    const easeLane = 1 - Math.exp(-CONFIG.laneEaseRate * dt);
    const L = this.track.length;
    const { baseGapFrac, gapPerPctFrac, gain, minMul, maxMul } = CONFIG.pace;

    // 1. Standings (best % first) → cumulative target gap behind the leader.
    //    Adjacent spacing grows with the adjacent % difference, so a tight %
    //    cluster shows as cars nose-to-tail (a battle).
    const standings = [...this.cars.values()].sort(
      (a, b) => this.clampPct(b.changePct) - this.clampPct(a.changePct),
    );
    // Don't lock initial placement until real data has arrived, so cars start
    // already in standings order (avoids an arbitrary 0%-ordered grid sorting out).
    const hasData = standings.some((c) => Math.abs(c.changePct) > 1e-6);
    const anchor = standings.reduce((m, c) => Math.max(m, c.progress), -Infinity);
    let cum = 0;
    for (let i = 0; i < standings.length; i++) {
      if (i > 0) {
        // Base spacing per position (keeps the field readable) plus a bonus
        // proportional to the % gap (emphasises who is dominating).
        const dPct = Math.max(
          0,
          this.clampPct(standings[i - 1].changePct) -
            this.clampPct(standings[i].changePct),
        );
        cum += L * (baseGapFrac + gapPerPctFrac * dPct);
      }
      standings[i].targetProgress = anchor - cum;
    }

    // 2. Move each car: corner-aware base speed, nudged by a proportional
    //    controller toward its standings slot (animates overtakes smoothly).
    const basePaceScalar = this.track.rawLapTime / this.track.def.baseLapTime;
    for (const car of this.cars.values()) {
      if (!car.seeded) {
        car.progress = car.targetProgress; // place directly into standings slot
        if (hasData) car.seeded = true; // lock once real data is in
      }
      const posError = car.targetProgress - car.progress;
      const adjust = Math.max(
        minMul,
        Math.min(maxMul, 1 + (gain * posError) / L),
      );
      car.relSpeed = this.track.relSpeedAt(car.progress);
      car.worldSpeed = car.relSpeed * basePaceScalar * adjust;
      car.progress += car.worldSpeed * dt;
      car.distance += car.worldSpeed * dt; // monotonic odometer for lap count
    }

    this.recomputeOrder();
    updateLanes(this.order, this.track);

    for (const car of this.cars.values()) {
      car.lane += (car.targetLane - car.lane) * easeLane;
    }
  }

  private recomputeOrder(): void {
    this.order = [...this.cars.values()].sort((a, b) => b.progress - a.progress);
  }

  /** World pose for a car including its lateral lane offset. */
  poseForCar(car: Car): CarPose {
    const pose = this.track.poseAt(car.progress);
    const off = (car.lane * this.track.def.width) / 2;
    return {
      car,
      x: pose.x + pose.nx * off,
      y: pose.y + pose.ny * off,
      tangent: pose.tangent,
      nx: pose.nx,
      ny: pose.ny,
    };
  }
}
