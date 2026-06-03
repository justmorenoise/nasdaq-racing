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

/** Even-odd ray cast: is (x,y) inside the closed polyline? */
function pointInPoly(loop: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
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
    // Tire barriers sit above the grass/gravel but BELOW the asphalt, so any tire
    // that would stray onto the track is hidden by the road drawn over it.
    this.container.addChild(this.tireWalls());
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
      // The real track is the ring between the outer loop and its inner island(s).
      // Fill the outer loop fully, then restore each infield with grass — a closed
      // ring with no start/finish seam (which an open left+right band would leave).
      // Some circuits (e.g. Monaco) enclose several separate inner islands.
      const loops = [...this.track.edgeLoops].sort(
        (a, b) => Math.abs(polyArea(b)) - Math.abs(polyArea(a)),
      );
      const [outer, ...inner] = loops;
      const grass = pattern("grass", grassTexture(), CONFIG.scenery.grassTile);
      const seam = { width: 3, color: 0x10141c, alpha: 0.9, join: "round" } as const;
      const g = new Graphics();
      g.poly(flat(outer)).fill(fill);
      for (const hole of inner) g.poly(flat(hole)).fill(grass);
      // Crisp dark seam on every boundary.
      g.poly(flat(outer)).stroke(seam);
      for (const hole of inner) g.poly(flat(hole)).stroke(seam);
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

  /** The largest edge loop (outer track boundary), or null without real edges. */
  private outerLoop(): Pt[] | null {
    const loops = this.track.edgeLoops;
    if (!loops || loops.length === 0) return null;
    return loops.reduce((a, b) => (Math.abs(polyArea(a)) >= Math.abs(polyArea(b)) ? a : b));
  }

  /** Sample indices along a run spaced ~`spacing` world units apart. */
  private spacedAlong(indices: number[], spacing: number): number[] {
    const s = this.track.samples;
    const picks: number[] = [];
    let acc = Infinity;
    for (let j = 0; j < indices.length; j++) {
      if (j > 0) {
        acc += Math.hypot(
          s[indices[j]].x - s[indices[j - 1]].x,
          s[indices[j]].y - s[indices[j - 1]].y,
        );
      }
      if (acc >= spacing) {
        picks.push(indices[j]);
        acc = 0;
      }
    }
    return picks;
  }

  /**
   * Tire barriers lining corner run-offs: a packed row of tires placed just
   * outside the real edge. Positions that fall inside the outer track boundary
   * are dropped (so a barrier never gets drawn on the asphalt), which also breaks
   * the wall into shorter groups; groups of fewer than 5 tires are skipped so no
   * lone tire is ever drawn. Rendered under the asphalt as a final safety net.
   */
  private tireWalls(): Graphics {
    const g = new Graphics();
    const sc = CONFIG.scenery;
    const r = sc.tireRadius;
    const outer = this.outerLoop();
    for (const run of this.layout.runs) {
      const outSign = -run.turnSign; // outside of the corner
      let group: Pt[] = [];
      const flush = () => {
        if (group.length >= 5) {
          group.forEach((c, k) => {
            g.circle(c.x, c.y, r).fill(k % 4 === 0 ? 0xcf2b2b : 0x14171f);
            g.circle(c.x, c.y, r * 0.45).fill(0x2a2f3a);
          });
        }
        group = [];
      };
      for (const i of this.spacedAlong(run.indices, sc.tireSpacing)) {
        const c = this.bandPt(i, outSign, sc.tireGap);
        if (outer && pointInPoly(outer, c.x, c.y)) {
          flush(); // stray onto the track → break the group here
          continue;
        }
        group.push(c);
      }
      flush();
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

  /**
   * Alternating red/white kerb cells straddling the track edge on one side.
   * Cells are re-sampled at a fixed length *along the kerb itself* (not per
   * centerline sample), so red and white come out evenly regardless of how the
   * edge stretches/compresses through the corner.
   */
  private kerbStrip(g: Graphics, indices: number[], side: number): void {
    if (indices.length < 2) return;
    const ks = this.track.def.kerbScale ?? 1;
    const w = CONFIG.scenery.kerbWidth * ks;
    const cell = CONFIG.scenery.kerbCellLen * ks;
    const inner = indices.map((i) => this.bandPt(i, side, -w * 0.3)); // toward track
    const outer = indices.map((i) => this.bandPt(i, side, w * 0.7)); // toward run-off
    const mid = indices.map((i) => this.bandPt(i, side, w * 0.2)); // length reference

    const cum = [0];
    for (let k = 1; k < mid.length; k++) {
      cum[k] = cum[k - 1] + Math.hypot(mid[k].x - mid[k - 1].x, mid[k].y - mid[k - 1].y);
    }
    const total = cum[cum.length - 1];
    if (total < 1e-3) return;

    // Inner/outer rail point at a given arc length along the kerb.
    const at = (arc: number) => {
      let k = 1;
      while (k < cum.length - 1 && cum[k] < arc) k++;
      const t = (arc - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
      const lerp = (p: Pt, q: Pt) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      return { inner: lerp(inner[k - 1], inner[k]), outer: lerp(outer[k - 1], outer[k]) };
    };

    let pos = 0;
    let idx = 0;
    while (pos < total - 1e-3) {
      const a = at(pos);
      const b = at(Math.min(pos + cell, total));
      const color = idx % 2 === 0 ? 0xd21f1f : 0xf2f2f2;
      g.poly([
        a.inner.x, a.inner.y,
        b.inner.x, b.inner.y,
        b.outer.x, b.outer.y,
        a.outer.x, a.outer.y,
      ]).fill(color);
      pos += cell;
      idx++;
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
