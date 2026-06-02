import { Container, Graphics, Sprite } from "pixi.js";
import { CONFIG } from "../config";
import type { Track } from "../track/Track";
import type { Pt } from "../track/centerline";
import { offsetPoint, type TrackLayout } from "../track/corners";
import {
  asphaltTexture,
  grassTexture,
  grassVariationTexture,
  gravelTexture,
  pattern,
} from "./textures";

/** Flatten a polyline to the [x0,y0,x1,y1,…] form Graphics.poly expects. */
function flat(loop: Pt[]): number[] {
  const out: number[] = [];
  for (const p of loop) out.push(p.x, p.y);
  return out;
}

/** Shoelace area (sign = winding); only its magnitude is used here. */
function polyArea(loop: Pt[]): number {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const j = (i + 1) % loop.length;
    s += loop[i].x * loop[j].y - loop[j].x * loop[i].y;
  }
  return s / 2;
}

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
    // The dark seam is the asphalt's own stroke when we fill from real edges;
    // in the centerline-stroke fallback it's a separate wider ribbon underneath.
    if (!this.track.edgeLeft) this.container.addChild(this.outline());
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

  /**
   * A point on (d=0) or offset `d` outward from the track edge on `side`
   * (+1 = left/+normal, -1 = right/-normal) at centerline sample `i`.
   *
   * With real edges this rides the actual track boundary and offsets along the
   * local outward direction; without them it offsets the centerline by half the
   * fixed width plus `d`, clamped so tight corners don't self-intersect.
   */
  private bandPt(i: number, side: number, d: number): Pt {
    const s = this.track.samples[i];
    if (this.track.edgeLeft) {
      const e = side >= 0 ? this.track.edgeLeft[i] : this.track.edgeRight![i];
      const dx = e.x - s.x;
      const dy = e.y - s.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: e.x + (dx / len) * d, y: e.y + (dy / len) * d };
    }
    return offsetPoint(s, side * (this.half + d));
  }

  private grassBackground(): Container {
    const c = new Container();
    const b = this.track.bounds;
    const m = CONFIG.scenery.grassMargin;
    const x = b.minX - m;
    const y = b.minY - m;
    const w = b.maxX - b.minX + 2 * m;
    const h = b.maxY - b.minY + 2 * m;
    // Fine tiled blades …
    const base = new Graphics();
    base.rect(x, y, w, h).fill(pattern("grass", grassTexture(), CONFIG.scenery.grassTile));
    c.addChild(base);
    // … plus a single non-repeating tonal overlay stretched over the whole area.
    const variation = new Sprite(grassVariationTexture(w, h));
    variation.position.set(x, y);
    variation.width = w;
    variation.height = h;
    c.addChild(variation);
    return c;
  }

  /** Trace the closed centerline polyline onto a Graphics (no stroke/fill). */
  private appendCenterPath(g: Graphics): void {
    const s = this.track.samples;
    g.moveTo(s[0].x, s[0].y);
    for (let i = 1; i < this.n; i++) g.lineTo(s[i].x, s[i].y);
    g.closePath();
  }

  /**
   * Surfaces are drawn by *stroking the centerline* rather than filling a
   * parallel-offset polygon: a stroked polyline with round joins renders a clean
   * constant-width ribbon even through chicanes, with none of the self-
   * intersection creases that offset polygons produce in tight concave necks.
   */
  private ribbon(width: number, style: object): Graphics {
    const g = new Graphics();
    this.appendCenterPath(g);
    g.stroke({ width, cap: "round", join: "round", ...style });
    return g;
  }

  /** Dark seam just wider than the asphalt, peeking out as a crisp track edge. */
  private outline(): Graphics {
    return this.ribbon(this.track.def.width + 5, { color: 0x10141c, alpha: 0.95 });
  }

  /** Closed asphalt ribbon polygon from the real edges (left fwd, right back). */
  private edgeRibbonPoly(i0 = 0, i1 = this.n - 1): number[] {
    const L = this.track.edgeLeft!;
    const R = this.track.edgeRight!;
    const poly: number[] = [];
    for (let i = i0; i <= i1; i++) poly.push(L[i].x, L[i].y);
    for (let i = i1; i >= i0; i--) poly.push(R[i].x, R[i].y);
    return poly;
  }

  private asphalt(): Graphics {
    const fill = pattern("asphalt", asphaltTexture(), CONFIG.scenery.asphaltTile);
    if (this.track.edgeLoops) {
      // The real track is the ring between the two closed edge loops. Fill the
      // outer loop fully, then restore the infield with grass — a closed ring
      // with no start/finish seam (which an open left+right band would leave).
      const [a, b] = this.track.edgeLoops;
      const [outer, inner] = Math.abs(polyArea(a)) >= Math.abs(polyArea(b)) ? [a, b] : [b, a];
      const g = new Graphics();
      g.poly(flat(outer)).fill(fill);
      g.poly(flat(inner)).fill(pattern("grass", grassTexture(), CONFIG.scenery.grassTile));
      // Crisp dark seam on both boundaries.
      g.poly(flat(outer)).stroke({ width: 3, color: 0x10141c, alpha: 0.9, join: "round" });
      g.poly(flat(inner)).stroke({ width: 3, color: 0x10141c, alpha: 0.9, join: "round" });
      return g;
    }
    return this.ribbon(this.track.def.width, { fill });
  }

  /** A few darker, freshly-resurfaced asphalt stretches for variety. */
  private tarmacPatches(): Graphics {
    const g = new Graphics();
    const s = this.track.samples;
    for (const [a, b] of CONFIG.scenery.tarmacPatches) {
      const i0 = Math.max(0, Math.floor(a * this.n));
      const i1 = Math.min(this.n - 1, Math.floor(b * this.n));
      if (this.track.edgeLeft) {
        g.poly(this.edgeRibbonPoly(i0, i1)).fill({ color: 0x2b2e36, alpha: 0.5 });
      } else {
        g.moveTo(s[i0].x, s[i0].y);
        for (let i = i0 + 1; i <= i1; i++) g.lineTo(s[i].x, s[i].y);
        g.stroke({ width: this.track.def.width, color: 0x2b2e36, alpha: 0.5, cap: "butt", join: "round" });
      }
    }
    return g;
  }

  /** Gravel traps on the outside of each corner, tapered to nothing at the ends. */
  private runOff(): Graphics {
    const g = new Graphics();
    const w = CONFIG.scenery.runOffWidth;
    const gravel = pattern("gravel", gravelTexture(), CONFIG.scenery.gravelTile);
    for (const run of this.layout.runs) {
      const outSign = -run.turnSign; // outside of the corner
      const m = run.indices.length;
      const inner: number[] = [];
      const outer: number[] = [];
      for (let j = 0; j < m; j++) {
        const i = run.indices[j];
        const taper = Math.sin((Math.PI * j) / (m - 1 || 1)); // 0 at ends, 1 mid
        const inP = this.bandPt(i, outSign, 0);
        const outP = this.bandPt(i, outSign, w * taper);
        inner.push(inP.x, inP.y);
        outer.push(outP.x, outP.y);
      }
      const poly = inner.slice();
      for (let k = outer.length - 2; k >= 0; k -= 2) poly.push(outer[k], outer[k + 1]);
      g.poly(poly).fill(gravel);
    }
    return g;
  }

  /**
   * White track-limit lines, drawn only along the straights. Through corners
   * the kerbs already mark the edge, and on the centerline-offset fallback the
   * edge line is exactly what self-intersects in chicanes — so we omit corners.
   */
  private edgeLines(): Graphics {
    const g = new Graphics();
    for (const straight of this.layout.straights) {
      const idx = straight.indices;
      if (idx.length < 2) continue;
      for (const side of [1, -1]) {
        const p0 = this.bandPt(idx[0], side, -1.5);
        g.moveTo(p0.x, p0.y);
        for (let k = 1; k < idx.length; k++) {
          const p = this.bandPt(idx[k], side, -1.5);
          g.lineTo(p.x, p.y);
        }
      }
    }
    g.stroke({ width: 1.4, color: 0xffffff, alpha: 0.32 });
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

  /** Alternating red/white kerb cells straddling the track edge on one side. */
  private kerbStrip(g: Graphics, indices: number[], side: number): void {
    const s = this.track.samples;
    const w = CONFIG.scenery.kerbWidth;
    let acc = 0;
    for (let j = 0; j < indices.length - 1; j++) {
      const ia = indices[j];
      const ib = indices[j + 1];
      const color =
        Math.floor(acc / CONFIG.scenery.kerbCellLen) % 2 === 0 ? 0xd21f1f : 0xf2f2f2;
      const ai = this.bandPt(ia, side, -w * 0.3); // toward the track
      const bi = this.bandPt(ib, side, -w * 0.3);
      const bo = this.bandPt(ib, side, w * 0.7); // toward the run-off
      const ao = this.bandPt(ia, side, w * 0.7);
      g.poly([ai.x, ai.y, bi.x, bi.y, bo.x, bo.y, ao.x, ao.y]).fill(color);
      acc += Math.hypot(s[ib].x - s[ia].x, s[ib].y - s[ia].y);
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
