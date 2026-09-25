import { CONFIG } from "../config";
import type { PriceUpdate } from "../feed/PriceFeed";
import { getStockDef } from "../data/nasdaq100";
import type { Track, TrackPose } from "../track/Track";
import { Car } from "./Car";
import { lateralOf, updateLanes } from "./overtake";

export interface CarPose extends TrackPose {
  car: Car;
}

/** Two cars touching this frame, with a normalized [0,1] impact intensity. */
export interface Contact {
  a: Car;
  b: Car;
  intensity: number;
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
  /** Car-to-car contacts detected this frame (drives the sparks effect). */
  contacts: Contact[] = [];
  /** Previous frame's on-track rank per symbol, to count overtakes. */
  private prevRank = new Map<string, number>();

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
      const rise = u.changePct - car.changePct;
      // Feed the momentum signal with the signed move; it decays in update().
      car.momentum += rise;
      car.changePct = u.changePct;
      car.price = u.price;
    }
  }

  /** True once at least one real price has arrived from the feed. */
  get hasData(): boolean {
    for (const c of this.cars.values()) if (Math.abs(c.changePct) > 1e-6) return true;
    return false;
  }

  /**
   * Final classification for a session that ended before this page raced it
   * (opened after the close): park the field in standings order and credit each
   * car the laps of a full session, minus its standings gap to the leader.
   */
  settleFinal(sessionSeconds: number): void {
    this.update(0);
    const L = this.track.length;
    const leaderDist = (sessionSeconds / this.track.def.baseLapTime) * L;
    const anchor = Math.max(...[...this.cars.values()].map((c) => c.targetProgress));
    for (const car of this.cars.values()) {
      if (car.distance > 0) continue;
      car.distance = Math.max(0, leaderDist - (anchor - car.targetProgress));
    }
  }

  private clampPct(p: number): number {
    return Math.max(
      -CONFIG.changePctClamp,
      Math.min(CONFIG.changePctClamp, p),
    );
  }

  update(dt: number): void {
    const L = this.track.length;
    const { baseGapCars, gapPerPctFrac, gain, minMul, maxMul } = CONFIG.pace;

    // 1. Standings (best % first) → cumulative target gap behind the leader.
    //    Adjacent spacing grows with the adjacent % difference, so a tight %
    //    cluster shows as cars nose-to-tail (a battle).
    const standings = [...this.cars.values()].sort(
      (a, b) => this.clampPct(b.changePct) - this.clampPct(a.changePct),
    );
    // Don't lock initial placement until real data has arrived, so cars start
    // already in standings order (avoids an arbitrary 0%-ordered grid sorting out).
    const hasData = this.hasData;
    // Accrue "laps led" for the standings leader (P1), once real data is in.
    if (hasData && standings.length) standings[0].timeInP1 += dt;
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
        cum += this.track.carLength * baseGapCars + L * gapPerPctFrac * dPct;
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
      // Momentum is a ~20s decaying memory of recent net % movement.
      car.momentum *= Math.exp(-dt / 20);
    }

    this.recomputeOrder();
    updateLanes(this.order, this.track, dt);
    this.separate();
    this.recomputeOrder();
    this.countOvertakes();
    this.detectContacts();
  }

  /**
   * Keep cars from overlapping, using their real footprints (oriented boxes
   * on the line each is driving). Close pairs anywhere on the lap (lapped cars
   * included) that intersect are eased apart sideways within the track edges;
   * when there's no room left for that, the car behind yields and tucks in
   * behind instead of driving through the one ahead.
   */
  private separate(): void {
    const t = this.track;
    const L = t.length;
    const hl = (t.carLength * 1.04) / 2;
    const hw = (t.carWidth * 1.08) / 2;
    const cars = [...this.cars.values()].filter((c) => c.seeded);
    const pos = (c: Car) => t.wrap(c.progress);
    cars.sort((a, b) => pos(b) - pos(a));
    const n = cars.length;
    const overlap = (a: Car, b: Car): boolean => {
      const pa = this.poseForCar(a);
      const pb = this.poseForCar(b);
      const axes = [pa.tangent, pa.tangent + Math.PI / 2, pb.tangent, pb.tangent + Math.PI / 2];
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      for (const ang of axes) {
        const ax = Math.cos(ang);
        const ay = Math.sin(ang);
        const proj = (tan: number) => hl * Math.abs(Math.cos(tan - ang)) + hw * Math.abs(Math.sin(tan - ang));
        if (Math.abs(dx * ax + dy * ay) > proj(pa.tangent) + proj(pb.tangent)) return false;
      }
      return true;
    };
    for (let i = 0; i < n; i++) {
      for (let k = 1; k <= 3 && k < n; k++) {
        const a = cars[i];
        const b = cars[(i + k) % n];
        const gap = ((pos(a) - pos(b)) % L + L) % L; // a ahead of b
        if (gap > t.carLength * 1.5) continue;
        for (let it = 0; it < 8 && overlap(a, b); it++) {
          const la = lateralOf(a, t);
          const lb = lateralOf(b, t);
          const dir = la !== lb ? Math.sign(la - lb) : b.passSide || 1;
          const [loA, hiA] = t.lateralLimits(a.progress);
          const [loB, hiB] = t.lateralLimits(b.progress);
          const na = Math.max(loA, Math.min(hiA, la + dir * 0.9));
          const nb = Math.max(loB, Math.min(hiB, lb - dir * 0.9));
          if (Math.abs(na - la) + Math.abs(nb - lb) < 0.3) {
            // Boxed in: the car behind lifts and drops back.
            b.progress -= 1.5;
            b.worldSpeed = Math.min(b.worldSpeed, a.worldSpeed);
          } else {
            a.latOff = na - t.racingAt(a.progress);
            b.latOff = nb - t.racingAt(b.progress);
          }
          a.latVel *= 0.7;
          b.latVel *= 0.7;
        }
      }
    }
  }

  /**
   * Find pairs of cars that are side-by-side on the same stretch (tiny along-track
   * gap *and* overlapping lanes) and rate the impact. Cars touching are adjacent
   * in `order`, so a single pass over neighbours covers it.
   */
  private detectContacts(): void {
    this.contacts = [];
    const s = CONFIG.sparks;
    const L = this.track.length;
    const maxLong = Math.min(L * s.contactLongFrac, this.track.carLength * 1.1);
    // Wheel-to-wheel: just touching after separation, not overlapping.
    const touch = this.track.carWidth * 1.22;
    for (let i = 0; i < this.order.length - 1; i++) {
      const a = this.order[i];
      const b = this.order[i + 1];
      if (!a.seeded || !b.seeded) continue;
      if (a.progress - b.progress > maxLong) continue;
      const lateral = Math.abs(lateralOf(a, this.track) - lateralOf(b, this.track));
      if (lateral > touch) continue;
      const latCloseness = 1 - Math.max(0, lateral - this.track.carWidth) / (touch - this.track.carWidth); // 1 = touching
      const speedFactor = Math.min(1, Math.abs(a.worldSpeed - b.worldSpeed) / this.track.unitsPerMetre / s.fullClosingSpeed);
      const intensity = Math.min(1, (0.35 + 0.65 * speedFactor) * latCloseness);
      if (intensity < s.minIntensity) continue;
      this.contacts.push({ a, b, intensity });
    }
  }

  private recomputeOrder(): void {
    this.order = [...this.cars.values()].sort((a, b) => b.progress - a.progress);
  }

  /**
   * Credit each car with the on-track positions it gained since last frame
   * (a position improvement = an overtake made). Cars only present in one of
   * the two frames are ignored, so add/remove doesn't pollute the count.
   */
  private countOvertakes(): void {
    const rank = new Map<string, number>();
    this.order.forEach((car, i) => {
      const prev = this.prevRank.get(car.symbol);
      if (prev !== undefined && i < prev) car.overtakes += prev - i;
      rank.set(car.symbol, i);
    });
    this.prevRank = rank;
  }

  /** Symbol with the strongest recent climb ("fastest lap"), or null if flat. */
  momentumLeaderSymbol(): string | null {
    let best: Car | null = null;
    for (const car of this.cars.values()) {
      if (car.momentum > 0.05 && (!best || car.momentum > best.momentum)) best = car;
    }
    return best?.symbol ?? null;
  }

  /** Driver of the Day: most overtakes, tie-broken by best % change. */
  driverOfTheDay(): Car | null {
    let best: Car | null = null;
    for (const car of this.cars.values()) {
      if (
        !best ||
        car.overtakes > best.overtakes ||
        (car.overtakes === best.overtakes && car.changePct > best.changePct)
      ) {
        best = car;
      }
    }
    return best && best.overtakes > 0 ? best : null;
  }

  /**
   * World pose for a car on its own line (racing line + its offset), heading
   * along the path it is actually driving: the curve of that line plus the
   * sideways drift of a line change, so the nose points where the car goes.
   */
  poseForCar(car: Car): CarPose {
    const t = this.track;
    const pose = t.poseAt(car.progress);
    const lat = (d: number) => {
      const [lo, hi] = t.lateralLimits(d);
      return Math.max(lo, Math.min(hi, t.racingAt(d) + car.latOff));
    };
    const off = lat(car.progress);
    const h = 6;
    const p0 = t.poseAt(car.progress - h);
    const p1 = t.poseAt(car.progress + h);
    const o0 = lat(car.progress - h);
    const o1 = lat(car.progress + h);
    let dx = p1.x + p1.nx * o1 - (p0.x + p0.nx * o0);
    let dy = p1.y + p1.ny * o1 - (p0.y + p0.ny * o0);
    const L = Math.hypot(dx, dy) || 1;
    // Sideways velocity from a line change, relative to the forward speed.
    const drift = car.latVel / Math.max(20, car.worldSpeed);
    dx = dx / L + pose.nx * drift;
    dy = dy / L + pose.ny * drift;
    return {
      car,
      x: pose.x + pose.nx * off,
      y: pose.y + pose.ny * off,
      tangent: Math.atan2(dy, dx),
      nx: pose.nx,
      ny: pose.ny,
      h: pose.h,
    };
  }
}
