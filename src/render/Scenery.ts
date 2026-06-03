import { Container, Graphics } from "pixi.js";
import { CONFIG } from "../config";
import type { Track, TrackSample } from "../track/Track";
import { offsetPoint, type TrackLayout } from "../track/corners";

/**
 * Static decorative surroundings, all derived from track geometry and built
 * once: grandstands with packed crowds along the straights, a pit lane and
 * paddock at the start/finish, and recovery cranes at the sharpest corners.
 * Lives in its own world-space container that sits between the racing surface
 * and the cars; everything is placed strictly outside the asphalt so nothing
 * overlaps the track or the cars. (Tire barriers live in TrackView, drawn under
 * the asphalt so they can never appear on the road.)
 */
export class Scenery {
  readonly container = new Container();
  private cx: number;
  private cy: number;

  constructor(
    private track: Track,
    private layout: TrackLayout,
  ) {
    const b = track.bounds;
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;

    this.container.addChild(this.grandstands());
    this.container.addChild(this.pitPaddock());
    this.container.addChild(this.cranes());
  }

  private get half(): number {
    return this.track.def.width / 2;
  }

  /** +1 if the +normal at this sample points away from the circuit interior. */
  private outwardSign(s: TrackSample): number {
    return (s.x - this.cx) * s.nx + (s.y - this.cy) * s.ny >= 0 ? 1 : -1;
  }

  /** Quad centered at (cx,cy) with along/across unit vectors and half extents. */
  private rect(
    g: Graphics,
    cx: number,
    cy: number,
    ax: number,
    ay: number,
    hl: number,
    bx: number,
    by: number,
    hd: number,
    fill: number,
  ): void {
    const lx = ax * hl;
    const ly = ay * hl;
    const dx = bx * hd;
    const dy = by * hd;
    g.poly([
      cx - lx - dx,
      cy - ly - dy,
      cx + lx - dx,
      cy + ly - dy,
      cx + lx + dx,
      cy + ly + dy,
      cx - lx + dx,
      cy - ly + dy,
    ]).fill(fill);
  }

  /** Sample indices along a run spaced ~`spacing` apart, leaving end margins. */
  private spaced(indices: number[], spacing: number, margin: number): number[] {
    const s = this.track.samples;
    const picks: number[] = [];
    let traveled = 0;
    let sinceLast = Infinity;
    for (let j = 0; j < indices.length; j++) {
      if (j > 0) {
        const a = s[indices[j - 1]];
        const b = s[indices[j]];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        traveled += d;
        sinceLast += d;
      }
      const remaining = this.runLength(indices) - traveled;
      if (traveled >= margin && remaining >= margin && sinceLast >= spacing) {
        picks.push(indices[j]);
        sinceLast = 0;
      }
    }
    return picks;
  }

  private runLength(indices: number[]): number {
    const s = this.track.samples;
    let len = 0;
    for (let j = 1; j < indices.length; j++) {
      len += Math.hypot(
        s[indices[j]].x - s[indices[j - 1]].x,
        s[indices[j]].y - s[indices[j - 1]].y,
      );
    }
    return len;
  }

  private static CROWD = [
    0xe6e6e6, 0xff5a5f, 0xffd23f, 0x4f9dff, 0x5ad19a, 0xff8c42, 0xc779ff, 0xff4d6d,
  ];

  private grandstands(): Graphics {
    const g = new Graphics();
    const sc = CONFIG.scenery;
    const s = this.track.samples;
    const seatDepth = sc.standDepth * 0.62;
    const roofDepth = sc.standDepth * 0.18;
    for (const straight of this.layout.straights) {
      if (this.runLength(straight.indices) < sc.standMinStraightFrac * this.track.length) {
        continue;
      }
      for (const i of this.spaced(straight.indices, sc.standSegLen, sc.standSegLen * 0.5)) {
        const p = s[i];
        const out = this.outwardSign(p);
        const ax = Math.cos(p.tangent);
        const ay = Math.sin(p.tangent);
        const nx = p.nx * out;
        const ny = p.ny * out;
        const front = this.half + sc.standGap;
        // Slight per-stand size variation for variety.
        const halfLen = sc.standSegLen * (0.4 + Math.random() * 0.08);
        // Tarmac apron + front barrier, the seating bank, then a thin back roof.
        this.rect(g, p.x + nx * (front - 5), p.y + ny * (front - 5), ax, ay, halfLen + 5, nx, ny, 5, 0x2b2f38);
        const seatC = front + seatDepth / 2;
        this.rect(g, p.x + nx * seatC, p.y + ny * seatC, ax, ay, halfLen, nx, ny, seatDepth / 2, 0x171b25);
        this.scatterCrowd(g, p.x + nx * front, p.y + ny * front, ax, ay, halfLen, nx, ny, seatDepth);
        const roofC = front + seatDepth + roofDepth / 2;
        this.rect(g, p.x + nx * roofC, p.y + ny * roofC, ax, ay, halfLen + 3, nx, ny, roofDepth / 2, 0x39414f);
      }
    }
    return g;
  }

  /** Fill a seating bank with rows of vivid spectator dots (no texture stretch). */
  private scatterCrowd(
    g: Graphics,
    fx: number,
    fy: number,
    ax: number,
    ay: number,
    halfLen: number,
    nx: number,
    ny: number,
    depth: number,
  ): void {
    const step = 3.4;
    for (let v = step; v < depth; v += step) {
      for (let u = -halfLen + step; u < halfLen; u += step) {
        const ju = u + (Math.random() - 0.5) * 1.6;
        const jv = v + (Math.random() - 0.5) * 1.6;
        const x = fx + ax * ju + nx * jv;
        const y = fy + ay * ju + ny * jv;
        g.circle(x, y, 1.05).fill(
          Scenery.CROWD[(Math.random() * Scenery.CROWD.length) | 0],
        );
      }
    }
  }


  private cranes(): Graphics {
    const g = new Graphics();
    const sc = CONFIG.scenery;
    const s = this.track.samples;
    const sharpest = [...this.layout.runs]
      .sort((a, b) => b.peakSeverity - a.peakSeverity)
      .slice(0, sc.craneCount);
    for (const run of sharpest) {
      const apex = run.indices[Math.round((run.apexStart + run.apexEnd) / 2)];
      const p = s[apex];
      const out = -run.turnSign; // outside of the corner
      const nx = p.nx * out;
      const ny = p.ny * out;
      const ax = Math.cos(p.tangent);
      const ay = Math.sin(p.tangent);
      const baseC = this.half + sc.craneGap;
      const bx = p.x + nx * baseC;
      const by = p.y + ny * baseC;
      // Base pad + cab, then a jib reaching back toward the track with a hook.
      this.rect(g, bx, by, ax, ay, 11, nx, ny, 11, 0x394150);
      this.rect(g, bx, by, ax, ay, 7, nx, ny, 7, 0xf4b41a); // yellow cab
      const armLen = sc.craneGap * 0.9;
      const armC = baseC - armLen / 2; // reaches inward (toward track)
      this.rect(g, p.x + nx * armC, p.y + ny * armC, nx, ny, armLen / 2, ax, ay, 2.5, 0xf4b41a);
      const hookC = baseC - armLen;
      g.circle(p.x + nx * hookC, p.y + ny * hookC, 3).fill(0x20242e);
    }
    return g;
  }

  /**
   * A point `d` world units outside the track edge on `side` (+1 = +normal/left,
   * -1 = -normal/right) at centerline sample `i`. Rides the real edge when the
   * track has one (so the complex sits outside the actual asphalt, not a nominal
   * half-width); otherwise offsets the centerline by half + d.
   */
  private edgeOffset(i: number, side: number, d: number): { x: number; y: number } {
    const s = this.track.samples[i];
    const edge = this.track.edgeLeft;
    if (edge) {
      const e = side >= 0 ? edge[i] : this.track.edgeRight![i];
      const dx = e.x - s.x;
      const dy = e.y - s.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: e.x + (dx / len) * d, y: e.y + (dy / len) * d };
    }
    return offsetPoint(s, side * (this.half + d));
  }

  /**
   * Pit lane, pit wall, garages (with a glass canopy) and a shallow paddock, as
   * thin bands following the inside of the start/finish straight. All depths are
   * measured from the real track edge and capped to the infield clearance (the
   * distance to the next edge inward), so the complex stays by the finish line
   * and never reaches across a narrow infield onto another part of the track.
   */
  private pitPaddock(): Graphics {
    const g = new Graphics();
    const sc = CONFIG.scenery;
    const s = this.track.samples;
    // Samples within ±pitLaneLen/2 of the start line, in travel order.
    const win = this.windowAround(this.track.startDist, sc.pitLaneLen / 2);
    if (win.length < 3) return g;
    const mid = s[win[Math.floor(win.length / 2)]];
    const inSign = -this.outwardSign(mid); // pit complex sits on the inside

    // Available depth: nearest infield edge crossing across the window, with a
    // margin so the complex never touches the far track.
    let clearance = Infinity;
    for (const i of win) {
      const inner = this.edgeOffset(i, inSign, 0);
      const d = this.track.edgeRayDistance(inner.x, inner.y, inSign * s[i].nx, inSign * s[i].ny);
      if (d < clearance) clearance = d;
    }
    const maxDepth = clearance === Infinity ? Infinity : Math.max(0, clearance - 8);

    // Depths from the edge, back (paddock) to front (pit lane).
    const laneInner = sc.pitLaneGap;
    const laneOuter = laneInner + sc.pitLaneWidth;
    const garInner = laneOuter + 3;
    const garOuter = garInner + sc.garageDepth;
    const padInner = garOuter + 3;
    const padOuter = padInner + sc.paddockDepth;

    // Too tight for even a pit lane → skip the complex entirely.
    if (laneOuter > maxDepth) return g;

    // Paddock slab (back), only the part that fits.
    if (padInner < maxDepth) {
      g.poly(this.bandPoly(win, inSign, padInner, Math.min(padOuter, maxDepth))).fill(0x232834);
    }

    // Garage building + door dividers + glass canopy, clamped to the clearance.
    if (garInner < maxDepth) {
      const gOut = Math.min(garOuter, maxDepth);
      g.poly(this.bandPoly(win, inSign, garInner, gOut)).fill(0x2d323d);
      for (let k = 0; k < win.length; k += 3) {
        const a = this.edgeOffset(win[k], inSign, garInner);
        const b = this.edgeOffset(win[k], inSign, gOut);
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
      }
      g.stroke({ width: 1, color: 0x161a21, alpha: 0.7 });
      const canopy = Math.min(garInner + sc.garageDepth * 0.5, maxDepth);
      g.poly(this.bandPoly(win, inSign, garInner, canopy)).fill({ color: 0x9fc4e6, alpha: 0.22 });
    }

    // Pit lane (paler asphalt) + the white pit wall line at the track side.
    g.poly(this.bandPoly(win, inSign, laneInner, laneOuter)).fill(0x474c57);
    this.edge(g, win, inSign, laneInner, 0xe8e8e8, 1.6);
    return g;
  }

  /** Sample indices within ±`halfLen` arc length of a center distance. */
  private windowAround(centerDist: number, halfLen: number): number[] {
    const s = this.track.samples;
    const n = s.length - 1;
    const L = this.track.length;
    // Nearest index to centerDist.
    let mid = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(this.track.wrap(s[i].dist - centerDist + L / 2) - L / 2);
      if (d < bestD) {
        bestD = d;
        mid = i;
      }
    }
    const out: number[] = [mid];
    let back = 0;
    for (let k = 1; k < n; k++) {
      const i = (mid - k + n) % n;
      const j = (i + 1) % n;
      back += Math.hypot(s[j].x - s[i].x, s[j].y - s[i].y);
      if (back > halfLen) break;
      out.unshift(i);
    }
    let fwd = 0;
    for (let k = 1; k < n; k++) {
      const i = (mid + k) % n;
      const j = (i - 1 + n) % n;
      fwd += Math.hypot(s[i].x - s[j].x, s[i].y - s[j].y);
      if (fwd > halfLen) break;
      out.push(i);
    }
    return out;
  }

  /** Ribbon polygon between two depths outside the edge, following the samples. */
  private bandPoly(indices: number[], side: number, inner: number, outer: number): number[] {
    const a: number[] = [];
    const b: number[] = [];
    for (const i of indices) {
      const pi = this.edgeOffset(i, side, inner);
      const po = this.edgeOffset(i, side, outer);
      a.push(pi.x, pi.y);
      b.push(po.x, po.y);
    }
    const poly = a.slice();
    for (let k = b.length - 2; k >= 0; k -= 2) poly.push(b[k], b[k + 1]);
    return poly;
  }

  private edge(
    g: Graphics,
    indices: number[],
    side: number,
    off: number,
    color: number,
    width: number,
  ): void {
    indices.forEach((i, k) => {
      const p = this.edgeOffset(i, side, off);
      if (k === 0) g.moveTo(p.x, p.y);
      else g.lineTo(p.x, p.y);
    });
    g.stroke({ width, color });
  }
}
