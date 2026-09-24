import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
} from "three";
import { CONFIG } from "../config";
import type { Track, TrackSample } from "../track/Track";
import type { Pt } from "../track/centerline";
import { offsetPoint, type TrackLayout } from "../track/corners";
import { Solids } from "./Solids";

const CROWD = [0xe6e6e6, 0xff5a5f, 0xffd23f, 0x4f9dff, 0x5ad19a, 0xff8c42, 0xc779ff, 0xff4d6d, 0x2f3542];
const TEAM = [0xd8342c, 0x1e5bc6, 0x0f8f6d, 0xff8a00, 0x14141a, 0xf0c419, 0x5a2ca0, 0xe6e6e6];
const AD = [0xd8342c, 0xf0c419, 0x1e5bc6, 0xffffff, 0x14141a, 0x0f8f6d];

const CONCRETE = 0xb4b9c1;
const CONCRETE_TOP = 0xcbd0d6;
const ROOF = 0xeef0f2;
const STEEL = 0x8a929c;
const CRANE = 0xf4b41a;

/**
 * Static trackside surroundings in 3D, all derived from the track geometry and
 * built once: tiered grandstands packed with spectators along the straights, a
 * pit lane with pit wall, garages and a paddock of team trucks at the
 * start/finish, and recovery cranes at the sharpest corners. Placement rules are
 * the same as the former 2D scenery: everything stays strictly off the asphalt.
 */
export class Scenery3D {
  readonly group = new Group();
  /** Arc-length positions of the placed grandstands, for crowd-cheer audio. */
  readonly grandstandDists: number[] = [];
  private cx: number;
  private cy: number;
  private pitWindow: Set<number> = new Set();
  private pitSide = 0;
  private solids = new Solids();
  private crowd: { x: number; y: number; h: number; c: number }[] = [];

  constructor(
    private track: Track,
    private layout: TrackLayout,
  ) {
    const b = track.bounds;
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;

    const pw = this.windowAround(this.track.startDist, CONFIG.scenery.pitLaneLen / 2);
    this.pitWindow = new Set(pw);
    this.pitSide = pw.length >= 3 ? -this.outwardSign(this.track.samples[pw[Math.floor(pw.length / 2)]]) : 0;

    this.grandstands();
    this.pitPaddock();
    this.cranes();

    this.group.add(this.solids.build());
    if (this.crowd.length) this.group.add(this.crowdMesh());
  }

  private get half(): number {
    return this.track.def.width / 2;
  }

  private outwardSign(s: TrackSample): number {
    return (s.x - this.cx) * s.nx + (s.y - this.cy) * s.ny >= 0 ? 1 : -1;
  }

  private spaced(indices: number[], spacing: number, margin: number): number[] {
    const s = this.track.samples;
    const total = this.runLength(indices);
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
      if (traveled >= margin && total - traveled >= margin && sinceLast >= spacing) {
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
      len += Math.hypot(s[indices[j]].x - s[indices[j - 1]].x, s[indices[j]].y - s[indices[j - 1]].y);
    }
    return len;
  }

  /** A point `d` outside the track edge on `side` at centerline sample `i`. */
  private edgeOffset(i: number, side: number, d: number): Pt {
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

  private grandstands(): void {
    const sc = CONFIG.scenery;
    const s = this.track.samples;
    const seatDepth = sc.standDepth * 0.62;
    const roofDepth = sc.standDepth * 0.18;
    const footprint = sc.standGap + seatDepth + roofDepth + 12;

    const place = (i: number, minGap = 0, lenFactor = 1): boolean => {
      const p = s[i];
      const out = this.outwardSign(p);
      if (this.pitWindow.has(i) && out === this.pitSide) return false;
      if (minGap > 0) {
        for (const d of this.grandstandDists) {
          const dd = Math.abs(p.dist - d);
          if (Math.min(dd, this.track.length - dd) < minGap) return false;
        }
      }
      const nx = p.nx * out;
      const ny = p.ny * out;
      const e0 = this.edgeOffset(i, out, 0);
      if (this.track.edgeRayDistance(e0.x, e0.y, nx, ny) < footprint) return false;

      const ax = Math.cos(p.tangent);
      const ay = Math.sin(p.tangent);
      const halfLen = sc.standSegLen * (0.4 + Math.random() * 0.08) * lenFactor;
      const alongHalf = halfLen + 5;
      for (const depth of [sc.standGap - 5, sc.standGap + seatDepth + roofDepth]) {
        const c = this.edgeOffset(i, out, depth);
        for (const sgn of [1, -1]) {
          if (this.track.onAsphalt(c.x + ax * alongHalf * sgn, c.y + ay * alongHalf * sgn)) return false;
        }
      }

      this.grandstandDists.push(p.dist);
      this.buildStand((d) => this.edgeOffset(i, out, d), ax, ay, halfLen, seatDepth, roofDepth);
      return true;
    };

    for (const straight of this.layout.straights) {
      if (this.runLength(straight.indices) < sc.standMinStraightFrac * this.track.length) continue;
      for (const i of this.spaced(straight.indices, sc.standSegLen, sc.standSegLen * 0.3)) place(i);
    }

    // Sparse circuits: spread extra stands around the lap (farthest-point
    // insertion, biased to straighter spots) until the minimum is met.
    const L = this.track.length;
    const candStep = Math.max(1, Math.round(s.length / 160));
    const candidates: number[] = [];
    for (let i = 0; i < s.length; i += candStep) candidates.push(i);
    const gapToNearest = (i: number): number => {
      let nearest = Infinity;
      for (const gd of this.grandstandDists) {
        const dd = Math.abs(s[i].dist - gd);
        nearest = Math.min(nearest, Math.min(dd, L - dd));
      }
      return nearest;
    };
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
        if (bestK < 0) break;
        const i = pool[bestK];
        pool.splice(bestK, 1);
        place(i, minGap, lenFactor);
      }
    };
    if (this.grandstandDists.length < sc.minStands) fill(sc.standSegLen, 0.85, 4000);
    if (this.grandstandDists.length < sc.minStands) fill(sc.standSegLen * 0.6, 0.75, 1000);
    if (this.grandstandDists.length < sc.minStands) fill(sc.standSegLen * 0.3, 0.6, 0);
  }

  /**
   * One grandstand: apron, a front wall of ad boards, stepped seating tiers
   * filled with spectators, a back wall and a cantilevered roof on posts.
   * `at(d)` is the point `d` units outward from the track edge at the stand's
   * centre; (ax, ay) is the along-track axis.
   */
  private buildStand(
    at: (d: number) => Pt,
    ax: number,
    ay: number,
    halfLen: number,
    seatDepth: number,
    roofDepth: number,
  ): void {
    const sc = CONFIG.scenery;
    const g = this.solids;
    const apron = at(sc.standGap - 5);
    g.box(apron.x, apron.y, ax, ay, halfLen + 5, 5, 0, 0.5, 0x7b8089);

    // Front wall made of sponsor boards.
    const wall = at(sc.standGap - 1);
    const boards = Math.max(1, Math.round((halfLen * 2) / 22));
    const bl = (halfLen * 2) / boards;
    for (let k = 0; k < boards; k++) {
      const u = -halfLen + bl * (k + 0.5);
      g.box(wall.x + ax * u, wall.y + ay * u, ax, ay, bl / 2, 0.8, 0, 4.5, AD[(Math.random() * AD.length) | 0], 0xdadde2);
    }

    const tiers = 5;
    const riser = seatDepth * 0.12;
    const td = seatDepth / tiers;
    let top = 4;
    for (let k = 0; k < tiers; k++) {
      top = 4 + (k + 1) * riser;
      const c = at(sc.standGap + td * (k + 0.5));
      g.box(c.x, c.y, ax, ay, halfLen, td / 2, 0, top, CONCRETE, CONCRETE_TOP);
      // Two staggered rows of spectators per tier (a few empty seats).
      for (const row of [0.3, 0.72]) {
        const rc = at(sc.standGap + td * (k + row));
        for (let u = -halfLen + 2; u < halfLen - 1; u += 3.4) {
          if (Math.random() < 0.08) continue;
          const j = u + (Math.random() - 0.5) * 1.2;
          this.crowd.push({
            x: rc.x + ax * j,
            y: rc.y + ay * j,
            h: top,
            c: CROWD[(Math.random() * CROWD.length) | 0],
          });
        }
      }
    }

    const back = at(sc.standGap + seatDepth + 1);
    g.box(back.x, back.y, ax, ay, halfLen, 1, 0, top + 6, 0x9ea4ad);

    // Roof on slim posts along the back, overhanging the upper tiers.
    const roofY = top + 13;
    const roof = at(sc.standGap + seatDepth * 0.35 + (seatDepth * 0.65 + roofDepth) / 2);
    g.box(roof.x, roof.y, ax, ay, halfLen + 3, (seatDepth * 0.65 + roofDepth) / 2, roofY, roofY + 1.6, 0xb7bec7, ROOF);
    const post = at(sc.standGap + seatDepth + 1);
    for (let u = -halfLen; u <= halfLen + 0.1; u += Math.max(20, (halfLen * 2) / 6)) {
      g.box(post.x + ax * u, post.y + ay * u, ax, ay, 0.8, 0.8, 0, roofY, STEEL);
    }
  }

  private crowdMesh(): InstancedMesh {
    const geo = new BoxGeometry(1.7, 2.6, 1.7).translate(0, 1.3, 0);
    const mesh = new InstancedMesh(geo, new MeshLambertMaterial(), this.crowd.length);
    const m = new Matrix4();
    const c = new Color();
    this.crowd.forEach((p, k) => {
      m.makeTranslation(p.x, p.h, p.y);
      mesh.setMatrixAt(k, m);
      mesh.setColorAt(k, c.setHex(p.c));
    });
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Recovery cranes at the sharpest corners, jib reaching toward the track. */
  private cranes(): void {
    const sc = CONFIG.scenery;
    const s = this.track.samples;
    const g = this.solids;
    const sharpest = [...this.layout.runs].sort((a, b) => b.peakSeverity - a.peakSeverity).slice(0, sc.craneCount);
    for (const run of sharpest) {
      const p = s[run.indices[Math.round((run.apexStart + run.apexEnd) / 2)]];
      const out = -run.turnSign;
      const nx = p.nx * out;
      const ny = p.ny * out;
      const ax = Math.cos(p.tangent);
      const ay = Math.sin(p.tangent);
      const baseC = this.half + sc.craneGap;
      const bx = p.x + nx * baseC;
      const by = p.y + ny * baseC;
      g.box(bx, by, ax, ay, 12, 8, 0, 4, 0x394150); // chassis
      for (const w of [-8, 8]) {
        for (const d of [-7, 7]) g.box(bx + ax * w + nx * d, by + ay * w + ny * d, ax, ay, 2.4, 1.2, 0, 4.8, 0x1c1f25);
      }
      g.box(bx - nx * 2, by - ny * 2, ax, ay, 6, 5, 4, 11, CRANE, 0xf7c64a); // cab
      const armLen = sc.craneGap * 0.9;
      const armC = baseC - armLen / 2;
      // Boom: rises from the cab and reaches back over the run-off.
      g.box(p.x + nx * armC, p.y + ny * armC, nx, ny, armLen / 2, 2.2, 22, 25.5, CRANE, 0xf7c64a);
      g.box(bx, by, ax, ay, 2.2, 2.2, 11, 25.5, CRANE);
      const hookC = baseC - armLen;
      const hx = p.x + nx * hookC;
      const hy = p.y + ny * hookC;
      g.box(hx, hy, ax, ay, 0.35, 0.35, 10, 22, 0x20242e);
      g.box(hx, hy, ax, ay, 1.6, 1.6, 7.5, 10, 0x20242e);
    }
  }

  private windowAround(centerDist: number, halfLen: number): number[] {
    const s = this.track.samples;
    const n = s.length - 1;
    const L = this.track.length;
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
   * Pit complex on the inside of the start/finish straight: pit lane and wall,
   * a garage block with team-coloured doors and a paddock with team trucks.
   * The deepest tier that fits the local infield clearance is used, at uniform
   * depth, so it never reaches across onto the far side of the track.
   */
  private pitPaddock(): void {
    const sc = CONFIG.scenery;
    const s = this.track.samples;
    const g = this.solids;
    const win = this.windowAround(this.track.startDist, sc.pitLaneLen / 2);
    if (win.length < 3) return;
    const mid = s[win[Math.floor(win.length / 2)]];
    const inSign = -this.outwardSign(mid);

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

    const laneInner = sc.pitLaneGap;
    const laneOuter = laneInner + sc.pitLaneWidth;
    const garInner = laneOuter + 3;
    const garOuter = garInner + sc.garageDepth;
    const padInner = garOuter + 3;
    const padOuter = padInner + sc.paddockDepth;
    const margin = 8;

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

    const tiers = [
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
    if (!tier) return;

    const band = (inner: number, outer: number, y0: number, y1: number, side: number, top = side) => {
      for (let k = 1; k < sub.length; k++) {
        g.prism(
          [
            this.edgeOffset(sub[k - 1], inSign, inner),
            this.edgeOffset(sub[k], inSign, inner),
            this.edgeOffset(sub[k], inSign, outer),
            this.edgeOffset(sub[k - 1], inSign, outer),
          ],
          y0,
          y1,
          side,
          top,
        );
      }
    };

    band(laneInner, laneOuter, 0, 0.45, 0x565b65);
    band(laneInner - 1.6, laneInner, 0, 4, 0xe6e6e6, 0xd8342c); // pit wall

    if (tier.garage) {
      band(garInner, garOuter, 0, 15, 0xe9ecef, 0x5b6370);
      // Team-coloured garage doors facing the pit lane.
      for (let k = 1; k < sub.length; k += 2) {
        g.prism(
          [
            this.edgeOffset(sub[k - 1], inSign, garInner - 0.6),
            this.edgeOffset(sub[k], inSign, garInner - 0.6),
            this.edgeOffset(sub[k], inSign, garInner),
            this.edgeOffset(sub[k - 1], inSign, garInner),
          ],
          0,
          10,
          TEAM[(k >> 1) % TEAM.length],
        );
      }
    }
    if (tier.paddock) {
      band(padInner, padOuter, 0, 0.4, 0x9aa0a8);
      // A row of team trucks parked across the paddock.
      for (let k = 2; k < sub.length - 2; k += 3) {
        const a = s[sub[k]];
        const c = this.edgeOffset(sub[k], inSign, (padInner + padOuter) / 2);
        const ox = inSign * a.nx;
        const oy = inSign * a.ny;
        const color = TEAM[k % TEAM.length];
        g.box(c.x + ox * 3, c.y + oy * 3, ox, oy, 8, 3.2, 0.4, 9, color, 0xe6e8eb); // trailer
        g.box(c.x - ox * 7, c.y - oy * 7, ox, oy, 2.6, 3, 0.4, 7.5, 0x2a2f38); // cab
      }
    }
  }
}
