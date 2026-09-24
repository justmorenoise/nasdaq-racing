import type { RaceModel } from "../sim/RaceModel";
import type { Track } from "../track/Track";

const W = 190;
const H = 120;
const PAD = 12;

/**
 * Screen-space minimap (DOM canvas, top-right): static track outline plus live
 * car dots, so chase/TV shots keep the context of where everyone is.
 */
export class Minimap {
  readonly el = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private outline: Path2D;
  private scale: number;
  private offX: number;
  private offY: number;
  private dpr = Math.min(window.devicePixelRatio || 1, 2);

  constructor(
    track: Track,
    private model: RaceModel,
  ) {
    this.el.className = "minimap";
    this.el.width = W * this.dpr;
    this.el.height = H * this.dpr;
    this.el.style.width = `${W}px`;
    this.el.style.height = `${H}px`;
    this.ctx = this.el.getContext("2d")!;

    const b = track.bounds;
    const tw = b.maxX - b.minX;
    const th = b.maxY - b.minY;
    this.scale = Math.min((W - PAD * 2) / tw, (H - PAD * 2) / th);
    this.offX = PAD + (W - PAD * 2 - tw * this.scale) / 2 - b.minX * this.scale;
    this.offY = PAD + (H - PAD * 2 - th * this.scale) / 2 - b.minY * this.scale;

    this.outline = new Path2D();
    const s = track.samples;
    this.outline.moveTo(this.mx(s[0].x), this.my(s[0].y));
    for (let i = 1; i < s.length; i++) this.outline.lineTo(this.mx(s[i].x), this.my(s[i].y));
    this.outline.closePath();
  }

  private mx(x: number) {
    return x * this.scale + this.offX;
  }
  private my(y: number) {
    return y * this.scale + this.offY;
  }

  update(followed: string | null): void {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(12,17,24,0.85)";
    c.strokeStyle = "rgba(255,255,255,0.08)";
    c.beginPath();
    c.roundRect(0.5, 0.5, W - 1, H - 1, 10);
    c.fill();
    c.stroke();
    c.lineWidth = 3;
    c.lineJoin = "round";
    c.strokeStyle = "#4a5160";
    c.stroke(this.outline);
    for (const car of this.model.cars.values()) {
      const pose = this.model.poseForCar(car);
      const px = this.mx(pose.x);
      const py = this.my(pose.y);
      const me = car.symbol === followed;
      c.beginPath();
      c.arc(px, py, me ? 4 : 2.6, 0, Math.PI * 2);
      c.fillStyle = "#" + car.color.toString(16).padStart(6, "0");
      c.fill();
      if (me) {
        c.beginPath();
        c.arc(px, py, 5.5, 0, Math.PI * 2);
        c.lineWidth = 1.5;
        c.strokeStyle = "#fff";
        c.stroke();
      }
    }
  }

  /** Top-right corner; shrinks on narrow (mobile) screens. */
  layout(screenW: number): void {
    const s = screenW < 640 ? 0.62 : 1;
    const margin = screenW < 640 ? 10 : 16;
    this.el.style.width = `${W * s}px`;
    this.el.style.height = `${H * s}px`;
    this.el.style.top = `${margin}px`;
    this.el.style.right = `${margin}px`;
  }
}
