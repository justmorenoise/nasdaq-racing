import type { StockDef } from "../data/nasdaq100";

/**
 * State for one stock-as-car. `progress` is cumulative distance along the track;
 * a position controller steers it toward `targetProgress` (a slot determined by
 * the standings) while the track's relative speed profile keeps cars braking in
 * corners. Position on track = progress mod track length.
 */
export class Car {
  readonly symbol: string;
  readonly name: string;
  readonly color: number;
  readonly color2?: number;

  changePct = 0; // latest reported daily change
  price = 0;

  progress = 0; // cumulative world distance
  distance = 0; // odometer: distance actually travelled (for the lap count)
  targetProgress = 0; // standings-driven target slot (set each frame)
  worldSpeed = 0; // instantaneous speed (for FX / overtake logic)
  relSpeed = 0; // local profile speed in [vMin, vMax] (for camera zoom)

  lane = 0; // current lateral offset fraction [-1, 1]
  targetLane = 0;
  /** Whether the car has been placed into its initial slot. */
  seeded = false;

  // --- Session stats (drive the momentum/DOTD badges and, later, betting) ---
  /** Seconds spent as the standings leader (P1) this session — "laps led". */
  timeInP1 = 0;
  /** On-track positions gained over the session — "overtakes made". */
  overtakes = 0;
  /** Decaying net % movement over the recent window — who's climbing *now*
   *  (the "fastest lap" holder), as opposed to the cumulative % leader. */
  momentum = 0;

  constructor(def: StockDef) {
    this.symbol = def.symbol;
    this.name = def.name;
    this.color = def.color;
    this.color2 = def.color2;
    this.basePrice = def.basePrice;
    this.price = def.basePrice;
  }

  readonly basePrice: number;
}
