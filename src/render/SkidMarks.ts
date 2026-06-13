import { Container, Graphics, RenderTexture, Sprite } from "pixi.js";
import type { Renderer } from "pixi.js";
import type { Car } from "../sim/Car";
import type { Track } from "../track/Track";

/**
 * Persistent rubber laid down where cars brake hard. Marks accumulate into a
 * single world-space RenderTexture (drawn once per stamp with `clear:false`),
 * so memory is bounded by the texture size no matter how many marks build up —
 * overlapping stamps darken naturally into a rubbered-in corner. Lives in its
 * own layer between the scenery and the cars.
 */
const PAD = 60; // world padding around the track bounds
const TEX_RES = 1; // native res so the rubber stays crisp, not blocky
const SKID_REL_SPEED = 0.62; // lay marks below this profile speed (corner braking)
const STAMP_GAP = 8; // min world distance a car travels between stamps

export class SkidMarks {
  readonly container = new Container();
  private rt: RenderTexture;
  private stamp = new Graphics();
  private minX: number;
  private minY: number;
  private lastStamp = new Map<string, number>();
  /** Stable per-car ±1% wobble on the braking threshold, so cars don't all
   *  start laying rubber at the exact same point (they'd stack into one line). */
  private threshJitter = new Map<string, number>();

  constructor(
    track: Track,
    private renderer: Renderer,
  ) {
    const b = track.bounds;
    this.minX = b.minX - PAD;
    this.minY = b.minY - PAD;
    const w = b.maxX - b.minX + PAD * 2;
    const h = b.maxY - b.minY + PAD * 2;
    this.rt = RenderTexture.create({ width: w, height: h, resolution: TEX_RES });

    const sprite = new Sprite(this.rt);
    sprite.position.set(this.minX, this.minY);
    sprite.alpha = 0.2; // subtle: ~75% fainter than the old marks
    this.container.addChild(sprite);

    // Two short tyre streaks centred on the origin, pointing along +x (travel
    // direction); rotated to the car's heading at stamp time.
    const tyre = track.def.width * 0.22; // lateral spacing of the two lines
    const len = track.def.width * 0.5;
    const wdt = Math.max(1.4, track.def.width * 0.06);
    for (const off of [-tyre, tyre]) {
      this.stamp.roundRect(-len / 2, off - wdt / 2, len, wdt, wdt / 2);
    }
    this.stamp.fill({ color: 0x0d0f12, alpha: 0.5 });
  }

  /** Lay rubber for any seeded car braking hard through a corner. */
  update(cars: Iterable<Car>, poseOf: (c: Car) => { x: number; y: number; tangent: number }): void {
    for (const car of cars) {
      if (!car.seeded) continue;
      let j = this.threshJitter.get(car.symbol);
      if (j === undefined) {
        j = (Math.random() * 2 - 1) * 0.01; // ±1%, fixed for the session
        this.threshJitter.set(car.symbol, j);
      }
      if (car.relSpeed > SKID_REL_SPEED * (1 + j)) continue;
      const last = this.lastStamp.get(car.symbol) ?? -Infinity;
      if (car.distance - last < STAMP_GAP) continue;
      this.lastStamp.set(car.symbol, car.distance);

      const p = poseOf(car);
      this.stamp.position.set(p.x - this.minX, p.y - this.minY);
      this.stamp.rotation = p.tangent;
      this.renderer.render({ container: this.stamp, target: this.rt, clear: false });
    }
  }

  destroy(): void {
    this.rt.destroy(true);
    this.stamp.destroy();
    this.container.destroy({ children: true });
  }
}
