import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Vector3,
} from "three";
import { CONFIG } from "../config";
import { UNITS_PER_METRE, type Track } from "../track/Track";
import type { Pt } from "../track/centerline";
import type { TrackLayout } from "../track/corners";
import { KitInstancer, PROP_SCALE } from "./Kit";
import type { Occupancy } from "./Occupancy";
import type { OsmWorld } from "./osm";
import { outwardSign, pitInfo, type PitInfo } from "./pitInfo";
import { Solids } from "./Solids";
import type { Terrain } from "./Terrain";
import { hashString, mulberry32 } from "./Terrain";

const CROWD = [0xe8e4da, 0xd8553f, 0xe9b532, 0x4e7fc4, 0x5aa97b, 0xe0873e, 0x9a6fc0, 0xd9546d, 0x3a3f48, 0xf1efe8];
const TEAM = [0xc8412f, 0x1f4fa8, 0x137a64, 0xe8862a, 0x23262b, 0xe6b422, 0x5a3a9a, 0x9aa3ab, 0x2f7a4f, 0xd9546d];
const SEAT = [0x3f6cb3, 0xc8412f, 0xe6b422, 0x2f7a4f];
const CONCRETE = 0xc9c6be;
const CONCRETE_TOP = 0xd9d6cf;
const ROOF = 0xeeece6;
const STEEL = 0x8e969e;

/**
 * Trackside scenery in 3D, standing on the real track/terrain heights and all
 * kept off the asphalt: detailed grandstands (tiers, seat blocks, aisles,
 * spectators, roof on columns, flags), the pit complex (pit wall, garages with
 * team doors, a glazed pit building, paddock with trucks, motorhomes, tents
 * and people), recovery telehandlers at the sharpest corners, marshal posts
 * and TV towers around the lap, gantries over the straights, billboards and
 * a spectator car park. Kit assets are instanced; structures are merged solids.
 */
export class Scenery3D {
  readonly group = new Group();
  readonly grandstandDists: number[] = [];
  private solids = new Solids();
  private kit = new KitInstancer();
  private crowd: { x: number; y: number; h: number; c: number }[] = [];
  private pit: PitInfo;
  private rand: () => number;
  private half: number;

  constructor(
    private track: Track,
    private layout: TrackLayout,
    private terrain: Terrain,
    private occ: Occupancy,
    private osm: OsmWorld | null = null,
  ) {
    this.rand = mulberry32(hashString(track.def.id + ":scenery"));
    this.pit = pitInfo(track);
    this.half = track.def.width / 2;
    this.reserveTrack();

    this.pitComplex();
    this.grandstands();
    this.telehandlers();
    this.marshalPosts();
    this.gantries();
    this.billboards();

    this.group.add(this.solids.build());
    this.group.add(this.kit.build());
    if (this.crowd.length) this.group.add(this.crowdMesh());
  }

  /** Block the asphalt + run-off corridor for everything placed afterwards. */
  private reserveTrack(): void {
    const s = this.track.samples;
    const r = this.half + 30;
    for (let i = 0; i < s.length; i += 3) this.occ.add(s[i].x, s[i].y, r);
  }

  private pick<T>(a: T[]): T {
    return a[Math.floor(this.rand() * a.length)];
  }

  /** A point `d` outside the real track edge on `side` at sample `i`, with the track height. */
  private edgeOffset(i: number, side: number, d: number): Pt & { h: number } {
    const s = this.track.samples[i];
    const edge = this.track.edgeLeft;
    let w = this.half;
    if (edge) {
      const e = side >= 0 ? edge[i] : this.track.edgeRight![i];
      w = Math.max(this.half * 0.55, Math.min(this.half * 1.6, Math.hypot(e.x - s.x, e.y - s.y)));
    }
    const k = w + d;
    return { x: s.x + s.nx * side * k, y: s.y + s.ny * side * k, h: s.h };
  }

  private ground(x: number, y: number): number {
    return this.terrain.heightAt(x, y);
  }

  private runLength(indices: number[]): number {
    const s = this.track.samples;
    let len = 0;
    for (let j = 1; j < indices.length; j++) len += Math.hypot(s[indices[j]].x - s[indices[j - 1]].x, s[indices[j]].y - s[indices[j - 1]].y);
    return len;
  }

  private spaced(indices: number[], spacing: number, margin: number): number[] {
    const s = this.track.samples;
    const total = this.runLength(indices);
    const picks: number[] = [];
    let traveled = 0;
    let since = Infinity;
    for (let j = 0; j < indices.length; j++) {
      if (j > 0) {
        const d = Math.hypot(s[indices[j]].x - s[indices[j - 1]].x, s[indices[j]].y - s[indices[j - 1]].y);
        traveled += d;
        since += d;
      }
      if (traveled >= margin && total - traveled >= margin && since >= spacing) {
        picks.push(indices[j]);
        since = 0;
      }
    }
    return picks;
  }

  // ------------------------------------------------------------------ stands
  private grandstands(): void {
    const sc = CONFIG.scenery;
    const s = this.track.samples;
    const depth = sc.standDepth * 0.9;

    const place = (i: number, minGap = 0, lenFactor = 1, side?: number, gapOverride?: number, lenOverride?: number): boolean => {
      const p = s[i];
      const out = side ?? outwardSign(this.track, p);
      if (this.pit.window.has(i) && out === this.pit.side) return false;
      if (this.track.nearSelf[i]) return false;
      if (minGap > 0) {
        for (const d of this.grandstandDists) {
          const dd = Math.abs(p.dist - d);
          if (Math.min(dd, this.track.length - dd) < minGap) return false;
        }
      }
      const ax = Math.cos(p.tangent);
      const ay = Math.sin(p.tangent);
      const halfLen = lenOverride ?? sc.standSegLen * (0.42 + this.rand() * 0.1) * lenFactor;
      const gap = gapOverride ?? (this.track.def.street ? sc.standGap * 0.45 : sc.standGap);
      const mid = this.edgeOffset(i, out, gap + depth / 2);
      const r = depth / 2;
      // The footprint as a row of circles along the stand (it's long and thin).
      const dots: Pt[] = [];
      for (let u = -halfLen; u <= halfLen + 0.1; u += r) dots.push({ x: mid.x + ax * u, y: mid.y + ay * u });
      if (dots.some((d) => !this.occ.free(d.x, d.y, r * 0.95))) return false;
      if (dots.some((d) => this.terrain.trackDistance(d.x, d.y) < this.half + gap)) return false;
      if (this.track.edgeRayDistance(mid.x, mid.y, p.nx * out, p.ny * out) < depth) return false;
      for (const d of dots) this.occ.add(d.x, d.y, r);
      this.grandstandDists.push(p.dist);
      this.buildStand((d) => this.edgeOffset(i, out, d - sc.standGap + gap), ax, ay, halfLen, depth, p.h);
      return true;
    };

    // Real stands first (OSM): each at the lap position and side it overlooks.
    const real = this.osm ? this.osm.raw.stands.map((b) => this.osm!.mapBox(b)).filter((b) => b !== null) : [];
    for (const b of real) {
      let bi = -1;
      let bd = Infinity;
      for (let i = 0; i < s.length - 1; i++) {
        const d = (s[i].x - b.x) ** 2 + (s[i].y - b.y) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      const dist = Math.sqrt(bd);
      if (bi < 0 || dist > 500) continue;
      const side = (b.x - s[bi].x) * s[bi].nx + (b.y - s[bi].y) * s[bi].ny >= 0 ? 1 : -1;
      const gap = Math.max(sc.standGap * 0.45, dist - this.half - depth / 2);
      const halfLen = Math.min(110, Math.max(40, (b.w * this.osm!.scale * 1.4) / 2));
      place(bi, sc.standSegLen * 0.4, 1, side, gap, halfLen);
    }
    if (real.length < 3) {
      for (const straight of this.layout.straights) {
        if (this.runLength(straight.indices) < sc.standMinStraightFrac * this.track.length) continue;
        for (const i of this.spaced(straight.indices, sc.standSegLen * 1.05, sc.standSegLen * 0.3)) place(i);
      }
    }
    if (real.length >= 3) return;
    // Corner-exit stands overlooking the braking zones (like the refs' hairpin stands).
    for (const run of this.layout.runs) {
      const i = run.indices[Math.min(run.indices.length - 1, run.apexEnd + 2)];
      if (i !== undefined) place(i, sc.standSegLen * 0.9, 0.7);
    }
    const L = this.track.length;
    const cand: number[] = [];
    for (let i = 0; i < s.length - 1; i += Math.max(1, Math.round(s.length / 160))) cand.push(i);
    const gapTo = (i: number) => {
      let n = Infinity;
      for (const g of this.grandstandDists) {
        const dd = Math.abs(s[i].dist - g);
        n = Math.min(n, Math.min(dd, L - dd));
      }
      return n;
    };
    const target = sc.minStands + 3;
    for (const [gap, lf] of [[sc.standSegLen, 0.85], [sc.standSegLen * 0.6, 0.7]] as const) {
      const pool = cand.slice();
      while (this.grandstandDists.length < target && pool.length) {
        let bestK = 0;
        let best = -Infinity;
        pool.forEach((i, k) => {
          const sc2 = gapTo(i) - 3000 * s[i].curvature;
          if (sc2 > best) {
            best = sc2;
            bestK = k;
          }
        });
        const [i] = pool.splice(bestK, 1);
        if (gapTo(i) >= gap) place(i, gap, lf);
      }
    }
  }

  /**
   * One grandstand at `at(d)` (d outward from the track edge): apron, front
   * wall with ad boards, stepped tiers of coloured seat blocks split by stair
   * aisles and filled with spectators, a back wall, a roof on columns with a
   * sponsor fascia, and flags along the top.
   */
  private buildStand(at: (d: number) => Pt & { h: number }, ax: number, ay: number, halfLen: number, depth: number, trackH: number): void {
    const sc = CONFIG.scenery;
    const g = this.solids;
    const front = sc.standGap;
    const floor = trackH + 0.5;
    // Foundation reaching down to whatever the ground does under the stand.
    const c = at(front + depth / 2);
    const lowest = Math.min(
      this.ground(c.x, c.y),
      this.ground(at(front).x, at(front).y),
      this.ground(at(front + depth).x, at(front + depth).y),
    );
    const base = Math.min(floor, lowest) - 3;
    const apron = at(front - 6);
    g.box(apron.x, apron.y, ax, ay, halfLen + 6, 6, base, floor, 0x8d9097, 0xa8aab0);

    const wall = at(front - 1);
    const boards = Math.max(2, Math.round((halfLen * 2) / 20));
    const bl = (halfLen * 2) / boards;
    for (let k = 0; k < boards; k++) {
      const u = -halfLen + bl * (k + 0.5);
      g.box(wall.x + ax * u, wall.y + ay * u, ax, ay, bl / 2 - 0.2, 0.8, floor, floor + 4.5, this.pick(TEAM), 0xdadde2);
    }

    const tiers = 8;
    const td = (depth * 0.82) / tiers;
    const riser = 3.1;
    const aisle = 44;
    const seatCol = this.pick(SEAT);
    let top = floor;
    for (let k = 0; k < tiers; k++) {
      top = floor + 3 + (k + 1) * riser;
      const cc = at(front + td * (k + 0.5));
      g.box(cc.x, cc.y, ax, ay, halfLen, td / 2, base, top - 0.6, CONCRETE, CONCRETE_TOP);
      // Seat blocks between aisles; the aisles stay bare concrete steps.
      for (let u = -halfLen; u < halfLen - 1; u += aisle) {
        const u1 = Math.min(halfLen, u + aisle) - 2.5;
        const u0 = u + 2.5;
        if (u1 <= u0) continue;
        const um = (u0 + u1) / 2;
        g.box(cc.x + ax * um, cc.y + ay * um, ax, ay, (u1 - u0) / 2, td / 2 - 0.4, top - 0.6, top, seatCol);
        for (let x = u0 + 1.2; x < u1 - 0.6; x += 3.2) {
          if (this.rand() < 0.07) continue;
          const j = x + (this.rand() - 0.5) * 0.9;
          const row = at(front + td * (k + 0.5) + (this.rand() - 0.5) * td * 0.4);
          this.crowd.push({ x: row.x + ax * j, y: row.y + ay * j, h: top, c: this.pick(CROWD) });
        }
      }
    }
    const back = at(front + depth * 0.84);
    g.box(back.x, back.y, ax, ay, halfLen, 1.2, base, top + 7, 0xa9adb3);

    // Roof over the upper two-thirds, on columns rising behind the stand.
    const roofY = top + 16;
    const rc = at(front + depth * 0.42);
    const roofHalf = depth * 0.5;
    g.box(rc.x, rc.y, ax, ay, halfLen + 3, roofHalf, roofY, roofY + 1.4, 0xb7bec7, ROOF);
    const fascia = at(front + depth * 0.42 - roofHalf);
    // Proud of the roof slab on top and at the ends, never flush with it (z-fighting).
    g.box(fascia.x, fascia.y, ax, ay, halfLen + 3.3, 0.6, roofY - 3.2, roofY + 1.8, this.pick(TEAM));
    const colLine = at(front + depth * 0.86);
    const bays = Math.max(2, Math.round((halfLen * 2) / 24));
    for (let k = 0; k <= bays; k++) {
      const u = -halfLen + (k * halfLen * 2) / bays;
      g.box(colLine.x + ax * u, colLine.y + ay * u, ax, ay, 0.9, 0.9, base, roofY, STEEL);
      // Diagonal brace down to the back wall (reads as the refs' roof trusses).
      g.box(colLine.x + ax * u, colLine.y + ay * u, ax, ay, 0.4, 3.5, roofY - 5, roofY - 4, STEEL);
      if (k % 2 === 0) this.kit.add("flag", colLine.x + ax * u, roofY + 1.4, colLine.y + ay * u, Math.atan2(ay, ax), 1.4, this.pick(TEAM));
    }
  }

  private crowdMesh(): InstancedMesh {
    const geo = new BoxGeometry(1.8, 2.8, 1.8).translate(0, 1.4, 0);
    const mesh = new InstancedMesh(geo, new MeshLambertMaterial(), this.crowd.length);
    const m = new Matrix4();
    const c = new Color();
    this.crowd.forEach((p, k) => {
      m.makeTranslation(p.x, p.h, p.y);
      mesh.setMatrixAt(k, m);
      mesh.setColorAt(k, c.setHex(p.c));
    });
    mesh.receiveShadow = true;
    return mesh;
  }

  // -------------------------------------------------------------- pit complex
  /**
   * Pit lane + pit wall, a garage block with team-coloured doors and a glazed
   * upper floor, then the paddock: team trucks, motorhomes, tents, people and
   * lamp posts, and a spectator car park behind. Depth is capped by the free
   * infield so it never reaches the far side of the track.
   */
  private pitComplex(): void {
    const sc = CONFIG.scenery;
    const s = this.track.samples;
    const g = this.solids;
    const win = [...this.pit.window];
    if (win.length < 3) return;
    const side = this.pit.side;
    const clr = win.map((i) => {
      const e = this.edgeOffset(i, side, 0);
      return this.track.edgeRayDistance(e.x, e.y, side * s[i].nx, side * s[i].ny);
    });
    const laneIn = sc.pitLaneGap;
    const laneOut = laneIn + (this.track.def.pitLane ? 10 * UNITS_PER_METRE : sc.pitLaneWidth * 1.3);
    // Real pit lane: the whole complex slides out to where the lane really runs.
    const shift = (i: number) => (this.pit.laneOffset?.get(i) ?? (laneIn + laneOut) / 2) - (laneIn + laneOut) / 2;
    const garIn = laneOut + 2;
    const garOut = garIn + sc.garageDepth * 1.6;
    const padIn = garOut + 4;
    const padOut = padIn + sc.paddockDepth * 2.4;
    const fits = (d: number) => {
      let best: [number, number] = [0, 0];
      let st = -1;
      for (let k = 0; k <= win.length; k++) {
        const ok = k < win.length && clr[k] >= d + shift(win[k]) + 10;
        if (ok && st < 0) st = k;
        if (!ok && st >= 0) {
          if (k - st > best[1] - best[0]) best = [st, k];
          st = -1;
        }
      }
      return best;
    };
    const tiers = [
      { depth: padOut, garage: true, paddock: true },
      { depth: garOut, garage: true, paddock: false },
      { depth: laneOut, garage: false, paddock: false },
    ];
    let tier: (typeof tiers)[number] | null = null;
    let sub: number[] = [];
    for (const t of tiers) {
      const [a, b] = fits(t.depth);
      if (b - a >= 5) {
        tier = t;
        sub = win.slice(a, b);
        break;
      }
    }
    if (!tier) return;

    const P = (i: number, d: number) => this.edgeOffset(i, side, d + shift(i));
    // Where the real lane closes in on the track, the pit wall would cut onto the asphalt.
    const onRoad = (i: number, d: number) => {
      const p = P(i, d);
      const lat = ((p.x - s[i].x) * s[i].nx + (p.y - s[i].y) * s[i].ny) * side;
      return lat < this.track.hw[side > 0 ? 0 : 1][i] + 0.5;
    };
    const band = (d0: number, d1: number, lift0: number, lift1: number, col: number, topCol = col) => {
      for (let k = 1; k < sub.length; k++) {
        const a = sub[k - 1];
        const b = sub[k];
        if (onRoad(a, d0) || onRoad(b, d0)) continue;
        const ha = s[a].h;
        const hb = s[b].h;
        g.prism(
          [P(a, d0), P(b, d0), P(b, d1), P(a, d1)],
          [ha - 4, hb - 4, hb - 4, ha - 4],
          [ha + lift0, hb + lift0, hb + lift1, ha + lift1],
          col,
          topCol,
        );
      }
    };
    // A mapped pit lane is already paved by TrackMesh along its real path: a
    // second surface here would z-fight it in dark patches.
    if (!this.track.def.pitLane) band(laneIn, laneOut, 0.55, 0.55, 0x6d7076, 0x5e6167);
    band(laneIn - 1.8, laneIn, 4.5, 4.5, 0xe8e6e0, 0xc8412f); // pit wall
    for (let k = 0; k < sub.length; k += 2) {
      const oc = P(sub[k], tier.depth / 2);
      this.occ.add(oc.x, oc.y, tier.depth / 2 + 4);
      // Keep the gap between track and lane clear too.
      if (shift(sub[k]) > 8) {
        const og = this.edgeOffset(sub[k], side, shift(sub[k]) / 2);
        this.occ.add(og.x, og.y, shift(sub[k]) / 2 + 4);
      }
    }

    if (tier.garage) {
      band(garIn, garOut, 13, 13, 0xeeece6, 0x6c737c);
      // Glazed upper band and roof edge, the refs' long white pit building.
      band(garIn - 0.4, garIn, 13, 13, 0x2e3a44);
      for (let k = 1; k < sub.length; k += 2) {
        const a = sub[k - 1];
        const b = sub[k];
        const ha = s[a].h;
        g.prism([P(a, garIn - 0.8), P(b, garIn - 0.8), P(b, garIn), P(a, garIn)], ha, ha + 7.5, TEAM[(k >> 1) % TEAM.length]);
      }
      // The upper floor starts clear of the block's flat top (13): a roof
      // rising from exactly that height met it at a grazing angle and z-fought.
      band(garIn + 2, garOut - 2, 14.2, 19, 0xdcdad4, 0x8b929a);
      band(garIn + 1.5, garIn + 2, 14.2, 18, 0x2e3a44);
    }
    if (tier.paddock) {
      band(padIn, padOut, 0.4, 0.4, 0x9da1a8, 0xa7abb1);
      // One vehicle per slot, a fixed distance apart whatever the sample
      // spacing: transporters (nose out, tail clear of the garages) alternate
      // with motorhomes or hospitality tents. People and lamps stand in the
      // gaps, so nothing overlaps (a transporter used to reach into the
      // garage roof and through the tents).
      const slot = 26;
      let acc = 0;
      let next = slot;
      let j = 0;
      for (let k = 1; k < sub.length - 1; k++) {
        const i = sub[k];
        const a = P(sub[k - 1], padIn);
        const b = P(i, padIn);
        acc += Math.hypot(b.x - a.x, b.y - a.y);
        if (acc < next) continue;
        next = acc + slot;
        const p = s[i];
        const heading = Math.atan2(side * p.ny, side * p.nx);
        const team = TEAM[j % TEAM.length];
        if (j % 2 === 0) {
          const c = P(i, padIn + 26);
          this.kit.add("truck", c.x, p.h + 0.4, c.y, heading, 0.8, team);
        } else if (j % 4 === 1) {
          const c = P(i, padIn + 22);
          this.kit.add("motorhome", c.x, p.h + 0.4, c.y, heading, 0.8, team);
        } else {
          const c = P(i, padIn + 20);
          this.kit.add("tent", c.x, p.h + 0.4, c.y, heading, 1.2, team);
        }
        const tx = Math.cos(p.tangent) * (slot / 2);
        const ty = Math.sin(p.tangent) * (slot / 2);
        for (let n = 0; n < 2; n++) {
          const pp = P(i, padIn + 6 + this.rand() * (padOut - padIn - 12));
          this.kit.add("person", pp.x + tx, p.h + 0.4, pp.y + ty, this.rand() * 6.3, 1, this.pick(TEAM));
        }
        if (j % 3 === 0) {
          const lp = P(i, padIn + 2);
          this.kit.add("lamp", lp.x + tx, p.h + 0.4, lp.y + ty, heading + Math.PI, 1.3);
        }
        j++;
      }
      // Real car parks come from OSM; only invent one without it.
      if (!this.osm) this.carPark(sub, side, padOut + 30);
    }
  }

  /** A spectator car park: a paved lot with rows of parked cars. */
  private carPark(sub: number[], side: number, dist: number): void {
    const s = this.track.samples;
    const mid = sub[sub.length >> 1];
    const p = s[mid];
    const ax = Math.cos(p.tangent);
    const ay = Math.sin(p.tangent);
    const ox = side * p.nx;
    const oy = side * p.ny;
    const c = this.edgeOffset(mid, side, dist + 60);
    const hl = 150;
    const hd = 55;
    if (!this.occ.free(c.x, c.y, hl * 0.9)) return;
    if (this.terrain.trackDistance(c.x, c.y) < this.half + 150) return;
    this.occ.add(c.x, c.y, hl);
    const corner = (u: number, v: number) => ({ x: c.x + ax * u + ox * v, y: c.y + ay * u + oy * v });
    const foot = [corner(-hl, -hd), corner(hl, -hd), corner(hl, hd), corner(-hl, hd)];
    const tops = foot.map((p) => this.ground(p.x, p.y) + 0.4);
    this.solids.prism(foot, tops.map((t) => t - 6), tops, 0x8f9298, 0x7c7f85);
    const cars = [0xe8e4da, 0x2a2d33, 0xc8412f, 0x4e7fc4, 0x9aa3ab, 0xe6b422, 0x5aa97b];
    for (let row = -2; row <= 2; row++) {
      for (let u = -hl + 8; u < hl - 8; u += 11) {
        if (this.rand() < 0.2) continue;
        const x = c.x + ax * u + ox * row * 20;
        const y = c.y + ay * u + oy * row * 20;
        this.kit.add("car_parked", x, this.ground(x, y) + 0.4, y, Math.atan2(oy, ox) + (row % 2 ? Math.PI : 0), 1, this.pick(cars));
      }
    }
  }

  // ----------------------------------------------------------- corner props
  /** Yellow recovery telehandlers parked behind the sharpest corners. */
  private telehandlers(): void {
    const s = this.track.samples;
    const runs = [...this.layout.runs].sort((a, b) => b.peakSeverity - a.peakSeverity).slice(0, CONFIG.scenery.craneCount + 2);
    for (const run of runs) {
      const i = run.indices[Math.round((run.apexStart + run.apexEnd) / 2)];
      const out = -run.turnSign;
      const p = this.edgeOffset(i, out, CONFIG.scenery.runOffWidth + 34);
      if (!this.occ.free(p.x, p.y, 16) || this.terrain.trackDistance(p.x, p.y) < this.half + 50) continue;
      this.occ.add(p.x, p.y, 16);
      const heading = Math.atan2(-s[i].ny * out, -s[i].nx * out); // boom toward the track
      this.kit.add("telehandler", p.x, this.ground(p.x, p.y), p.y, heading, 1.1);
    }
  }

  /** Marshal towers every ~650 units and TV camera towers at the big corners. */
  private marshalPosts(): void {
    const s = this.track.samples;
    const L = this.track.length;
    const step = 650;
    for (let d = 200; d < L; d += step) {
      const idx = s.findIndex((p) => p.dist >= d);
      if (idx < 0) break;
      const out = outwardSign(this.track, s[idx]);
      const p = this.edgeOffset(idx, out, CONFIG.scenery.runOffWidth + 22);
      if (!this.occ.free(p.x, p.y, 12) || this.terrain.trackDistance(p.x, p.y) < this.half + 40) continue;
      this.occ.add(p.x, p.y, 12);
      this.kit.add("marshal_tower", p.x, this.ground(p.x, p.y), p.y, s[idx].tangent, 1.2);
    }
    const runs = [...this.layout.runs].sort((a, b) => b.peakSeverity - a.peakSeverity).slice(0, 5);
    for (const run of runs) {
      const i = run.indices[Math.max(0, run.apexStart - 3)];
      const p = this.edgeOffset(i, run.turnSign, 40);
      if (!this.occ.free(p.x, p.y, 10) || this.terrain.trackDistance(p.x, p.y) < this.half + 30) continue;
      this.occ.add(p.x, p.y, 10);
      this.kit.add("tv_platform", p.x, this.ground(p.x, p.y), p.y, s[i].tangent + Math.PI / 2, 1.3);
    }
  }

  /**
   * Sign gantries spanning the track on the longest straights (the start one
   * included), like the refs' "Città / Parco" bridge.
   */
  private gantries(): void {
    const s = this.track.samples;
    const straights = [...this.layout.straights].sort((a, b) => this.runLength(b.indices) - this.runLength(a.indices)).slice(0, 3);
    for (const st of straights) {
      // Clear of the pit lane (a post would stand in it) and of crossings.
      const i = [0.62, 0.8, 0.45, 0.9, 0.3]
        .map((f) => st.indices[Math.floor(st.indices.length * f)])
        .find((i) => !this.track.nearSelf[i] && !this.pit.window.has(i));
      if (i === undefined) continue;
      const p = s[i];
      // From the real asphalt edge (edgeOffset clamps the width, and a wide
      // pit straight would put a post on the road).
      const post = (sgn: number) => {
        const w = this.track.hw[sgn > 0 ? 0 : 1][i] + 16;
        const x = p.x + p.nx * sgn * w;
        const y = p.y + p.ny * sgn * w;
        return { x, y, h: p.h };
      };
      const l = post(1);
      const r = post(-1);
      const span = Math.hypot(l.x - r.x, l.y - r.y);
      for (const e of [l, r]) this.kit.add("gantry_post", e.x, Math.min(e.h, this.ground(e.x, e.y)), e.y, p.tangent, 1.25);
      const beamH = p.h;
      const mx = (l.x + r.x) / 2;
      const my = (l.y + r.y) / 2;
      this.kit.add("gantry_beam", mx, beamH, my, p.tangent, new Vector3(1.25, 1.25, span / PROP_SCALE));
      for (const u of [-span * 0.22, span * 0.22]) {
        this.kit.add("sign_panel", mx + p.nx * u, beamH, my + p.ny * u, p.tangent, 1.25);
      }
    }
  }

  /** Billboards on legs behind a few corners. */
  private billboards(): void {
    const s = this.track.samples;
    for (const run of this.layout.runs) {
      if (this.rand() < 0.35) continue;
      const i = run.indices[run.indices.length >> 1];
      const out = -run.turnSign;
      const p = this.edgeOffset(i, out, CONFIG.scenery.runOffWidth + 70);
      if (!this.occ.free(p.x, p.y, 18) || this.terrain.trackDistance(p.x, p.y) < this.half + 80) continue;
      this.occ.add(p.x, p.y, 18);
      const heading = Math.atan2(-s[i].ny * out, -s[i].nx * out);
      this.kit.add("billboard", p.x, this.ground(p.x, p.y), p.y, heading, 1.15, this.pick(TEAM));
    }
  }
}
