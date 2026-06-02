import { Container, Graphics } from "pixi.js";
import type { Track } from "../track/Track";

/**
 * Renders a track as a layered ribbon: grass border, asphalt, dashed
 * centerline, and a checkered start/finish line. Drawn once at construction.
 */
export class TrackView {
  readonly container = new Container();

  constructor(private track: Track) {
    const w = track.def.width;

    this.container.addChild(this.ribbon(w + 14, 0x10161f)); // outer edge / run-off
    this.container.addChild(this.ribbon(w + 6, 0x2a2f3a)); // kerb base
    this.container.addChild(this.ribbon(w, 0x3b3f49)); // asphalt
    this.container.addChild(this.centerLine());
    this.container.addChild(this.startFinish());
  }

  private appendCenterPath(g: Graphics) {
    const s = this.track.samples;
    g.moveTo(s[0].x, s[0].y);
    for (let i = 1; i < s.length; i++) g.lineTo(s[i].x, s[i].y);
    g.closePath();
  }

  private ribbon(width: number, color: number): Graphics {
    const g = new Graphics();
    this.appendCenterPath(g);
    g.stroke({ width, color, cap: "round", join: "round" });
    return g;
  }

  private centerLine(): Graphics {
    const g = new Graphics();
    const s = this.track.samples;
    // Dashed line: draw every other short segment.
    const step = 6;
    for (let i = 0; i < s.length - 1; i += step * 2) {
      g.moveTo(s[i].x, s[i].y);
      const end = Math.min(i + step, s.length - 1);
      for (let j = i + 1; j <= end; j++) g.lineTo(s[j].x, s[j].y);
    }
    g.stroke({ width: 1.5, color: 0xffffff, alpha: 0.25 });
    return g;
  }

  private startFinish(): Graphics {
    const g = new Graphics();
    const pose = this.track.poseAt(this.track.startDist);
    const half = this.track.def.width / 2;
    const cols = 8;
    const cell = (half * 2) / cols;
    const ax = Math.cos(pose.tangent); // along-track unit
    const ay = Math.sin(pose.tangent);
    // Checkered band: two rows of cells oriented across the track.
    for (let row = 0; row < 2; row++) {
      for (let c = 0; c < cols; c++) {
        if ((row + c) % 2 === 0) continue;
        const acrossT = -half + c * cell + cell / 2;
        const alongT = (row === 0 ? -1 : 1) * (cell / 2);
        const cx = pose.x + pose.nx * acrossT + ax * alongT;
        const cy = pose.y + pose.ny * acrossT + ay * alongT;
        const hx = (ax * cell) / 2;
        const hy = (ay * cell) / 2;
        const wx = (pose.nx * cell) / 2;
        const wy = (pose.ny * cell) / 2;
        g.poly([
          cx - hx - wx,
          cy - hy - wy,
          cx + hx - wx,
          cy + hy - wy,
          cx + hx + wx,
          cy + hy + wy,
          cx - hx + wx,
          cy - hy + wy,
        ]).fill(0xffffff);
      }
    }
    return g;
  }
}
