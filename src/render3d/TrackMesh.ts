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
  MeshLambertMaterial,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CONFIG } from "../config";
import type { Track } from "../track/Track";
import type { Pt } from "../track/centerline";
import type { TrackLayout } from "../track/corners";
import { FlatBatch, type Pt3 } from "./FlatBatch";
import { pitInfo } from "./pitInfo";
import { Solids } from "./Solids";
import type { Terrain } from "./Terrain";
import { asphaltTexture, gravelTexture } from "./textures";

/** Heights above the local track surface for each stacked layer. */
const LIFT = { asphalt: 0.6, line: 0.72, kerbIn: 0.7, kerbOut: 1.3, verge: 0.5, vergeOut: 0.05, runoffIn: 0.1, runoffOut: -0.9 };

const KERB_RED = 0xc8412f;
const KERB_WHITE = 0xf1efe8;
const VERGE_CORNER = 0x4f8f5c; // painted green strip beyond the kerbs (refs)
const VERGE_STRAIGHT = 0x7c9b56;
const SPONSOR = [0x1f3f7a, 0xe6b422, 0xc8412f, 0xf1efe8, 0x23262b, 0x2f7a4f];

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

/** Circular moving median + mean, to strip spikes from per-sample widths. */
function smoothCircular(v: number[], med: number, avg: number): number[] {
  const n = v.length;
  const m = v.map((_, i) => {
    const w: number[] = [];
    for (let d = -med; d <= med; d++) w.push(v[(i + d + n) % n]);
    w.sort((a, b) => a - b);
    return w[w.length >> 1];
  });
  return m.map((_, i) => {
    let s = 0;
    for (let d = -avg; d <= avg; d++) s += m[(i + d + n) % n];
    return s / (avg * 2 + 1);
  });
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
  private hw: [number[], number[]]; // [left, right] smoothed half-widths
  private racing: number[];
  private kerbAt: [Uint8Array, Uint8Array];
  private pit: { window: Set<number>; side: number };
  private fence: number[] = [];

  constructor(
    private track: Track,
    private layout: TrackLayout,
    private terrain: Terrain,
  ) {
    this.n = track.samples.length - 1;
    this.hw = this.halfWidths();
    this.racing = this.racingLine();
    this.kerbAt = [new Uint8Array(this.n), new Uint8Array(this.n)];
    this.pit = pitInfo(track);

    this.asphalt();
    this.edgeLines();
    this.kerbs();
    this.verges();
    this.runOff();
    this.startFinish();
    this.barriers();
    this.bridges();

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

  private side(sgn: number): 0 | 1 {
    return sgn >= 0 ? 0 : 1;
  }

  /** Per-sample half-width on each side, from the real edges, de-spiked. */
  private halfWidths(): [number[], number[]] {
    const s = this.track.samples;
    const half = this.track.def.width / 2;
    const L: number[] = [];
    const R: number[] = [];
    for (let i = 0; i < this.n; i++) {
      if (this.track.edgeLeft) {
        const l = this.track.edgeLeft[i];
        const r = this.track.edgeRight![i];
        L.push(Math.hypot(l.x - s[i].x, l.y - s[i].y));
        R.push(Math.hypot(r.x - s[i].x, r.y - s[i].y));
      } else {
        L.push(half);
        R.push(half);
      }
    }
    const clamp = (v: number) => Math.max(half * 0.55, Math.min(half * 1.6, v));
    return [smoothCircular(L.map(clamp), 6, 3), smoothCircular(R.map(clamp), 6, 3)];
  }

  /** Lateral position of the rubbered line: toward the inside of each bend. */
  private racingLine(): number[] {
    const s = this.track.samples;
    const k = s.slice(0, this.n).map((p) => p.signedCurvature);
    const kRef = k.map(Math.abs).sort((a, b) => a - b)[Math.floor(k.length * 0.9)] || 1e-6;
    return smoothCircular(k.map((v) => Math.max(-0.55, Math.min(0.55, (v / kRef) * 0.5))), 4, 12);
  }

  /** A point `d` outward from the edge on `sgn` (+1 = +normal) at sample `i`, lifted. */
  private edge(i: number, sgn: number, d: number, lift: number): Pt3 {
    const s = this.track.samples[i % this.n];
    const w = this.hw[this.side(sgn)][i % this.n] + d;
    return { x: s.x + s.nx * sgn * w, y: s.y + s.ny * sgn * w, h: s.h + lift };
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
    for (const run of this.layout.runs) {
      for (const seg of this.splitAtCrossings(run.indices)) this.kerbCells(seg, run.turnSign, w, cell);
      for (const seg of this.splitAtCrossings(run.indices.slice(run.apexEnd))) this.kerbCells(seg, -run.turnSign, w, cell);
    }
  }

  /** Alternating red/white cells re-sampled at a fixed length along the kerb, raised at the outer lip. */
  private kerbCells(indices: number[], sgn: number, w: number, cell: number): void {
    if (indices.length < 2) return;
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
      this.batch.quad("paint", p.a, q.a, q.b, p.b, idx % 2 === 0 ? KERB_RED : KERB_WHITE);
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
        const col = this.kerbAt[side][i] ? VERGE_CORNER : VERGE_STRAIGHT;
        this.batch.quad(
          "paint",
          this.edge(i, sgn, k0, LIFT.verge),
          this.edge(i + 1, sgn, k1, LIFT.verge),
          this.edge(i + 1, sgn, k1 + 9, LIFT.vergeOut),
          this.edge(i, sgn, k0 + 9, LIFT.vergeOut),
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
    for (const run of this.layout.runs) {
      const sgn = -run.turnSign;
      const m = run.indices.length;
      const key = gravel.has(run) ? "runoffGravel" : "runoffTarmac";
      const start = 12;
      for (let k = 1; k < m; k++) {
        const i0 = run.indices[k - 1];
        const i1 = run.indices[k];
        if (this.track.nearSelf[i0] || this.track.nearSelf[i1]) continue;
        const t0 = Math.sin((Math.PI * (k - 1)) / (m - 1 || 1));
        const t1 = Math.sin((Math.PI * k) / (m - 1 || 1));
        if (t0 < 0.05 && t1 < 0.05) continue;
        this.batch.quad(
          key,
          this.edge(i0, sgn, start, LIFT.runoffIn),
          this.edge(i1, sgn, start, LIFT.runoffIn),
          this.edge(i1, sgn, start + w * t1, LIFT.runoffIn + (LIFT.runoffOut - LIFT.runoffIn) * t1),
          this.edge(i0, sgn, start + w * t0, LIFT.runoffIn + (LIFT.runoffOut - LIFT.runoffIn) * t0),
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

  /** Is this a point where another stretch of track passes closer than our own centerline? */
  private foreign(p: Pt, ownDist: number): boolean {
    return this.terrain.trackDistance(p.x, p.y) < ownDist - 12 || this.track.onAsphalt(p.x, p.y);
  }

  /**
   * Concrete walls wearing sponsor banners on both sides of every straight
   * (behind the verge), with a catch fence on top; skipped along the pit lane
   * and wherever another part of the track is closer.
   */
  private barriers(): void {
    const g = this.solids;
    const off = 14;
    for (const straight of this.layout.straights) {
      const idx = straight.indices;
      for (const sgn of [1, -1]) {
        let color = SPONSOR[(idx[0] + (sgn > 0 ? 0 : 3)) % SPONSOR.length];
        for (let k = 1; k < idx.length; k++) {
          const i0 = idx[k - 1];
          const i1 = idx[k];
          if (this.track.nearSelf[i0] || this.track.nearSelf[i1]) continue;
          if (sgn === this.pit.side && (this.pit.window.has(i0) || this.pit.window.has(i1))) continue;
          const a = this.edge(i0, sgn, off, 0);
          const b = this.edge(i1, sgn, off, 0);
          const own = this.hw[this.side(sgn)][i0] + off;
          if (this.foreign(a, own) || this.foreign(b, own)) continue;
          if (k % 7 === 0) color = SPONSOR[Math.floor(k / 7 + i0) % SPONSOR.length];
          g.wall(a, b, a.h, b.h, 1.8, -3, 5, 0xc9c6be, 0xd8d5ce);
          const fa = this.edge(i0, sgn, off - 1, 0);
          const fb = this.edge(i1, sgn, off - 1, 0);
          g.wall(fa, fb, fa.h, fb.h, 0.25, 0.8, 4.4, color);
          this.fence.push(a.x, a.h + 5, a.y, b.x, b.h + 5, b.y);
        }
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
      if (!(s[i].h - lower > 12)) continue;
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
    const runPts: Pt3[][] = this.layout.runs.map((run) => {
      const m = run.indices.length;
      const idx = run.indices.slice(Math.floor(m * 0.25), Math.ceil(m * 0.75)).filter((i) => !this.track.nearSelf[i]);
      if (idx.length < 2) return [];
      const line = idx.map((i) => this.edge(i, -run.turnSign, 12 + sc.runOffWidth + 4, 0));
      const own = this.track.def.width / 2 + 12 + sc.runOffWidth;
      return resampleByDistance(line, r * 2).filter((p) => !this.foreign(p, own));
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
      const base = Math.min(t.p.h, this.terrain.heightAt(t.p.x, t.p.y)) - 0.5;
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
