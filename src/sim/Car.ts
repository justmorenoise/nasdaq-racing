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
  targetProgress = 0; // standings-driven target slot (set each frame)
  worldSpeed = 0; // instantaneous speed (for FX / overtake logic)
  relSpeed = 0; // local profile speed in [vMin, vMax] (for camera zoom)

  lane = 0; // current lateral offset fraction [-1, 1]
  targetLane = 0;
  /** Whether the car has been placed into its initial slot. */
  seeded = false;
  /** Transient glow [0,1] that spikes on a sharp upward move and decays. */
  boost = 0;

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
