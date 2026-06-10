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
  /** Recovery cranes — kept in a separate layer so they render *above* the
   *  cars and skid marks (their jibs overhang the track, as in real life). */
  readonly cranesLayer = new Container();
  /** Arc-length positions of the placed grandstands, for crowd-cheer audio. */
  readonly grandstandDists: number[] = [];
  private cx: number;
  private cy: number;
  /** Sample indices occupied by the pit complex, and the side it sits on, so
   *  grandstands can steer clear of the paddock. */
  private pitWindow: Set<number> = new Set();
  private pitSide = 0;

  constructor(
    private track: Track,
    private layout: TrackLayout,
  ) {
    const b = track.bounds;
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;

    const pw = this.windowAround(this.track.startDist, CONFIG.scenery.pitLaneLen / 2);
    this.pitWindow = new Set(pw);
    this.pitSide =
      pw.length >= 3 ? -this.outwardSign(this.track.samples[pw[Math.floor(pw.length / 2)]]) : 0;

    this.container.addChild(this.grandstands());
    this.container.addChild(this.pitPaddock());
    // Cranes go in their own layer (added above the cars in main.ts).
    this.cranesLayer.addChild(this.cranes());
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
    const footprint = sc.standGap + seatDepth + roofDepth + 12; // depth from the edge

    // Try to seat a stand outside the track at sample `i`. `minGap` keeps it
    // clear of stands already placed (0 = no check); `lenFactor` shrinks it to
    // fit tighter spots. Returns whether a stand was placed.
    const place = (i: number, minGap = 0, lenFactor = 1): boolean => {
      const p = s[i];
      const out = this.outwardSign(p);
      // Don't sit a stand on the paddock side of the start/finish line…
      if (this.pitWindow.has(i) && out === this.pitSide) return false;
      if (minGap > 0) {
        for (const d of this.grandstandDists) {
          const dd = Math.abs(p.dist - d);
          if (Math.min(dd, this.track.length - dd) < minGap) return false;
        }
      }
      const nx = p.nx * out;
      const ny = p.ny * out;
      // …or where its depth would reach onto another part of the track.
      const e0 = this.edgeOffset(i, out, 0);
      if (this.track.edgeRayDistance(e0.x, e0.y, nx, ny) < footprint) return false;

      const ax = Math.cos(p.tangent);
      const ay = Math.sin(p.tangent);
      const halfLen = sc.standSegLen * (0.4 + Math.random() * 0.08) * lenFactor;
      const at = (d: number) => this.edgeOffset(i, out, d);
      // Skip if any footprint corner (near apron + far roof, at both ends) would
      // land on the track — e.g. a stand whose end pokes into the next corner.
      const alongHalf = halfLen + 5;
      for (const depth of [sc.standGap - 5, sc.standGap + seatDepth + roofDepth]) {
        const c = this.edgeOffset(i, out, depth);
        for (const sgn of [1, -1]) {
          if (this.track.onAsphalt(c.x + ax * alongHalf * sgn, c.y + ay * alongHalf * sgn)) {
            return false;
          }
        }
      }

      this.grandstandDists.push(p.dist);

      // Tarmac apron + front barrier, the seating bank, then a thin back roof,
      // all measured outward from the real track edge.
      const apron = at(sc.standGap - 5);
      this.rect(g, apron.x, apron.y, ax, ay, halfLen + 5, nx, ny, 5, 0x2b2f38);
      const seat = at(sc.standGap + seatDepth / 2);
      this.rect(g, seat.x, seat.y, ax, ay, halfLen, nx, ny, seatDepth / 2, 0x171b25);
      const front = at(sc.standGap);
      this.scatterCrowd(g, front.x, front.y, ax, ay, halfLen, nx, ny, seatDepth);
      const roof = at(sc.standGap + seatDepth + roofDepth / 2);
      this.rect(g, roof.x, roof.y, ax, ay, halfLen + 3, nx, ny, roofDepth / 2, 0x39414f);
      return true;
    };

    // Primary pass: stands on the long straights (unchanged behaviour).
    for (const straight of this.layout.straights) {
      if (this.runLength(straight.indices) < sc.standMinStraightFrac * this.track.length) {
        continue;
      }
      // Tighter end-margin packs 1–2 extra stands onto medium straights.
      for (const i of this.spaced(straight.indices, sc.standSegLen, sc.standSegLen * 0.3)) {
        place(i);
      }
    }

    // Guarantee a minimum count on sparse circuits (e.g. Monaco, Spa) WITHOUT
    // touching circuits that already meet it — this only runs when we're short.
    // Extra stands are spread AROUND THE LAP (farthest-point insertion) and biased
    // toward straighter spots, so they fill the empty side of the circuit and don't
    // sit awkwardly across a corner.
    const L = this.track.length;
    // Even ring of candidate spots around the whole lap.
    const candStep = Math.max(1, Math.round(s.length / 160));
    const candidates: number[] = [];
    for (let i = 0; i < s.length; i += candStep) candidates.push(i);

    // Circular arc distance from sample `i` to the nearest stand already placed.
    const gapToNearest = (i: number): number => {
      const d = s[i].dist;
      let nearest = Infinity;
      for (const gd of this.grandstandDists) {
        const dd = Math.abs(d - gd);
        nearest = Math.min(nearest, Math.min(dd, L - dd));
      }
      return nearest;
    };

    // One fill round: repeatedly take the still-free candidate that is farthest
    // from existing stands (best spread) and straightest (low curvature), then
    // place it. Relaxed params on later rounds guarantee we reach the minimum.
    const fill = (minGap: number, lenFactor: number, curvWeight: number): void => {
      const pool = candidates.slice();
      let guard = pool.length + 5;
      while (this.grandstandDists.length < sc.minStands && pool.length && guard-- > 0) {
        let bestK = -1;
        let bestScore = -Infinity;
        for (let k = 0; k < pool.length; k++) {
          const gap = gapToNearest(pool[k]);
          if (gap < minGap) continue;
          const score = gap - curvWeight * s[pool[k]].curvature;
          if (score > bestScore) {
            bestScore = score;
            bestK = k;
          }
        }
        if (bestK < 0) break; // nothing left far enough from existing stands
        const i = pool[bestK];
        pool.splice(bestK, 1); // consume this candidate either way
        place(i, minGap, lenFactor);
      }
    };

    if (this.grandstandDists.length < sc.minStands) fill(sc.standSegLen, 0.85, 4000);
    // Relax spacing/size and drop the straightness bias to guarantee the count.
    if (this.grandstandDists.length < sc.minStands) fill(sc.standSegLen * 0.6, 0.75, 1000);
    if (this.grandstandDists.length < sc.minStands) fill(sc.standSegLen * 0.3, 0.6, 0);
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
   * thin bands following the inside of the start/finish straight. Depths are
   * measured from the real track edge and clamped **per sample** to the local
   * infield clearance (distance to the next edge inward), so the complex shows at
   * full depth along the open straight and simply tapers where the infield
   * narrows — visible by the finish line yet never reaching onto the far track.
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

    // Inward clearance per window sample, smoothed so a stray grazing ray doesn't
    // punch a false notch.
    const raw = win.map((i) => {
      const inner = this.edgeOffset(i, inSign, 0);
      return this.track.edgeRayDistance(inner.x, inner.y, inSign * s[i].nx, inSign * s[i].ny);
    });
    const clr = raw.map((_, k) => {
      const w: number[] = [];
      for (let d = -2; d <= 2; d++) {
        const j = k + d;
        if (j >= 0 && j < raw.length) w.push(raw[j]);
      }
      w.sort((a, b) => a - b);
      return w[w.length >> 1];
    });

    // Depths from the edge, back (paddock) to front (pit lane).
    const laneInner = sc.pitLaneGap;
    const laneOuter = laneInner + sc.pitLaneWidth;
    const garInner = laneOuter + 3;
    const garOuter = garInner + sc.garageDepth;
    const padInner = garOuter + 3;
    const padOuter = padInner + sc.paddockDepth;
    const margin = 8;

    // Longest contiguous sub-window whose clearance fits a given depth.
    const longestRun = (depth: number): [number, number] => {
      let best: [number, number] = [0, 0];
      let start = -1;
      for (let k = 0; k <= win.length; k++) {
        const ok = k < win.length && clr[k] >= depth + margin;
        if (ok && start < 0) start = k;
        if (!ok && start >= 0) {
          if (k - start > best[1] - best[0]) best = [start, k];
          start = -1;
        }
      }
      return best;
    };

    // Pick the deepest complex that fits a long-enough stretch of the straight, and
    // draw it at *uniform* depth there — a clean rectangle, never tapering into the
    // grass. Drops to garage-only, then pit-lane-only, on tight infields.
    const tiers: { depth: number; garage: boolean; paddock: boolean }[] = [
      { depth: padOuter, garage: true, paddock: true },
      { depth: garOuter, garage: true, paddock: false },
      { depth: laneOuter, garage: false, paddock: false },
    ];
    let tier: (typeof tiers)[number] | null = null;
    let sub: number[] = [];
    for (const t of tiers) {
      const [a, b] = longestRun(t.depth);
      if (b - a >= 5) {
        tier = t;
        sub = win.slice(a, b);
        break;
      }
    }
    if (!tier) return g; // no room for even a pit lane

    const inf = sub.map(() => Infinity);
    // Back to front: paddock slab, garage building, glass canopy, pit lane.
    if (tier.paddock) this.fillCappedBand(g, sub, inSign, padInner, padOuter, inf, 0x232834);
    if (tier.garage) {
      this.fillCappedBand(g, sub, inSign, garInner, garOuter, inf, 0x2d323d);
      for (let k = 0; k < sub.length; k += 3) {
        const a = this.edgeOffset(sub[k], inSign, garInner);
        const b = this.edgeOffset(sub[k], inSign, garOuter);
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
      }
      g.stroke({ width: 1, color: 0x161a21, alpha: 0.7 });
      this.fillCappedBand(g, sub, inSign, garInner, garInner + sc.garageDepth * 0.5, inf, {
        color: 0x9fc4e6,
        alpha: 0.22,
      });
    }
    // Pit lane (paler asphalt) + the white pit wall line at the track side.
    this.fillCappedBand(g, sub, inSign, laneInner, laneOuter, inf, 0x474c57);
    this.cappedEdge(g, sub, inSign, laneInner, inf, 0xe8e8e8, 1.6);
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

  /**
   * Fill a band between two depths outside the edge, with the outer depth clamped
   * per sample to `caps[k]` (the local infield clearance). Drawn as one simple
   * quad per segment rather than a single ribbon polygon, so a curving straight or
   * a varying cap can never produce a self-intersecting outline (which rendered as
   * jagged triangular artifacts).
   */
  private fillCappedBand(
    g: Graphics,
    indices: number[],
    side: number,
    inner: number,
    outer: number,
    caps: number[],
    fill: number | { color: number; alpha: number },
  ): void {
    for (let k = 1; k < indices.length; k++) {
      const o0 = Math.max(inner, Math.min(outer, caps[k - 1]));
      const o1 = Math.max(inner, Math.min(outer, caps[k]));
      const i0 = this.edgeOffset(indices[k - 1], side, inner);
      const i1 = this.edgeOffset(indices[k], side, inner);
      const p1 = this.edgeOffset(indices[k], side, o1);
      const p0 = this.edgeOffset(indices[k - 1], side, o0);
      g.poly([i0.x, i0.y, i1.x, i1.y, p1.x, p1.y, p0.x, p0.y]).fill(fill);
    }
  }

  /** Pit-wall line at depth `off`, broken where the local clearance can't fit it. */
  private cappedEdge(
    g: Graphics,
    indices: number[],
    side: number,
    off: number,
    caps: number[],
    color: number,
    width: number,
  ): void {
    let pen = false;
    indices.forEach((i, k) => {
      if (caps[k] < off) {
        pen = false;
        return;
      }
      const p = this.edgeOffset(i, side, off);
      if (!pen) g.moveTo(p.x, p.y);
      else g.lineTo(p.x, p.y);
      pen = true;
    });
    g.stroke({ width, color });
  }
}
