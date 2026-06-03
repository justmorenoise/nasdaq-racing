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

/** Resample a polyline into points evenly spaced `step` apart along its length. */
function resampleByDistance(line: Pt[], step: number): Pt[] {
  if (line.length < 2) return line.slice();
  const out: Pt[] = [line[0]];
  let acc = 0;
  for (let i = 1; i < line.length; i++) {
    let a = line[i - 1];
    const b = line[i];
    let seg = Math.hypot(b.x - a.x, b.y - a.y);
    while (acc + seg >= step) {
      const t = (step - acc) / seg;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(p);
      a = p;
      seg = Math.hypot(b.x - a.x, b.y - a.y);
      acc = 0;
    }
    acc += seg;
  }
  return out;
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

  /**
   * Tire barriers lining corner run-offs: a wall of touching tires along the
   * outer edge of the gravel trap, kept to the central (apex) portion of each
   * corner so the walls stay short and don't reach into a neighbouring corner.
   * The barrier line is resampled by tire diameter so tires sit side by side with
   * no gaps. Positions inside the outer track boundary, or too close to a barrier
   * already placed for another corner, are dropped — so walls never land on the
   * asphalt nor cross each other; groups shorter than 5 tires are skipped.
   */
  private tireWalls(): Graphics {
    const g = new Graphics();
    const sc = CONFIG.scenery;
    const r = sc.tireRadius;
    const outer = this.outerLoop();
    const minSep = r * 2 * 1.6; // keep different corners' walls from crossing

    // Pass 1: candidate tire centres per corner — the central span of each run,
    // offset to the run-off's outer edge, evenly packed, and already off the
    // asphalt. The barrier line is split where it jumps (an edge discontinuity)
    // so it never knots back on itself.
    const s = this.track.samples;
    const runPts: Pt[][] = this.layout.runs.map((run) => {
      const m = run.indices.length;
      const idx = run.indices.slice(Math.floor(m * 0.25), Math.ceil(m * 0.75));
      if (idx.length < 2) return [];
      const line = idx.map((i) => this.bandPt(i, -run.turnSign, sc.tireGap));
      const pts: Pt[] = [];
      let sub: Pt[] = [line[0]];
      const emit = () => {
        for (const c of resampleByDistance(sub, r * 2)) {
          if (!(outer && pointInPoly(outer, c.x, c.y))) pts.push(c);
        }
      };
      for (let k = 1; k < line.length; k++) {
        const jump = Math.hypot(line[k].x - line[k - 1].x, line[k].y - line[k - 1].y);
        const step = Math.hypot(s[idx[k]].x - s[idx[k - 1]].x, s[idx[k]].y - s[idx[k - 1]].y);
        if (jump > step * 3.5 + 1) {
          emit();
          sub = [];
        }
        sub.push(line[k]);
      }
      emit();
      return pts;
    });

    // Pass 2: where two corners' walls come together, drop tires from *both* so
    // they open a clean gap instead of tangling into a cross.
    const keep = runPts.map((pts) => pts.map(() => true));
    for (let a = 0; a < runPts.length; a++) {
      for (let b = a + 1; b < runPts.length; b++) {
        for (let i = 0; i < runPts[a].length; i++) {
          for (let j = 0; j < runPts[b].length; j++) {
            const p = runPts[a][i];
            const q = runPts[b][j];
            if (Math.hypot(p.x - q.x, p.y - q.y) < minSep) {
              keep[a][i] = false;
              keep[b][j] = false;
            }
          }
        }
      }
    }

    // Pass 3: draw the surviving tires in contiguous groups of at least 5.
    for (let a = 0; a < runPts.length; a++) {
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
      runPts[a].forEach((c, i) => (keep[a][i] ? group.push(c) : flush()));
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
    const s = this.track.samples;
    for (const straight of this.layout.straights) {
      const idx = straight.indices;
      if (idx.length < 2) continue;
      for (const side of [1, -1]) {
        // Lift the pen where the edge jumps so the line never darts across the road.
        let pen = false;
        for (let k = 0; k < idx.length; k++) {
          const p = this.bandPt(idx[k], side, -1.5);
          if (k > 0) {
            const jump = Math.hypot(p.x - this.bandPt(idx[k - 1], side, -1.5).x, p.y - this.bandPt(idx[k - 1], side, -1.5).y);
            const step = Math.hypot(s[idx[k]].x - s[idx[k - 1]].x, s[idx[k]].y - s[idx[k - 1]].y);
            if (jump > step * 3.5 + 1) pen = false;
          }
          if (pen) g.lineTo(p.x, p.y);
          else g.moveTo(p.x, p.y);
          pen = true;
        }
      }
    }
    g.stroke({ width: 1.4, color: 0xffffff, alpha: 0.32 });
    return g;
  }

  private kerbs(): Graphics {
    const g = new Graphics();
    for (const run of this.layout.runs) {
      // Inside kerb runs the full arc of the corner (so hairpins are fully lined);
      // the outside kerb marks the exit only. Split each strip at self-overlap
      // stations so a kerb is never drawn across the other pass at a crossover
      // (e.g. Suzuka's figure-8).
      const inside = run.indices;
      const outside = run.indices.slice(run.apexEnd);
      for (const seg of this.splitAtCrossings(inside)) this.kerbStrip(g, seg, run.turnSign);
      for (const seg of this.splitAtCrossings(outside)) this.kerbStrip(g, seg, -run.turnSign);
    }
    return g;
  }

  /** Break an index list into runs that exclude self-overlap (crossover) stations. */
  private splitAtCrossings(indices: number[]): number[][] {
    const ns = this.track.nearSelf;
    const out: number[][] = [];
    let cur: number[] = [];
    for (const i of indices) {
      if (ns[i]) {
        if (cur.length) out.push(cur);
        cur = [];
      } else {
        cur.push(i);
      }
    }
    if (cur.length) out.push(cur);
    return out;
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
    const s = this.track.samples;
    // Split where the kerb rail jumps far beyond the centerline step (an edge
    // discontinuity from a ray that grazed a far boundary), so no single cell is
    // ever stretched across the track.
    const rail = indices.map((i) => this.bandPt(i, side, w * 0.2));
    let seg: number[] = [indices[0]];
    for (let k = 1; k < indices.length; k++) {
      const jump = Math.hypot(rail[k].x - rail[k - 1].x, rail[k].y - rail[k - 1].y);
      const step = Math.hypot(
        s[indices[k]].x - s[indices[k - 1]].x,
        s[indices[k]].y - s[indices[k - 1]].y,
      );
      if (jump > step * 3.5 + 1) {
        this.drawKerbCells(g, seg, side, w, cell);
        seg = [];
      }
      seg.push(indices[k]);
    }
    this.drawKerbCells(g, seg, side, w, cell);
  }

  /** Lay alternating red/white cells along one kerb segment (no discontinuities). */
  private drawKerbCells(g: Graphics, indices: number[], side: number, w: number, cell: number): void {
    if (indices.length < 2) return;
    const inner = indices.map((i) => this.bandPt(i, side, -w * 0.3)); // toward track
    const outer = indices.map((i) => this.bandPt(i, side, w * 0.7)); // toward run-off
    const mid = indices.map((i) => this.bandPt(i, side, w * 0.2)); // length reference
    const probe = indices.map((i) => this.bandPt(i, side, w)); // just past the outer rail

    const cum = [0];
    for (let k = 1; k < mid.length; k++) {
      cum[k] = cum[k - 1] + Math.hypot(mid[k].x - mid[k - 1].x, mid[k].y - mid[k - 1].y);
    }
    const total = cum[cum.length - 1];
    if (total < 1e-3) return;

    // Inner/outer/probe rail point at a given arc length along the kerb.
    const at = (arc: number) => {
      let k = 1;
      while (k < cum.length - 1 && cum[k] < arc) k++;
      const t = (arc - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
      const lerp = (p: Pt, q: Pt) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      return {
        inner: lerp(inner[k - 1], inner[k]),
        outer: lerp(outer[k - 1], outer[k]),
        probe: lerp(probe[k - 1], probe[k]),
      };
    };

    let pos = 0;
    let idx = 0;
    while (pos < total - 1e-3) {
      const a = at(pos);
      const b = at(Math.min(pos + cell, total));
      // Skip a cell that sits on the asphalt (a kerb landing mid-track where the
      // edge wanders at fast esses): its outer probe should be off the road.
      const mx = (a.probe.x + b.probe.x) / 2;
      const my = (a.probe.y + b.probe.y) / 2;
      if (!this.onAsphalt(mx, my)) {
        const color = idx % 2 === 0 ? 0xd21f1f : 0xf2f2f2;
        g.poly([
          a.inner.x, a.inner.y,
          b.inner.x, b.inner.y,
          b.outer.x, b.outer.y,
          a.outer.x, a.outer.y,
        ]).fill(color);
      }
      pos += cell;
      idx++;
    }
  }

  /** True if (x,y) is on the asphalt ribbon — drops kerb cells that strayed there. */
  private onAsphalt(x: number, y: number): boolean {
    return this.track.onAsphalt(x, y);
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
