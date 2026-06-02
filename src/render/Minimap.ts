import { Container, Graphics } from "pixi.js";
import type { RaceModel } from "../sim/RaceModel";
import type { Track } from "../track/Track";

const W = 190;
const H = 120;
const PAD = 12;

/**
 * Screen-space minimap: static track outline plus live car dots. Lives on the
 * stage (not the world), so it ignores camera transforms. Useful in chase mode
 * to keep context of where everyone is on the circuit.
 */
export class Minimap {
  readonly container = new Container();
  private dots = new Graphics();
  private scale: number;
  private offX: number;
  private offY: number;

  constructor(
    track: Track,
    private model: RaceModel,
  ) {
    const b = track.bounds;
    const tw = b.maxX - b.minX;
    const th = b.maxY - b.minY;
    this.scale = Math.min((W - PAD * 2) / tw, (H - PAD * 2) / th);
    this.offX = PAD + (W - PAD * 2 - tw * this.scale) / 2 - b.minX * this.scale;
    this.offY = PAD + (H - PAD * 2 - th * this.scale) / 2 - b.minY * this.scale;

    const bg = new Graphics();
    bg.roundRect(0, 0, W, H, 10).fill({ color: 0x0c1118, alpha: 0.85 });
    bg.roundRect(0, 0, W, H, 10).stroke({ color: 0xffffff, alpha: 0.08, width: 1 });
    this.container.addChild(bg);

    const outline = new Graphics();
    const s = track.samples;
    outline.moveTo(this.mx(s[0].x), this.my(s[0].y));
    for (let i = 1; i < s.length; i++) outline.lineTo(this.mx(s[i].x), this.my(s[i].y));
    outline.closePath();
    outline.stroke({ width: 3, color: 0x4a5160 });
    this.container.addChild(outline);

    this.container.addChild(this.dots);
  }

  private mx(x: number) {
    return x * this.scale + this.offX;
  }
  private my(y: number) {
    return y * this.scale + this.offY;
  }

  /** @param followed currently chased symbol, drawn larger/white-ringed. */
  update(followed: string | null): void {
    const g = this.dots;
    g.clear();
    for (const car of this.model.cars.values()) {
      const pose = this.model.poseForCar(car);
      const px = this.mx(pose.x);
      const py = this.my(pose.y);
      const r = car.symbol === followed ? 4 : 2.6;
      g.circle(px, py, r).fill(car.color);
      if (car.symbol === followed) {
        g.circle(px, py, r + 1.5).stroke({ width: 1.5, color: 0xffffff });
      }
    }
  }

  /** Place in the top-right corner given the screen size. */
  layout(screenW: number): void {
    this.container.position.set(screenW - W - 16, 16);
  }
}
