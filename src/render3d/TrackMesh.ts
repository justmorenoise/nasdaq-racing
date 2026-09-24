import {
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  Color,
} from "three";
import { CONFIG } from "../config";
import type { Track } from "../track/Track";
import type { Pt } from "../track/centerline";
import { offsetPoint, type TrackLayout } from "../track/corners";
import { FlatBatch } from "./FlatBatch";
import { LAYER } from "./coords";
import {
  asphaltTexture,
  grassTexture,
  gravelTexture,
} from "./textures";

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

/** Split a rail wherever it jumps far beyond the centerline step (an edge
 *  discontinuity from a ray grazing a far boundary). */
function splitAtJumps(rail: Pt[], center: Pt[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [0];
  for (let k = 1; k < rail.length; k++) {
    const jump = Math.hypot(rail[k].x - rail[k - 1].x, rail[k].y - rail[k - 1].y);
    const step = Math.hypot(center[k].x - center[k - 1].x, center[k].y - center[k - 1].y);
    if (jump > step * 3.5 + 1) {
      out.push(cur);
      cur = [];
    }
    cur.push(k);
  }
  out.push(cur);
  return out;
}

const KERB_RED = 0xd8342c;
const KERB_WHITE = 0xf4f4f0;

/**
 * The racing surface as 3D meshes: a wide grass field, gravel run-off at corner
 * outsides, the asphalt (real edges with infield holes, or a centerline ribbon),
 * kerbs, track-limit lines, start/finish + grid slots and tyre walls. Static,
 * built once; the corner/straight layout drives the same placement rules as the
 * former 2D view.
 */
export class TrackMesh {
  readonly group = new Group();
  private batch = new FlatBatch();

  constructor(
    private track: Track,
    private layout: TrackLayout,
  ) {
    this.group.add(this.grass());
    this.runOff();
    this.asphalt();
    this.tarmacPatches();
    this.edgeLines();
    this.kerbs();
    this.startFinish();

    const sc = CONFIG.scenery;
    const paint = new MeshLambertMaterial({ vertexColors: true });
    const offset = (m: MeshLambertMaterial, units: number) => {
      m.polygonOffset = true;
      m.polygonOffsetFactor = -units;
      m.polygonOffsetUnits = -units;
      return m;
    };
    this.group.add(
      this.batch.build({
        gravel: { material: offset(new MeshLambertMaterial({ map: gravelTexture(), vertexColors: true }), 1), tile: sc.gravelTile },
        asphalt: { material: offset(new MeshLambertMaterial({ map: asphaltTexture(), vertexColors: true }), 2), tile: sc.asphaltTile },
        patch: { material: offset(new MeshLambertMaterial({ map: asphaltTexture(), vertexColors: true }), 3), tile: sc.asphaltTile },
        paint: { material: offset(paint, 4) },
      }),
    );
    this.group.add(this.tireWalls());
  }

  private get half(): number {
    return this.track.def.width / 2;
  }

  private get n(): number {
    return this.track.samples.length - 1;
  }

  /** A point on (d=0) or `d` outward from the track edge on `side` at sample `i`. */
  bandPt(i: number, side: number, d: number): Pt {
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

  /** A field reaching far past the track so a tilted camera never sees its edge. */
  private grass(): Mesh {
    const b = this.track.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    const size = span * 8;
    const geo = new PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    const tex = grassTexture().clone();
    tex.repeat.set(size / CONFIG.scenery.grassTile, size / CONFIG.scenery.grassTile);
    tex.needsUpdate = true;
    const mesh = new Mesh(geo, new MeshLambertMaterial({ map: tex }));
    mesh.position.set((b.minX + b.maxX) / 2, LAYER.grass, (b.minY + b.maxY) / 2);
    mesh.receiveShadow = true;
    mesh.name = "grass";
    return mesh;
  }

  private asphalt(): void {
    const loops = this.track.edgeLoops;
    const seamColor = 0x2a2d33;
    if (loops) {
      const sorted = [...loops].sort((a, b) => Math.abs(polyArea(b)) - Math.abs(polyArea(a)));
      const [outer, ...inner] = sorted;
      this.batch.poly("asphalt", outer, LAYER.asphalt, 0xffffff, inner);
      for (const loop of sorted) {
        this.batch.strip("paint", [...loop, loop[0]], 3, LAYER.line, seamColor);
      }
      return;
    }
    // Centerline ribbon fallback (hand-made oval).
    const s = this.track.samples;
    for (let i = 0; i < this.n; i++) {
      const j = i + 1;
      this.batch.quad(
        "asphalt",
        offsetPoint(s[i], this.half),
        offsetPoint(s[j], this.half),
        offsetPoint(s[j], -this.half),
        offsetPoint(s[i], -this.half),
        LAYER.asphalt,
      );
    }
  }

  private tarmacPatches(): void {
    for (const [a, b] of CONFIG.scenery.tarmacPatches) {
      const i0 = Math.max(0, Math.floor(a * this.n));
      const i1 = Math.min(this.n - 1, Math.floor(b * this.n));
      for (let i = i0; i < i1; i++) {
        this.batch.quad(
          "patch",
          this.bandPt(i, 1, -0.5),
          this.bandPt(i + 1, 1, -0.5),
          this.bandPt(i + 1, -1, -0.5),
          this.bandPt(i, -1, -0.5),
          LAYER.patch,
          0xb5b5bb,
        );
      }
    }
  }

  /** Gravel traps on the outside of each corner, tapered to nothing at the ends. */
  private runOff(): void {
    const w = CONFIG.scenery.runOffWidth;
    for (const run of this.layout.runs) {
      const outSign = -run.turnSign;
      const m = run.indices.length;
      const inner: Pt[] = [];
      const outer: Pt[] = [];
      for (let j = 0; j < m; j++) {
        const i = run.indices[j];
        const taper = Math.sin((Math.PI * j) / (m - 1 || 1));
        inner.push(this.bandPt(i, outSign, -2));
        outer.push(this.bandPt(i, outSign, w * taper));
      }
      // Quads rather than one polygon: a tight corner's offset outline can
      // self-intersect, which a triangulator mangles.
      for (let j = 1; j < m; j++) {
        this.batch.quad("gravel", inner[j - 1], inner[j], outer[j], outer[j - 1], LAYER.gravel);
      }
    }
  }

  private outerLoop(): Pt[] | null {
    const loops = this.track.edgeLoops;
    if (!loops || loops.length === 0) return null;
    return loops.reduce((a, b) => (Math.abs(polyArea(a)) >= Math.abs(polyArea(b)) ? a : b));
  }

  /**
   * Tyre barriers along the outer edge of each corner's gravel trap (central
   * span only), packed side by side; spots on the asphalt or tangling with
   * another corner's wall are dropped, and groups under 5 tyres are skipped.
   */
  private tireWalls(): Group {
    const g = new Group();
    const sc = CONFIG.scenery;
    // Real barrier tyres are ~0.6 m across; the 2D tuning radius read too chunky in 3D.
    const r = sc.tireRadius * 0.6;
    const outer = this.outerLoop();
    const minSep = sc.tireRadius * 2 * 1.6;
    const s = this.track.samples;

    const runPts: Pt[][] = this.layout.runs.map((run) => {
      const m = run.indices.length;
      const idx = run.indices.slice(Math.floor(m * 0.25), Math.ceil(m * 0.75));
      if (idx.length < 2) return [];
      const line = idx.map((i) => this.bandPt(i, -run.turnSign, sc.tireGap));
      const pts: Pt[] = [];
      for (const seg of splitAtJumps(line, idx.map((i) => s[i]))) {
        for (const c of resampleByDistance(seg.map((k) => line[k]), r * 2)) {
          if (!(outer && pointInPoly(outer, c.x, c.y))) pts.push(c);
        }
      }
      return pts;
    });

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

    const tyres: { p: Pt; red: boolean }[] = [];
    for (let a = 0; a < runPts.length; a++) {
      let group: Pt[] = [];
      const flush = () => {
        if (group.length >= 5) group.forEach((p, k) => tyres.push({ p, red: k % 4 === 0 }));
        group = [];
      };
      runPts[a].forEach((c, i) => (keep[a][i] ? group.push(c) : flush()));
      flush();
    }
    if (!tyres.length) return g;

    // A stack of three tyres per spot, flat-shaded like the reference dioramas.
    const stack = 4;
    const h = r * 0.6;
    const geo = new CylinderGeometry(r, r, h * 0.92, 10, 1);
    const mat = new MeshLambertMaterial({ flatShading: true });
    const mesh = new InstancedMesh(geo, mat, tyres.length * stack);
    const m = new Matrix4();
    const red = new Color(0xcf2b2b);
    const black = new Color(0x1d2026);
    let k = 0;
    for (const t of tyres) {
      for (let lvl = 0; lvl < stack; lvl++) {
        m.makeTranslation(t.p.x, h / 2 + lvl * h, t.p.y);
        mesh.setMatrixAt(k, m);
        mesh.setColorAt(k, t.red && lvl === stack - 1 ? red : black);
        k++;
      }
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    return g;
  }

  /** White track-limit lines along the straights (kerbs mark the corners). */
  private edgeLines(): void {
    const s = this.track.samples;
    for (const straight of this.layout.straights) {
      const idx = straight.indices;
      if (idx.length < 2) continue;
      for (const side of [1, -1]) {
        const rail = idx.map((i) => this.bandPt(i, side, -1.8));
        for (const seg of splitAtJumps(rail, idx.map((i) => s[i]))) {
          this.batch.strip("paint", seg.map((k) => rail[k]), 1.8, LAYER.line, 0xf2f2f2);
        }
      }
    }
  }

  private kerbs(): void {
    for (const run of this.layout.runs) {
      const inside = run.indices;
      const outside = run.indices.slice(run.apexEnd);
      for (const seg of this.splitAtCrossings(inside)) this.kerbStrip(seg, run.turnSign);
      for (const seg of this.splitAtCrossings(outside)) this.kerbStrip(seg, -run.turnSign);
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
      } else {
        cur.push(i);
      }
    }
    if (cur.length) out.push(cur);
    return out;
  }

  private kerbStrip(indices: number[], side: number): void {
    if (indices.length < 2) return;
    const ks = this.track.def.kerbScale ?? 1;
    const w = CONFIG.scenery.kerbWidth * ks;
    const cell = CONFIG.scenery.kerbCellLen * ks;
    const rail = indices.map((i) => this.bandPt(i, side, w * 0.2));
    const s = this.track.samples;
    for (const seg of splitAtJumps(rail, indices.map((i) => s[i]))) {
      this.kerbCells(seg.map((k) => indices[k]), side, w, cell);
    }
  }

  /** Alternating red/white cells re-sampled at a fixed length along the kerb. */
  private kerbCells(indices: number[], side: number, w: number, cell: number): void {
    if (indices.length < 2) return;
    const inner = indices.map((i) => this.bandPt(i, side, -w * 0.3));
    const outer = indices.map((i) => this.bandPt(i, side, w * 0.7));
    const mid = indices.map((i) => this.bandPt(i, side, w * 0.2));
    const probe = indices.map((i) => this.bandPt(i, side, w));

    const cum = [0];
    for (let k = 1; k < mid.length; k++) {
      cum[k] = cum[k - 1] + Math.hypot(mid[k].x - mid[k - 1].x, mid[k].y - mid[k - 1].y);
    }
    const total = cum[cum.length - 1];
    if (total < 1e-3) return;

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
      const mx = (a.probe.x + b.probe.x) / 2;
      const my = (a.probe.y + b.probe.y) / 2;
      if (!this.track.onAsphalt(mx, my)) {
        const color = idx % 2 === 0 ? KERB_RED : KERB_WHITE;
        this.batch.quad("paint", a.inner, b.inner, b.outer, a.outer, LAYER.kerb, color);
      }
      pos += cell;
      idx++;
    }
  }

  /** Checkered start/finish band plus painted grid slots behind it. */
  private startFinish(): void {
    const track = this.track;
    const pose = track.poseAt(track.startDist);
    const half = this.half;
    const cols = 8;
    const cellW = (half * 2) / cols;
    const ax = Math.cos(pose.tangent);
    const ay = Math.sin(pose.tangent);
    const cellAt = (acrossT: number, alongT: number, hl: number, hw: number) => {
      const cx = pose.x + pose.nx * acrossT + ax * alongT;
      const cy = pose.y + pose.ny * acrossT + ay * alongT;
      return [
        { x: cx - ax * hl - pose.nx * hw, y: cy - ay * hl - pose.ny * hw },
        { x: cx + ax * hl - pose.nx * hw, y: cy + ay * hl - pose.ny * hw },
        { x: cx + ax * hl + pose.nx * hw, y: cy + ay * hl + pose.ny * hw },
        { x: cx - ax * hl + pose.nx * hw, y: cy - ay * hl + pose.ny * hw },
      ] as const;
    };
    for (let row = 0; row < 2; row++) {
      for (let c = 0; c < cols; c++) {
        const q = cellAt(-half + c * cellW + cellW / 2, (row === 0 ? -1 : 1) * (cellW / 2), cellW / 2, cellW / 2);
        this.batch.quad("paint", q[0], q[1], q[2], q[3], LAYER.line, (row + c) % 2 ? 0xffffff : 0x16181c);
      }
    }

    // Grid boxes: same slots RaceModel.setSymbols stages the cars on.
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
      const bar = [
        { x: cx - p.nx * hw, y: cy - p.ny * hw },
        { x: cx + p.nx * hw, y: cy + p.ny * hw },
      ];
      this.batch.strip("paint", bar, 1.6, LAYER.line, 0xf2f2f2);
      for (const sgn of [-1, 1]) {
        const e = { x: cx + p.nx * hw * sgn, y: cy + p.ny * hw * sgn };
        this.batch.strip("paint", [e, { x: e.x - tx * gap * 0.3, y: e.y - ty * gap * 0.3 }], 1.6, LAYER.line, 0xf2f2f2);
      }
    }
  }
}
