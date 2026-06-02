import type { StockDef } from "../data/nasdaq100";

/**
 * State for one stock-as-car. `progress` is cumulative distance over the whole
 * race (the ranking metric); position on track = progress mod track length.
 * `speedScalar` eases toward its target so pace changes feel elastic, while the
 * track's relative speed profile still drives the slow-in-corners shape.
 */
export class Car {
  readonly symbol: string;
  readonly name: string;
  readonly color: number;

  changePct = 0; // latest reported daily change
  price = 0;

  progress = 0; // cumulative world distance
  speedScalar = 0; // eased global pace multiplier
  targetSpeedScalar = 0; // pace implied by current changePct
  worldSpeed = 0; // instantaneous speed (for camera zoom / FX)

  lane = 0; // current lateral offset fraction [-1, 1]
  targetLane = 0;
  /** Whether speedScalar has been seeded (avoids ramping from 0 on first tick). */
  seeded = false;
  /** Transient glow [0,1] that spikes on a sharp upward move and decays. */
  boost = 0;

  constructor(def: StockDef) {
    this.symbol = def.symbol;
    this.name = def.name;
    this.color = def.color;
    this.basePrice = def.basePrice;
    this.price = def.basePrice;
  }

  readonly basePrice: number;
}
