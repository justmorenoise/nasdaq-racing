import {
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  ShapeUtils,
  Vector2,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CONFIG } from "../config";
import { UNITS_PER_METRE, type Track } from "../track/Track";
import type { Pt } from "../track/centerline";
import type { TrackLayout } from "../track/corners";
import { FlatBatch, type Pt3 } from "./FlatBatch";
import { pitInfo, type PitInfo } from "./pitInfo";
import { smoothCircular } from "../track/racingLine";
import { Solids } from "./Solids";
import type { Terrain } from "./Terrain";
import type { OsmWorld } from "./osm";
import { asphaltTexture, gravelTexture } from "./textures";

/** Heights above the local track surface for each stacked layer. */
const LIFT = { asphalt: 0.6, line: 0.72, kerbIn: 0.7, kerbOut: 1.3, verge: 0.5, vergeOut: 0.05, runoffIn: 0.1, runoffOut: -0.9 };

const KERB_RED = 0xc8412f;
const KERB_WHITE = 0xf1efe8;
const VERGE_CORNER = 0x4f8f5c; // painted green strip beyond the kerbs (refs)
const VERGE_STRAIGHT = 0x7c9b56;
const SPONSOR = [0x1f3f7a, 0xe6b422, 0xc8412f, 0xf1efe8, 0x23262b, 0x2f7a4f];

const gridKey = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

function resampleByDistance(line: Pt3[], step: number): Pt3[] {
  if (line.length < 2) return line.slice();
  const out: Pt3[] = [line[0]];
  let acc = 0;
  for (let i = 1; i < line.length; i++) {
    let a = line[i - 1];
    const b = line[i];
    let seg = Math.hypot(b.x - a.x, b.y - a.y);
    while (acc + seg >= step) {
      const t = (step - acc) / seg;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, h: a.h + (b.h - a.h) * t };
      out.push(p);
      a = p;
      seg = Math.hypot(b.x - a.x, b.y - a.y);
      acc = 0;
    }
    acc += seg;
  }
  return out;
}


/**
 * The racing surface as 3D meshes following the real elevation: an asphalt
 * ribbon with a rubbered-in racing line, white edge lines all round, raised
 * red/white kerbs with a green painted strip behind them, gravel or tarmac
 * run-off at corners, checkered start/finish and grid boxes, tyre walls, and
 * concrete walls with sponsor banners and catch fences along the straights.
 * Overpasses (Suzuka) get parapets and piers.
 */
export class TrackMesh {
  readonly group = new Group();
  private batch = new FlatBatch();
  private solids = new Solids();
  private n: number;
  private hw: [Float32Array, Float32Array]; // [left, right] smoothed half-widths
  private racing: number[];
  /** Smoothed signed curvature per sample (for inside-of-bend offset limits). */
  private kSm: number[];
  /** Free room beyond each edge [left, right] per sample: up to the midline
   *  toward any other stretch of track, and the turning radius on the inside. */
  private reach!: [Float32Array, Float32Array];
  private sGrid = new Map<number, number[]>();
  /** Samples inside a tunnel (no trackside dressing there). */
  private covered!: Uint8Array;
  /** Tunnel roof + what stands on it; faded by the app while chasing a car inside. */
  readonly tunnelRoof = new Group();
  private kerbAt: [Uint8Array, Uint8Array];
  private pit: PitInfo;
  private fence: number[] = [];
  /** Distance beyond each edge [left, right] to the first mapped barrier (OSM
   *  walls, rails, fences) on a real layout; 0 where none is mapped. */
  private bar: [Float32Array, Float32Array] | null = null;

  constructor(
    private track: Track,
    private layout: TrackLayout,
    private terrain: Terrain,
    private osm: OsmWorld | null = null,
  ) {
    this.n = track.samples.length - 1;
    this.hw = track.hw;
    this.racing = this.racingLine();
    this.kSm = smoothCircular(track.samples.slice(0, this.n).map((p) => p.signedCurvature), 3, 3);
    this.computeReach();
    this.computeBarriers();
    this.covered = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) this.covered[i] = track.inTunnel(track.samples[i].dist) ? 1 : 0;
    this.kerbAt = [new Uint8Array(this.n), new Uint8Array(this.n)];
    this.pit = pitInfo(track);

    this.asphalt();
    this.edgeLines();
    this.kerbs();
    this.verges();
    this.runOff();
    if (this.osmGravel) this.realGravel();
    this.pitRoad();
    this.startFinish();
    this.barriers();
    this.bridges();
    this.tunnel();

    const sc = CONFIG.scenery;
    const surf = this.batch.build({
      runoffGravel: { material: new MeshLambertMaterial({ map: gravelTexture(), vertexColors: true }), tile: sc.gravelTile },
      runoffTarmac: { material: new MeshLambertMaterial({ map: asphaltTexture(), vertexColors: true, color: 0xb9b9b9 }), tile: sc.asphaltTile },
      asphalt: { material: new MeshLambertMaterial({ map: asphaltTexture(), vertexColors: true }), tile: sc.asphaltTile },
      paint: { material: new MeshLambertMaterial({ vertexColors: true }) },
    });
    this.group.add(surf);
    this.group.add(this.solids.build());
    this.group.add(this.tireWalls());
    if (this.fence.length) this.group.add(this.fenceMesh());
  }

  /** Enough real gravel traps mapped to use them instead of guessing. */
  private get osmGravel(): boolean {
    return !this.track.def.street && (this.osm?.raw.gravel.length ?? 0) >= 8;
  }

  /** OSM gravel traps near the track, draped on the ground beside it. */
  private realGravel(): void {
    const reach = this.track.def.width / 2 + 260;
    for (const poly of this.osm!.raw.gravel) {
      const pts = this.osm!.mapLine(poly, 3);
      if (pts.length < 3) continue;
      if (!pts.some((p) => this.terrain.trackDistance(p.x, p.y) < reach)) continue;
      const tris = ShapeUtils.triangulateShape(pts.map((p) => new Vector2(p.x, p.y)), []);
      const P = (i: number): Pt3 => ({ x: pts[i].x, y: pts[i].y, h: this.terrain.heightAt(pts[i].x, pts[i].y) + 1.0 });
      for (const [a, b, c] of tris) this.batch.tri("runoffGravel", P(a), P(b), P(c));
    }
  }

  /**
   * The real pit lane, entry to exit, as a road draped beside the track (the
   * paddock builder adds the pit wall and garages along its straight part).
   * Stops short of the racing surface where it merges.
   */
  private pitRoad(): void {
    const lane = this.track.def.pitLane;
    if (!lane || lane.length < 4) return;
    const w = 10 * UNITS_PER_METRE;
    const off = this.track.def.width / 2 + w / 2;
    const runs: Pt[][] = [[]];
    for (const p of lane) {
      if (this.terrain.trackDistance(p.x, p.y) < off) {
        if (runs[runs.length - 1].length) runs.push([]);
      } else runs[runs.length - 1].push(p);
    }
    const ground = (x: number, y: number) => this.terrain.heightAt(x, y) + 1.0;
    for (const run of runs) if (run.length >= 2) this.batch.drapedStrip("runoffTarmac", run, w, ground, 0.1, 0x9b9b9b);
  }

  private get street(): boolean {
    return !!this.track.def.street;
  }

  private side(sgn: number): 0 | 1 {
    return sgn >= 0 ? 0 : 1;
  }

  /** Rubbered line as a lateral fraction of the half-width: the cars' racing line. */
  private racingLine(): number[] {
    const t = this.track;
    return Array.from(t.racing, (o, i) => (o >= 0 ? o / t.hw[0][i] : o / t.hw[1][i]));
  }

  /** A point `d` outward from the edge on `sgn` (+1 = +normal) at sample `i`, lifted. */
  private edge(i: number, sgn: number, d: number, lift: number): Pt3 {
    const k = i % this.n;
    const s = this.track.samples[k];
    const w = this.hw[this.side(sgn)][k] + (d > 0 ? Math.min(d, this.reach[this.side(sgn)][k]) : d);
    return { x: s.x + s.nx * sgn * w, y: s.y + s.ny * sgn * w, h: s.h + lift };
  }

  /** Room beyond the edge at sample `i` on side `sgn`. */
  private room(i: number, sgn: number): number {
    const k = i % this.n;
    return this.covered?.[k] ? 0 : this.reach[this.side(sgn)][k];
  }

  /**
   * Distance from `p` to the asphalt of any *other* stretch of track (samples
   * far from `own` along the lap), or Infinity when none is near.
   */
  private otherClearance(p: Pt, own: number): number {
    const s = this.track.samples;
    const L = this.track.length;
    const sep = Math.max(this.track.def.width * 4, 160);
    const c = 60;
    const ci = Math.floor(p.x / c);
    const cj = Math.floor(p.y / c);
    let best = Infinity;
    for (let a = -3; a <= 3; a++) {
      for (let b = -3; b <= 3; b++) {
        for (const j of this.sGrid.get(gridKey(ci + a, cj + b)) ?? []) {
          const da = Math.abs(s[j].dist - s[own].dist);
          if (Math.min(da, L - da) < sep) continue;
          const d = Math.hypot(p.x - s[j].x, p.y - s[j].y) - Math.max(this.hw[0][j], this.hw[1][j]);
          if (d < best) best = d;
        }
      }
    }
    return best;
  }

  /**
   * How far trackside dressing may extend beyond each edge: stop at the
   * midline toward another stretch of track (hairpins, Monaco's Mirabeau,
   * parallel straights) so nothing reaches its kerbs or asphalt, and at the
   * turning radius on the inside of a bend so strips never fold over.
   */
  private computeReach(): void {
    const s = this.track.samples;
    for (let i = 0; i < this.n; i++) {
      const k = gridKey(Math.floor(s[i].x / 60), Math.floor(s[i].y / 60));
      const l = this.sGrid.get(k) ?? [];
      l.push(i);
      this.sGrid.set(k, l);
    }
    const real = !!this.track.def.realGeometry;
    const max = real ? 100 * UNITS_PER_METRE : 140;
    const step = real ? 6 : 3;
    this.reach = [new Float32Array(this.n), new Float32Array(this.n)];
    for (const sgn of [1, -1]) {
      const side = this.side(sgn);
      const raw = new Float32Array(this.n);
      for (let i = 0; i < this.n; i++) {
        const p = s[i];
        const hw = this.hw[side][i];
        let r = max;
        if (sgn * this.kSm[i] > 0) r = Math.min(r, Math.max(0, 0.82 / Math.abs(this.kSm[i]) - hw));
        for (let d = 0; d <= r; d += step) {
          const q = { x: p.x + p.nx * sgn * (hw + d), y: p.y + p.ny * sgn * (hw + d) };
          if (this.otherClearance(q, i) < d + 4) {
            r = Math.max(0, d - 4);
            break;
          }
        }
        raw[i] = r;
      }
      // A running minimum keeps neighbouring samples consistent (no spikes).
      for (let i = 0; i < this.n; i++) {
        let m = raw[i];
        for (let d = -3; d <= 3; d++) m = Math.min(m, raw[(i + d + this.n) % this.n]);
        this.reach[side][i] = m;
      }
    }
  }

  /**
   * Where the real barriers stand: from each edge, cast along the normal
   * against the mapped walls, guard rails and fences (roughly parallel to the
   * track only) and keep the first hit, then clean it up — a median filter,
   * short gaps bridged, isolated fragments dropped.
   */
  private computeBarriers(): void {
    const osm = this.osm;
    if (!osm || !this.track.def.realGeometry || this.street) return;
    const lines = [...osm.raw.walls, ...(osm.raw.fences ?? [])];
    if (!lines.length) return;
    const C = 40;
    const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
    const grid = new Map<number, number[]>();
    const seg: number[] = [];
    for (const line of lines) {
      const pts = line.map(([x, y]: [number, number]) => osm.mapRaw(x, y));
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1];
        const b = pts[k];
        const id = seg.length / 4;
        seg.push(a.x, a.y, b.x, b.y);
        for (let i = Math.floor(Math.min(a.x, b.x) / C); i <= Math.floor(Math.max(a.x, b.x) / C); i++) {
          for (let j = Math.floor(Math.min(a.y, b.y) / C); j <= Math.floor(Math.max(a.y, b.y) / C); j++) {
            const l = grid.get(key(i, j));
            if (l) l.push(id);
            else grid.set(key(i, j), [id]);
          }
        }
      }
    }
    const maxD = 90 * UNITS_PER_METRE;
    const stamp = new Int32Array(seg.length / 4).fill(-1);
    let tag = 0;
    this.bar = [new Float32Array(this.n), new Float32Array(this.n)];
    for (const sgn of [1, -1]) {
      const side = this.side(sgn);
      const raw = new Float32Array(this.n);
      for (let i = 0; i < this.n; i++) {
        const s = this.track.samples[i];
        const ux = s.nx * sgn;
        const uy = s.ny * sgn;
        const ox = s.x + ux * this.hw[side][i];
        const oy = s.y + uy * this.hw[side][i];
        const tx = Math.cos(s.tangent);
        const ty = Math.sin(s.tangent);
        let best = Infinity;
        tag++;
        for (let d = 0; d <= maxD && d < best; d += C / 2) {
          const cell = grid.get(key(Math.floor((ox + ux * d) / C), Math.floor((oy + uy * d) / C)));
          if (!cell) continue;
          for (const id of cell) {
            if (stamp[id] === tag) continue;
            stamp[id] = tag;
            const ax = seg[id * 4], ay = seg[id * 4 + 1];
            const ex = seg[id * 4 + 2] - ax, ey = seg[id * 4 + 3] - ay;
            const len = Math.hypot(ex, ey) || 1;
            if (Math.abs((ex * tx + ey * ty) / len) < 0.6) continue;
            const det = ex * uy - ux * ey;
            if (Math.abs(det) < 1e-9) continue;
            const qx = ax - ox;
            const qy = ay - oy;
            const t = (ex * qy - ey * qx) / det;
            const u = (ux * qy - uy * qx) / det;
            if (t > 2 * UNITS_PER_METRE && u >= 0 && u <= 1 && t < best) best = t;
          }
        }
        raw[i] = best <= maxD ? best : 0;
      }
      const n = this.n;
      const med = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const w: number[] = [];
        for (let d = -4; d <= 4; d++) {
          const v = raw[(i + d + n) % n];
          if (v > 0) w.push(v);
        }
        if (w.length < 5) continue;
        w.sort((a, b) => a - b);
        med[i] = w[w.length >> 1];
      }
      // Bridge gaps up to ~50 m, then drop fragments shorter than ~30 m.
      const gap = Math.round((50 * UNITS_PER_METRE) / (this.track.length / n));
      const frag = Math.round((30 * UNITS_PER_METRE) / (this.track.length / n));
      const out = this.bar[side];
      out.set(med);
      for (let i = 0; i < n; i++) {
        if (out[i] > 0 || !(out[(i - 1 + n) % n] > 0)) continue;
        let j = 1;
        while (j <= gap && !(med[(i + j) % n] > 0)) j++;
        if (j > gap) continue;
        const a = out[(i - 1 + n) % n];
        const b = med[(i + j) % n];
        for (let k = 0; k < j; k++) out[(i + k) % n] = a + ((b - a) * (k + 1)) / (j + 1);
      }
      for (let i = 0; i < n; i++) {
        if (!(out[i] > 0) || out[(i - 1 + n) % n] > 0) continue;
        let j = 0;
        while (j < n && out[(i + j) % n] > 0) j++;
        if (j < frag) for (let k = 0; k < j; k++) out[(i + k) % n] = 0;
      }
    }
  }

  /** Mapped barrier distance beyond the edge at sample `i` on side `sgn` (0 = none). */
  private barrierAt(i: number, sgn: number): number {
    return this.bar ? this.bar[this.side(sgn)][i % this.n] : 0;
  }

  /** Like `edge`, but resting on the ground once it leaves the road's shoulder. */
  private edgeOnGround(i: number, sgn: number, d: number, lift: number): Pt3 {
    const p = this.edge(i, sgn, d, lift);
    if (d > 6) p.h = this.terrain.heightAt(p.x, p.y) + 0.9 + lift;
    return p;
  }

  /** A point at lateral fraction u ∈ [-1, 1] across the asphalt. */
  private across(i: number, u: number, lift: number): Pt3 {
    const s = this.track.samples[i % this.n];
    const w = u >= 0 ? this.hw[0][i % this.n] * u : this.hw[1][i % this.n] * u;
    return { x: s.x + s.nx * w, y: s.y + s.ny * w, h: s.h + lift };
  }

  private grey(f: number): number {
    const v = Math.max(0, Math.min(255, Math.round(255 * f)));
    return (v << 16) | (v << 8) | v;
  }

  private asphalt(): void {
    const cols = [-1, -0.6, -0.25, 0, 0.25, 0.6, 1];
    const patches = CONFIG.scenery.tarmacPatches;
    const shade = (i: number, u: number) => {
      const frac = i / this.n;
      const patch = patches.some(([a, b]) => frac >= a && frac <= b) ? 0.86 : 1;
      const rubber = Math.exp(-((u - this.racing[i]) ** 2) / (2 * 0.16 * 0.16));
      const corner = Math.min(1, Math.abs(this.racing[i]) * 2.2);
      return this.grey(patch * (1 - rubber * (0.1 + 0.18 * corner)));
    };
    for (let i = 0; i < this.n; i++) {
      const j = i + 1;
      const jj = j % this.n;
      for (let c = 0; c < cols.length - 1; c++) {
        const u0 = cols[c];
        const u1 = cols[c + 1];
        this.batch.quad(
          "asphalt",
          this.across(i, u0, LIFT.asphalt),
          this.across(j, u0, LIFT.asphalt),
          this.across(j, u1, LIFT.asphalt),
          this.across(i, u1, LIFT.asphalt),
          0xffffff,
          [shade(i, u0), shade(jj, u0), shade(jj, u1), shade(i, u1)],
        );
      }
    }
  }

  private edgeLines(): void {
    for (const sgn of [1, -1]) {
      const line: Pt3[] = [];
      for (let i = 0; i <= this.n; i++) line.push(this.edge(i, sgn, -2.2, 0));
      this.batch.strip("paint", line, 1.7, LIFT.line, 0xf2f1ec);
    }
  }

  private splitAtCrossings(indices: number[]): number[][] {
    const ns = this.track.nearSelf;
    const out: number[][] = [];
    let cur: number[] = [];
    for (const i of indices) {
      if (ns[i]) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push(i);
    }
    if (cur.length) out.push(cur);
    return out;
  }

  private kerbs(): void {
    const ks = this.track.def.kerbScale ?? 1;
    const w = CONFIG.scenery.kerbWidth * ks * 1.2;
    const cell = CONFIG.scenery.kerbCellLen * ks;
    // Inside kerbs first (they matter most), then exit kerbs only where that
    // side has none yet — in a chicane the exit of one bend is the inside of the next.
    for (const run of this.layout.runs) {
      for (const seg of this.splitAtCrossings(run.indices)) this.kerbCells(seg, run.turnSign, w, cell);
    }
    for (const run of this.layout.runs) {
      const side = this.side(-run.turnSign);
      const free = run.indices.slice(run.apexEnd).filter((i) => !this.kerbAt[side][i]);
      for (const seg of this.splitAtCrossings(free)) this.kerbCells(seg, -run.turnSign, w, cell);
    }
  }

  /** Alternating red/white cells re-sampled at a fixed length along the kerb, raised at the outer lip. */
  private kerbCells(indices: number[], sgn: number, w: number, cell: number): void {
    // Split where indices jump (filtered runs), each piece drawn on its own.
    for (let k = 1; k < indices.length; k++) {
      if ((indices[k] - indices[k - 1] + this.n) % this.n !== 1) {
        this.kerbCells(indices.slice(0, k), sgn, w, cell);
        this.kerbCells(indices.slice(k), sgn, w, cell);
        return;
      }
    }
    if (indices.length < 2) return;
    // No room for the lip (tight gap to another stretch): leave it bare.
    const roomy = indices.filter((i) => this.room(i, sgn) >= w * 0.5);
    if (roomy.length < indices.length) {
      if (roomy.length >= 2) this.kerbCells(roomy, sgn, w, cell);
      return;
    }
    for (const i of indices) this.kerbAt[this.side(sgn)][i] = 1;
    const inner = indices.map((i) => this.edge(i, sgn, -w * 0.25, LIFT.kerbIn));
    const outer = indices.map((i) => this.edge(i, sgn, w * 0.75, LIFT.kerbOut));
    const cum = [0];
    for (let k = 1; k < inner.length; k++) {
      cum[k] = cum[k - 1] + Math.hypot(inner[k].x - inner[k - 1].x, inner[k].y - inner[k - 1].y);
    }
    const total = cum[cum.length - 1];
    if (total < 1e-3) return;
    const at = (arc: number) => {
      let k = 1;
      while (k < cum.length - 1 && cum[k] < arc) k++;
      const t = (arc - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
      const lerp = (p: Pt3, q: Pt3) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, h: p.h + (q.h - p.h) * t });
      return { a: lerp(inner[k - 1], inner[k]), b: lerp(outer[k - 1], outer[k]) };
    };
    let pos = 0;
    let idx = 0;
    while (pos < total - 1e-3) {
      const p = at(pos);
      const q = at(Math.min(pos + cell, total));
      // Skip a cell whose outer lip runs backwards (still folded after the cap).
      const inX = q.a.x - p.a.x;
      const inY = q.a.y - p.a.y;
      const outX = q.b.x - p.b.x;
      const outY = q.b.y - p.b.y;
      if (inX * outX + inY * outY > 0) this.batch.quad("paint", p.a, q.a, q.b, p.b, idx % 2 === 0 ? KERB_RED : KERB_WHITE);
      pos += cell;
      idx++;
    }
  }

  /** Painted strip hugging both edges: green behind kerbs, grass-toned elsewhere. */
  private verges(): void {
    const ks = this.track.def.kerbScale ?? 1;
    const kw = CONFIG.scenery.kerbWidth * ks * 1.2 * 0.75;
    for (const sgn of [1, -1]) {
      const side = this.side(sgn);
      for (let i = 0; i < this.n; i++) {
        const j = (i + 1) % this.n;
        if (this.track.nearSelf[i] || this.track.nearSelf[j]) continue;
        if (sgn === this.pit.side && (this.pit.window.has(i) || this.pit.window.has(j))) continue;
        const k0 = this.kerbAt[side][i] ? kw : 0;
        const k1 = this.kerbAt[side][j] ? kw : 0;
        if (Math.min(this.room(i, sgn), this.room(j, sgn)) < Math.max(k0, k1) + 3) continue;
        if (this.street) {
          // Street circuit: a raised pavement behind the barrier line.
          const s0 = k0 + 4;
          const s1 = k1 + 4;
          this.batch.quad("paint", this.edge(i, sgn, s0, 1.4), this.edge(i + 1, sgn, s1, 1.4), this.edge(i + 1, sgn, s1 + 14, 1.4), this.edge(i, sgn, s0 + 14, 1.4), 0xc9c4b8);
          continue;
        }
        const col = this.kerbAt[side][i] ? VERGE_CORNER : VERGE_STRAIGHT;
        this.batch.quad(
          "paint",
          this.edge(i, sgn, k0, LIFT.verge),
          this.edge(i + 1, sgn, k1, LIFT.verge),
          this.edgeOnGround(i + 1, sgn, k1 + 9, LIFT.vergeOut),
          this.edgeOnGround(i, sgn, k0 + 9, LIFT.vergeOut),
          col,
        );
      }
    }
  }

  /** Run-off on the outside of every corner: gravel at the sharpest, tarmac elsewhere. */
  private runOff(): void {
    const w = CONFIG.scenery.runOffWidth;
    const bySeverity = [...this.layout.runs].sort((a, b) => b.peakSeverity - a.peakSeverity);
    const gravel = new Set(bySeverity.slice(0, Math.ceil(bySeverity.length * 0.6)));
    // A street circuit has escape roads only at a few big stops, all tarmac.
    const runs = this.street ? bySeverity.slice(0, 3) : this.layout.runs;
    for (const run of runs) {
      const sgn = -run.turnSign;
      const m = run.indices.length;
      const key = gravel.has(run) && !this.street && !this.osmGravel ? "runoffGravel" : "runoffTarmac";
      const start = this.street ? 4 : 12;
      const width = this.street ? w * 0.5 : this.osmGravel ? w * 0.55 : w;
      for (let k = 1; k < m; k++) {
        const i0 = run.indices[k - 1];
        const i1 = run.indices[k];
        if (this.track.nearSelf[i0] || this.track.nearSelf[i1]) continue;
        const t0 = Math.sin((Math.PI * (k - 1)) / (m - 1 || 1));
        const t1 = Math.sin((Math.PI * k) / (m - 1 || 1));
        if (t0 < 0.05 && t1 < 0.05) continue;
        // Up to the real barrier where one is mapped (the run-off's true depth),
        // never spilling onto another stretch of track.
        const reach = (i: number, t: number) => {
          const b = this.barrierAt(i, sgn);
          const want = b > 0 ? (b - start - 2 * UNITS_PER_METRE) * Math.min(1, t * 3) : width * t;
          const r = Math.min(want, this.room(i, sgn) - start);
          return r > 2 ? r : 0;
        };
        const r0 = reach(i0, t0);
        const r1 = reach(i1, t1);
        if (r0 === 0 && r1 === 0) continue;
        this.batch.quad(
          key,
          this.edge(i0, sgn, start, LIFT.runoffIn),
          this.edge(i1, sgn, start, LIFT.runoffIn),
          this.edgeOnGround(i1, sgn, start + r1, LIFT.runoffOut + 0.4),
          this.edgeOnGround(i0, sgn, start + r0, LIFT.runoffOut + 0.4),
        );
      }
    }
  }

  /** Checkered band on the line and painted grid boxes behind it. */
  private startFinish(): void {
    const track = this.track;
    const pose = track.poseAt(track.startDist);
    const half = track.def.width / 2;
    const cols = 8;
    const cw = (half * 2) / cols;
    const ax = Math.cos(pose.tangent);
    const ay = Math.sin(pose.tangent);
    const at = (across: number, along: number): Pt3 => ({
      x: pose.x + pose.nx * across + ax * along,
      y: pose.y + pose.ny * across + ay * along,
      h: pose.h + LIFT.line,
    });
    for (let row = 0; row < 2; row++) {
      for (let c = 0; c < cols; c++) {
        const u = -half + c * cw;
        const v = row === 0 ? -cw : 0;
        this.batch.quad("paint", at(u, v), at(u, v + cw), at(u + cw, v + cw), at(u + cw, v), (row + c) % 2 ? 0xf2f1ec : 0x1c1e22);
      }
    }
    const gap = track.def.width * 0.85;
    for (let i = 0; i < 20; i++) {
      const d = track.startDist - i * gap - gap * 0.35;
      const p = track.poseAt(d);
      const lane = (i % 2 === 0 ? -0.4 : 0.4) * half;
      const tx = Math.cos(p.tangent);
      const ty = Math.sin(p.tangent);
      const cx = p.x + p.nx * lane;
      const cy = p.y + p.ny * lane;
      const hw = half * 0.28;
      const P = (x: number, y: number): Pt3 => ({ x, y, h: p.h });
      this.batch.strip("paint", [P(cx - p.nx * hw, cy - p.ny * hw), P(cx + p.nx * hw, cy + p.ny * hw)], 1.6, LIFT.line, 0xf2f1ec);
      for (const sgn of [-1, 1]) {
        const e = P(cx + p.nx * hw * sgn, cy + p.ny * hw * sgn);
        this.batch.strip("paint", [e, P(e.x - tx * gap * 0.3, e.y - ty * gap * 0.3)], 1.6, LIFT.line, 0xf2f1ec);
      }
    }
  }

  /**
   * Concrete walls wearing sponsor banners on both sides of every straight
   * (behind the verge), with a catch fence on top; skipped along the pit lane
   * and wherever another part of the track is closer.
   */
  private barriers(): void {
    if (this.street) {
      this.streetBarriers();
      return;
    }
    const g = this.solids;
    // Mapped barriers where OSM has them; elsewhere a wall along the straights.
    const onStraight = new Set(this.layout.straights.flatMap((st) => st.indices));
    const spans = this.bar ? [Array.from({ length: this.n + 1 }, (_, i) => i % this.n)] : this.layout.straights.map((st) => st.indices);
    for (const idx of spans) {
      for (const sgn of [1, -1]) {
        const offAt = (i: number) => {
          const want = this.barrierAt(i, sgn) || (onStraight.has(i) ? 14 : 0);
          return want ? Math.min(want, this.room(i, sgn) - 2) : 0;
        };
        let color = SPONSOR[(idx[0] + (sgn > 0 ? 0 : 3)) % SPONSOR.length];
        for (let k = 1; k < idx.length; k++) {
          const i0 = idx[k - 1];
          const i1 = idx[k];
          if (this.track.nearSelf[i0] || this.track.nearSelf[i1]) continue;
          if (sgn === this.pit.side && (this.pit.window.has(i0) || this.pit.window.has(i1))) continue;
          const o0 = offAt(i0);
          const o1 = offAt(i1);
          if (o0 < 10 || o1 < 10 || Math.abs(o0 - o1) > 24) continue;
          const a = this.edge(i0, sgn, o0, 0);
          const b = this.edge(i1, sgn, o1, 0);
          if (k % 7 === 0) color = SPONSOR[Math.floor(k / 7 + i0) % SPONSOR.length];
          // Base down to whatever the ground does beside the road.
          const ga = Math.min(a.h, this.terrain.heightAt(a.x, a.y)) - 1.5;
          const gb = Math.min(b.h, this.terrain.heightAt(b.x, b.y)) - 1.5;
          g.prism(
            this.wallFoot(a, b, 1.8),
            [ga, gb, gb, ga],
            [a.h + 5, b.h + 5, b.h + 5, a.h + 5],
            0xc9c6be,
            0xd8d5ce,
          );
          const fa = this.edge(i0, sgn, o0 - 1, 0);
          const fb = this.edge(i1, sgn, o1 - 1, 0);
          g.wall(fa, fb, fa.h, fb.h, 0.25, 0.8, 4.4, color);
          this.fence.push(a.x, a.h + 5, a.y, b.x, b.h + 5, b.y);
        }
      }
    }
  }

  /** Footprint of a wall of `thick` along a→b. */
  private wallFoot(a: Pt, b: Pt, thick: number): Pt[] {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (-(b.y - a.y) / len) * (thick / 2);
    const ny = ((b.x - a.x) / len) * (thick / 2);
    return [
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ];
  }

  /**
   * Street circuit: Armco guard rail right behind the kerb line on both sides
   * of the whole lap (posts + two steel rails), catch fences along the
   * straights, gaps only at the pit lane and where another stretch is closer.
   */
  private streetBarriers(): void {
    const g = this.solids;
    const ks = this.track.def.kerbScale ?? 1;
    const kw = CONFIG.scenery.kerbWidth * ks * 1.2 * 0.75;
    const straight = new Set(this.layout.straights.flatMap((st) => st.indices));
    for (const sgn of [1, -1]) {
      const side = this.side(sgn);
      for (let i = 0; i < this.n; i++) {
        const j = (i + 1) % this.n;
        if (this.track.nearSelf[i] || this.track.nearSelf[j]) continue;
        if (sgn === this.pit.side && (this.pit.window.has(i) || this.pit.window.has(j))) continue;
        const off0 = (this.kerbAt[side][i] ? kw : 0) + 2.5;
        const off1 = (this.kerbAt[side][j] ? kw : 0) + 2.5;
        if (this.room(i, sgn) < off0 + 1 || this.room(j, sgn) < off1 + 1) continue;
        const a = this.edge(i, sgn, off0, 0);
        const b = this.edge(i + 1, sgn, off1, 0);
        for (const [lo, hi] of [[2.2, 3.2], [3.8, 4.8]]) g.wall(a, b, a.h, b.h, 0.5, lo, hi, 0xb4bbc2, 0xcfd4d9);
        if (i % 2 === 0) g.wall(a, { x: a.x + (b.x - a.x) * 0.1, y: a.y + (b.y - a.y) * 0.1 }, a.h, a.h, 0.8, 0, 5, 0x8e969e);
        if (straight.has(i)) this.fence.push(a.x, a.h + 5, a.y, b.x, b.h + 5, b.y);
      }
    }
  }

  /**
   * Posts plus a wire net along every fenced wall. The net is line geometry:
   * it reads as mesh from any distance and stays out of the AO pass (which
   * would darken the ground behind a see-through panel).
   */
  private fenceMesh(): Group {
    const g = new Group();
    const H = 15;
    const wires: number[] = [];
    const posts: Matrix4[] = [];
    for (let k = 0; k < this.fence.length; k += 6) {
      const [ax, ah, az, bx, bh, bz] = this.fence.slice(k, k + 6);
      for (let z = 0; z <= H; z += 2.5) wires.push(ax, ah + z, az, bx, bh + z, bz);
      wires.push(ax, ah, az, ax, ah + H, az);
      if ((k / 6) % 3 === 0) posts.push(new Matrix4().makeTranslation(ax, ah + H / 2, az));
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(wires, 3));
    g.add(new LineSegments(geo, new LineBasicMaterial({ color: 0x8f989f, transparent: true, opacity: 0.55 })));
    const pm = new InstancedMesh(new CylinderGeometry(0.35, 0.35, H, 5), new MeshLambertMaterial({ color: 0x8e969e }), posts.length);
    posts.forEach((m, i) => pm.setMatrixAt(i, m));
    pm.castShadow = true;
    g.add(pm);
    return g;
  }

  /**
   * Tunnels: side walls with a strip of lights, and a roof slab (a terrace
   * garden, with the hotel above at the entrance — Monaco's tunnel runs under
   * the Fairmont). The roof is its own group so the app can fade it while the
   * camera follows a car through.
   */
  private tunnel(): void {
    if (!this.track.tunnels.length) return;
    const walls = new Solids();
    const roof = new Solids();
    const H = 16;
    const runs: number[][] = [];
    let cur: number[] = [];
    for (let i = 0; i <= this.n; i++) {
      const k = i % this.n;
      if (i < this.n && this.covered[k]) cur.push(k);
      else if (cur.length) {
        runs.push(cur);
        cur = [];
      }
    }
    for (const run of runs) {
      for (let k = 1; k < run.length; k++) {
        const i0 = run[k - 1];
        const i1 = run[k];
        for (const sgn of [1, -1]) {
          const a = this.edge(i0, sgn, 1.5, 0);
          const b = this.edge(i1, sgn, 1.5, 0);
          walls.wall(a, b, a.h, b.h, 3, -2, H, 0xb8b2a6, 0xa9a397);
          // Lights: a warm strip along the inner face of each wall.
          const la = this.edge(i0, sgn, -0.2, 0);
          const lb = this.edge(i1, sgn, -0.2, 0);
          if (k % 2 === 0) walls.wall(la, lb, la.h, lb.h, 0.4, H - 4, H - 3, 0xffe2a0);
        }
        const l0 = this.edge(i0, 1, 5, 0);
        const l1 = this.edge(i1, 1, 5, 0);
        const r1 = this.edge(i1, -1, 5, 0);
        const r0 = this.edge(i0, -1, 5, 0);
        const h0 = l0.h + H;
        const h1 = l1.h + H;
        roof.prism([l0, l1, r1, r0], [h0, h1, h1, h0], [h0 + 3, h1 + 3, h1 + 3, h0 + 3], 0xb1ab9f, 0x7f9f5a);
      }
      // The hotel over the tunnel mouth: a long block following the road.
      const hotel = run.slice(0, Math.max(2, Math.floor(run.length * 0.45)));
      for (let k = 1; k < hotel.length; k++) {
        const i0 = hotel[k - 1];
        const i1 = hotel[k];
        const l0 = this.edge(i0, 1, 2, 0);
        const l1 = this.edge(i1, 1, 2, 0);
        const r1 = this.edge(i1, -1, 2, 0);
        const r0 = this.edge(i0, -1, 2, 0);
        const b0 = l0.h + H + 3;
        const b1 = l1.h + H + 3;
        roof.prism([l0, l1, r1, r0], [b0, b1, b1, b0], [b0 + 34, b1 + 34, b1 + 34, b0 + 34], k % 3 === 0 ? 0x3e4e5c : 0xe9e2d4, 0xcfc9bd);
      }
    }
    this.group.add(walls.build());
    const roofMesh = roof.build();
    const mat = roofMesh.material as MeshLambertMaterial;
    mat.transparent = true;
    this.tunnelRoof.add(roofMesh);
    this.group.add(this.tunnelRoof);
  }

  /** Fade the tunnel roof (0 = gone, 1 = solid). */
  setTunnelOpacity(o: number): void {
    for (const m of this.tunnelRoof.children as Mesh[]) {
      const mat = m.material as MeshLambertMaterial;
      mat.opacity = o;
      mat.depthWrite = o > 0.9;
      m.visible = o > 0.02;
    }
  }

  /** Parapets and piers where the track passes over another stretch of itself. */
  private bridges(): void {
    const s = this.track.samples;
    const L = this.track.length;
    for (let i = 0; i < this.n; i++) {
      if (!this.track.nearSelf[i]) continue;
      let lower = Infinity;
      for (let j = 0; j < this.n; j += 2) {
        const da = Math.abs(s[i].dist - s[j].dist);
        if (Math.min(da, L - da) < L * 0.08) continue;
        if (Math.hypot(s[i].x - s[j].x, s[i].y - s[j].y) < this.track.def.width * 1.6) lower = Math.min(lower, s[j].h);
      }
      if (!(s[i].h - lower > 6)) continue;
      for (const sgn of [1, -1]) {
        const a = this.edge(i, sgn, 1, 0);
        const b = this.edge(i + 1, sgn, 1, 0);
        this.solids.wall(a, b, a.h, b.h, 2, -5, 4, 0xbdb9b0, 0xd6d3cb);
        if (i % 5 === 0) {
          const p = this.edge(i, sgn, -2, 0);
          this.solids.box(p.x, p.y, 1, 0, 2.2, 2.2, lower - 2, p.h - 4, 0xb2aea5);
        }
      }
    }
  }

  /**
   * Tyre barriers at the outer edge of each corner's run-off (central span),
   * packed side by side; groups too short or tangling with another corner's
   * wall are dropped. Stacks of four, black with the odd red/white band.
   */
  private tireWalls(): Group {
    const g = new Group();
    const sc = CONFIG.scenery;
    const r = sc.tireRadius * 0.6;
    const minSep = sc.tireRadius * 2 * 1.6;
    const top = new Set([...this.layout.runs].sort((a, b) => b.peakSeverity - a.peakSeverity).slice(0, 3));
    const runPts: Pt3[][] = this.layout.runs.map((run) => {
      if (this.street && !top.has(run)) return [];
      const m = run.indices.length;
      const reach = this.street ? 4 + sc.runOffWidth * 0.5 + 3 : 12 + sc.runOffWidth + 4;
      // Wall at the back of the run-off, or as far as the room allows (never
      // into another stretch's space); skipped where there's barely any room.
      const idx = run.indices
        .slice(Math.floor(m * 0.25), Math.ceil(m * 0.75))
        .filter((i) => !this.track.nearSelf[i] && this.room(i, -run.turnSign) >= 14 + r);
      if (idx.length < 2) return [];
      const line = idx.map((i) => {
        const b = this.barrierAt(i, -run.turnSign);
        return this.edge(i, -run.turnSign, Math.min(b > 0 ? b - r * 1.2 : reach, this.room(i, -run.turnSign) - r), 0);
      });
      return resampleByDistance(line, r * 2);
    });
    const keep = runPts.map((pts) => pts.map(() => true));
    for (let a = 0; a < runPts.length; a++) {
      for (let b = a + 1; b < runPts.length; b++) {
        for (let i = 0; i < runPts[a].length; i++) {
          for (let j = 0; j < runPts[b].length; j++) {
            if (Math.hypot(runPts[a][i].x - runPts[b][j].x, runPts[a][i].y - runPts[b][j].y) < minSep) {
              keep[a][i] = false;
              keep[b][j] = false;
            }
          }
        }
      }
    }
    const tyres: { p: Pt3; band: number }[] = [];
    for (let a = 0; a < runPts.length; a++) {
      let group: Pt3[] = [];
      const flush = () => {
        if (group.length >= 5) group.forEach((p, k) => tyres.push({ p, band: k % 6 === 0 ? 0xc8412f : k % 6 === 3 ? 0xf1efe8 : 0 }));
        group = [];
      };
      runPts[a].forEach((c, i) => (keep[a][i] ? group.push(c) : flush()));
      flush();
    }
    if (!tyres.length) return g;
    const stack = 4;
    const h = r * 0.62;
    const geo = mergeGeometries([
      new CylinderGeometry(r, r, h * 0.92, 10, 1).deleteAttribute("uv"),
      new CylinderGeometry(r * 0.5, r * 0.5, h * 0.95, 8, 1).deleteAttribute("uv"),
    ]);
    const mesh = new InstancedMesh(geo, new MeshLambertMaterial({ flatShading: true }), tyres.length * stack);
    const m = new Matrix4();
    const black = new Color(0x1f2126);
    const c = new Color();
    let k = 0;
    for (const t of tyres) {
      const base = this.terrain.heightAt(t.p.x, t.p.y) + 0.4;
      for (let lvl = 0; lvl < stack; lvl++) {
        m.makeTranslation(t.p.x, base + h / 2 + lvl * h, t.p.y);
        mesh.setMatrixAt(k, m);
        mesh.setColorAt(k, t.band && lvl === stack - 2 ? c.setHex(t.band) : black);
        k++;
      }
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    return g;
  }
}
