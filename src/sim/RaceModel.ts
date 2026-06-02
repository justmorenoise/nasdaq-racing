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
      const clamped = Math.max(
        -CONFIG.changePctClamp,
        Math.min(CONFIG.changePctClamp, u.changePct),
      );
      const lapTime = this.track.def.baseLapTime * (1 - clamped / 100);
      car.targetSpeedScalar = this.track.rawLapTime / lapTime;
      if (!car.seeded) {
        car.speedScalar = car.targetSpeedScalar;
        car.seeded = true;
      }
    }
  }

  update(dt: number): void {
    const easeSpeed = 1 - Math.exp(-CONFIG.speedEaseRate * dt);
    const easeLane = 1 - Math.exp(-CONFIG.laneEaseRate * dt);

    for (const car of this.cars.values()) {
      // Ease pace, then integrate distance with the local profile speed.
      car.speedScalar += (car.targetSpeedScalar - car.speedScalar) * easeSpeed;
      const rel = this.track.relSpeedAt(car.progress);
      car.worldSpeed = rel * car.speedScalar;
      car.progress += car.worldSpeed * dt;
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
