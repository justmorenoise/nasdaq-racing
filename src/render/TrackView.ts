import { Container, Graphics } from "pixi.js";
import { CONFIG } from "../config";
import type { Track } from "../track/Track";
import { offsetPoint, type TrackLayout } from "../track/corners";
import {
  asphaltTexture,
  grassTexture,
  gravelTexture,
  pattern,
} from "./textures";

/**
 * Renders the racing surface: a textured grass background, gravel run-off at
 * corner outsides, a textured asphalt ribbon, red/white kerbs (inside through
 * the corner entry+apex, outside through the exit), white track-limit lines, a
 * dashed centerline and a checkered start/finish. All static, built once.
 */
export class TrackView {
  readonly container = new Container();

  constructor(
    private track: Track,
    private layout: TrackLayout,
  ) {
    this.container.addChild(this.grassBackground());
    this.container.addChild(this.runOff());
    this.container.addChild(this.asphalt());
    this.container.addChild(this.tarmacPatches());
    this.container.addChild(this.edgeLines());
    this.container.addChild(this.kerbs());
    this.container.addChild(this.centerLine());
    this.container.addChild(this.startFinish());
  }

  private get half(): number {
    return this.track.def.width / 2;
  }

  /** Number of unique loop samples (the last sample duplicates the first). */
  private get n(): number {
    return this.track.samples.length - 1;
  }

  private grassBackground(): Graphics {
    const g = new Graphics();
    const b = this.track.bounds;
    const m = CONFIG.scenery.grassMargin;
    g.rect(b.minX - m, b.minY - m, b.maxX - b.minX + 2 * m, b.maxY - b.minY + 2 * m).fill(
      pattern("grass", grassTexture(), CONFIG.scenery.grassTile),
    );
    return g;
  }

  /** Closed ribbon polygon (left edge forward, right edge back) at ±offset,
   *  with offsets clamped so tight corners don't self-intersect. */
  private ribbonPoly(offset: number): number[] {
    const s = this.track.samples;
    const poly: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const p = offsetPoint(s[i], offset);
      poly.push(p.x, p.y);
    }
    for (let i = this.n - 1; i >= 0; i--) {
      const p = offsetPoint(s[i], -offset);
      poly.push(p.x, p.y);
    }
    return poly;
  }

  private asphalt(): Graphics {
    const g = new Graphics();
    g.poly(this.ribbonPoly(this.half)).fill(
      pattern("asphalt", asphaltTexture(), CONFIG.scenery.asphaltTile),
    );
    // Crisp dark seam between asphalt and the surroundings.
    g.stroke({ width: 2, color: 0x10141c, alpha: 0.9 });
    return g;
  }

  /** A few darker, freshly-resurfaced asphalt stretches for variety. */
  private tarmacPatches(): Graphics {
    const g = new Graphics();
    const s = this.track.samples;
    for (const [a, b] of CONFIG.scenery.tarmacPatches) {
      const i0 = Math.max(0, Math.floor(a * this.n));
      const i1 = Math.min(this.n - 1, Math.floor(b * this.n));
      const poly: number[] = [];
      for (let i = i0; i <= i1; i++) {
        const p = offsetPoint(s[i], this.half - 0.5);
        poly.push(p.x, p.y);
      }
      for (let i = i1; i >= i0; i--) {
        const p = offsetPoint(s[i], -(this.half - 0.5));
        poly.push(p.x, p.y);
      }
      g.poly(poly).fill({ color: 0x2b2e36, alpha: 0.55 });
    }
    return g;
  }

  /** Gravel traps on the outside of each corner, tapered to nothing at the ends. */
  private runOff(): Graphics {
    const g = new Graphics();
    const s = this.track.samples;
    const w = CONFIG.scenery.runOffWidth;
    const gravel = pattern("gravel", gravelTexture(), CONFIG.scenery.gravelTile);
    for (const run of this.layout.runs) {
      const outSign = -run.turnSign; // outside of the corner
      const m = run.indices.length;
      const inner: number[] = [];
      const outer: number[] = [];
      for (let j = 0; j < m; j++) {
        const sample = s[run.indices[j]];
        const taper = Math.sin((Math.PI * j) / (m - 1 || 1)); // 0 at ends, 1 mid
        const inP = offsetPoint(sample, outSign * this.half);
        const outP = offsetPoint(sample, outSign * (this.half + w * taper));
        inner.push(inP.x, inP.y);
        outer.push(outP.x, outP.y);
      }
      const poly = inner.slice();
      for (let k = outer.length - 2; k >= 0; k -= 2) poly.push(outer[k], outer[k + 1]);
      g.poly(poly).fill(gravel);
    }
    return g;
  }

  /** White track-limit lines just inside each asphalt edge. */
  private edgeLines(): Graphics {
    const g = new Graphics();
    const off = this.half - 1.5;
    const s = this.track.samples;
    for (const side of [1, -1]) {
      const p0 = offsetPoint(s[0], side * off);
      g.moveTo(p0.x, p0.y);
      for (let i = 1; i < this.n; i++) {
        const p = offsetPoint(s[i], side * off);
        g.lineTo(p.x, p.y);
      }
      g.closePath();
    }
    g.stroke({ width: 1.4, color: 0xffffff, alpha: 0.35 });
    return g;
  }

  private kerbs(): Graphics {
    const g = new Graphics();
    for (const run of this.layout.runs) {
      // Inside through entry + apex, then outside through the exit.
      const inside = run.indices.slice(0, run.apexEnd + 1);
      const outside = run.indices.slice(run.apexEnd);
      this.kerbStrip(g, inside, run.turnSign);
      this.kerbStrip(g, outside, -run.turnSign);
    }
    return g;
  }

  /** Alternating red/white kerb cells straddling the asphalt edge on one side. */
  private kerbStrip(g: Graphics, indices: number[], side: number): void {
    const s = this.track.samples;
    const w = CONFIG.scenery.kerbWidth;
    const inOff = side * (this.half - w * 0.3);
    const outOff = side * (this.half + w * 0.7);
    let acc = 0;
    for (let j = 0; j < indices.length - 1; j++) {
      const a = s[indices[j]];
      const b = s[indices[j + 1]];
      const color =
        Math.floor(acc / CONFIG.scenery.kerbCellLen) % 2 === 0 ? 0xd21f1f : 0xf2f2f2;
      const ai = offsetPoint(a, inOff);
      const bi = offsetPoint(b, inOff);
      const bo = offsetPoint(b, outOff);
      const ao = offsetPoint(a, outOff);
      g.poly([ai.x, ai.y, bi.x, bi.y, bo.x, bo.y, ao.x, ao.y]).fill(color);
      acc += Math.hypot(b.x - a.x, b.y - a.y);
    }
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
    g.stroke({ width: 1.5, color: 0xffffff, alpha: 0.2 });
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
