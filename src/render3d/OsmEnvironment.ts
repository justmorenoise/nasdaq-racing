import {
  Group,
  Mesh,
  MeshLambertMaterial,
  MeshPhongMaterial,
  PlaneGeometry,
  ShapeUtils,
  Vector2,
  Vector3,
  BufferGeometry,
  Float32BufferAttribute,
} from "three";
import { CONFIG } from "../config";
import type { Track } from "../track/Track";
import type { Pt } from "../track/centerline";
import { FlatBatch, type Pt3 } from "./FlatBatch";
import { KitInstancer, PROP_SCALE } from "./Kit";
import type { Occupancy } from "./Occupancy";
import type { OsmWorld } from "./osm";
import { hashString, mulberry32, pointInPoly, type Terrain } from "./Terrain";
import { asphaltTexture } from "./textures";

const LEAF = [0x6f8f45, 0x7b9a4b, 0x5f7f3e, 0x86a152, 0x6a8a48];
const PINE = [0x3f6a43, 0x4a7548, 0x365f3c, 0x557d4b];
const FACADES = [0xe9dcc4, 0xf1e7d3, 0xdcc3a1, 0xe6cfa6, 0xd5dadf, 0xefece4, 0xe2bfa6, 0xd7c9ab, 0xc9b79a];
const CARS = [0xe8e4da, 0x2a2d33, 0xc8412f, 0x4e7fc4, 0x9aa3ab, 0xe6b422];

/** Kit building footprints (metres, X × Z) and heights, from build_kit.py. */
const BLD: Record<string, { w: number; d: number; h: number }> = {
  bld_e: { w: 9, d: 9, h: 9.3 },
  bld_c: { w: 14, d: 10, h: 9.3 },
  bld_a: { w: 12, d: 12, h: 12.4 },
  bld_b: { w: 10, d: 14, h: 15.5 },
  bld_d: { w: 12, d: 16, h: 18.6 },
  bld_f: { w: 16, d: 12, h: 21.7 },
};

/**
 * The world around the circuit laid out from OpenStreetMap, drawn in the kit's
 * stylised look: town buildings where the real ones stand (kit houses scaled
 * to their footprint and floors), the real street network draped on the
 * terrain with centre lines, pavements and zebra crossings, street lamps and
 * parked cars, woods filled with trees plus mapped single trees, car parks,
 * the sea with moored boats, and lakes. Positions are real; sizes are the
 * diorama's (roads and houses are drawn a bit larger than true scale so they
 * read next to the oversized cars).
 */
export class OsmEnvironment {
  readonly group = new Group();
  private rand: () => number;
  private kit = new KitInstancer();
  private batch = new FlatBatch();
  /** World units per real metre for widths (larger than the fit's scale). */
  private k: number;
  private roadSegs: { a: Pt; b: Pt; w: number }[] = [];
  private built: { x: number; y: number; r: number }[] = [];

  constructor(
    private track: Track,
    private terrain: Terrain,
    private occ: Occupancy,
    private osm: OsmWorld,
  ) {
    this.rand = mulberry32(hashString(track.def.id + ":osm"));
    // On a real-scale track the town is near true scale too; on a stylised
    // drawing it's enlarged to read next to the oversized cars.
    this.k = track.def.realGeometry ? osm.scale * 1.1 : Math.max(osm.scale * 1.3, 1.9);
  }

  /** Phase 1, before the trackside is built: terrace the ground under the streets. */
  prepareGround(): void {
    this.roads();
  }

  /** Phase 2, after the stands and paddock claimed their space: fill the world. */
  populate(): void {
    this.crossings();
    this.parking();
    this.buildings();
    this.woods();
    this.water();
    this.pave();
    this.group.add(this.kit.build());
    this.group.add(
      this.batch.build({
        road: { material: new MeshLambertMaterial({ map: asphaltTexture(), vertexColors: true, color: 0xc4c5c8 }), tile: 60 },
        paint: { material: new MeshLambertMaterial({ vertexColors: true }) },
      }),
    );
  }

  private pick<T>(a: T[]): T {
    return a[Math.floor(this.rand() * a.length)];
  }

  private get trackClear(): number {
    const half = this.track.def.width / 2;
    return this.track.def.street ? half + 26 : half + CONFIG.scenery.runOffWidth + 20;
  }

  private onGround(p: Pt, lift: number): Pt3 {
    return { x: p.x, y: p.y, h: this.terrain.heightAt(p.x, p.y) + lift };
  }

  private usable(p: Pt): boolean {
    return this.terrain.trackDistance(p.x, p.y) > this.trackClear && !this.terrain.water?.contains(p.x, p.y);
  }

  /** Split a mapped polyline into drape-able runs, resampled so it follows the ground. */
  private runs(line: Pt[], step: number): Pt[][] {
    const out: Pt[][] = [];
    let cur: Pt[] = [];
    for (let k = 0; k < line.length; k++) {
      const p = line[k];
      if (!this.usable(p)) {
        if (cur.length > 1) out.push(cur);
        cur = [];
        continue;
      }
      if (cur.length) {
        const q = cur[cur.length - 1];
        const L = Math.hypot(p.x - q.x, p.y - q.y);
        if (L > 400) {
          if (cur.length > 1) out.push(cur);
          cur = [];
        } else {
          const n = Math.floor(L / step);
          for (let t = 1; t < n; t++) cur.push({ x: q.x + ((p.x - q.x) * t) / n, y: q.y + ((p.y - q.y) * t) / n });
        }
      }
      cur.push(p);
    }
    if (cur.length > 1) out.push(cur);
    return out;
  }

  /** The street network: draped asphalt, centre line on the bigger roads, lamps. */
  private roads(): void {
    const all: { run: Pt[]; w: number; wm: number }[] = [];
    for (const r of this.osm.raw.roads) {
      if (r.w < 5) continue; // service alleys clutter the stylised town
      const w = Math.min(this.track.def.realGeometry ? 14 * this.k : 24, r.w * this.k * 0.85);
      const mapped = this.osm.mapLine(r.p, w / 2 + 8);
      for (const run of this.runs(mapped, 14)) all.push({ run, w, wm: r.w });
    }
    this.terrain.flattenRoads(all.map((a) => ({ pts: a.run, w: a.w })));
    this.terrain.rebuildMesh();
    for (const { run, w, wm } of all) {
      {
        const ground = (x: number, y: number) => this.terrain.heightAt(x, y);
        this.batch.drapedStrip("road", run, w, ground, 0.45);
        // Pavement edges read as a light kerb line either side.
        const off = (sgn: number) =>
          run.map((p, i) => {
            const q = run[Math.min(i + 1, run.length - 1)];
            const o = run[Math.max(i - 1, 0)];
            const dx = q.x - o.x;
            const dy = q.y - o.y;
            const L = Math.hypot(dx, dy) || 1;
            return { x: p.x - (dy / L) * sgn * (w / 2 + 1.5), y: p.y + (dx / L) * sgn * (w / 2 + 1.5) };
          });
        for (const sgn of [1, -1]) this.batch.drapedStrip("paint", off(sgn), 3, ground, 0.6, 0xcdc8bc);
        if (wm >= 8) {
          for (let i = 1; i < run.length; i += 2) this.batch.drapedStrip("paint", [run[i - 1], run[i]], 0.9, ground, 0.55, 0xf0efe9);
        }
        for (let i = 1; i < run.length; i++) {
          this.roadSegs.push({ a: run[i - 1], b: run[i], w });
          this.occ.add((run[i - 1].x + run[i].x) / 2, (run[i - 1].y + run[i].y) / 2, w / 2 + 2);
        }
        // Street lamps along one side, every ~6 segments.
        for (let i = 3; i < run.length; i += 6) {
          const side = off(i % 12 < 6 ? 1 : -1)[i];
          this.kit.add("lamp", side.x, this.terrain.heightAt(side.x, side.y), side.y, Math.atan2(run[i].y - side.y, run[i].x - side.x), 1);
        }
      }
    }
  }

  /** Zebra crossings where OSM has them, striped across the nearest mapped road. */
  private crossings(): void {
    for (const [x, y] of this.osm.raw.crossings) {
      const p = this.osm.map(x, y, 10);
      if (!p || !this.usable(p)) continue;
      let best: (typeof this.roadSegs)[number] | null = null;
      let bd = 14;
      for (const s of this.roadSegs) {
        if (Math.abs(s.a.x - p.x) > 60 || Math.abs(s.a.y - p.y) > 60) continue;
        const dx = s.b.x - s.a.x;
        const dy = s.b.y - s.a.y;
        const L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / L2));
        const d = Math.hypot(p.x - s.a.x - dx * t, p.y - s.a.y - dy * t);
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      if (!best) continue;
      const dx = best.b.x - best.a.x;
      const dy = best.b.y - best.a.y;
      const L = Math.hypot(dx, dy) || 1;
      const ux = dx / L;
      const uy = dy / L;
      const nx = -uy;
      const ny = ux;
      const bars = Math.max(3, Math.round(best.w / 2.4));
      for (let b = 0; b < bars; b++) {
        const across = -best.w / 2 + (b + 0.5) * (best.w / bars);
        const c = { x: p.x + nx * across, y: p.y + ny * across };
        const a0 = { x: c.x - ux * 3.2, y: c.y - uy * 3.2 };
        const a1 = { x: c.x + ux * 3.2, y: c.y + uy * 3.2 };
        this.batch.drapedStrip("paint", [a0, a1], (best.w / bars) * 0.55, (x, y) => this.terrain.heightAt(x, y), 0.6, 0xf2f1ec);
      }
    }
  }

  /** Car parks: a paved lot with rows of parked cars. */
  private parking(): void {
    for (const poly of this.osm.raw.parking) {
      const pts = this.osm.mapLine(poly, 10).filter((p) => this.usable(p));
      if (pts.length < 4) continue;
      const contour = pts.map((p) => new Vector2(p.x, p.y));
      const tris = ShapeUtils.triangulateShape(contour, []);
      for (const [a, b, c] of tris) this.batch.tri("road", this.onGround(pts[a], 0.4), this.onGround(pts[b], 0.4), this.onGround(pts[c], 0.4), 0xd6d6d6);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      for (let x = x0 + 8; x < x1 - 8; x += 11) {
        for (let y = y0 + 12; y < y1 - 12; y += 26) {
          if (this.rand() < 0.25 || !pointInPoly(pts, x, y) || !this.usable({ x, y })) continue;
          this.kit.add("car_parked", x, this.terrain.heightAt(x, y) + 0.4, y, Math.PI / 2, 1, this.pick(CARS));
        }
      }
    }
  }

  /**
   * Kit houses at the real buildings: biggest first so landmarks win; each is
   * scaled toward its footprint and floor count (within the kit's style range)
   * and skipped when it would crowd the track, a road or another building.
   */
  private buildings(): void {
    const blds = this.osm.raw.buildings
      .map((b) => ({ b, box: this.osm.mapBox(b) }))
      .filter((e): e is { b: number[]; box: NonNullable<ReturnType<OsmWorld["mapBox"]>> } => !!e.box)
      .sort((a, b) => b.b[2] * b.b[3] - a.b[2] * a.b[3]);
    const names = Object.keys(BLD);
    for (const { box } of blds) {
      if (!this.usable(box)) continue;
      const area = box.w * box.d;
      const levels = box.levels || (area > 600 ? 5 : area > 200 ? 4 : 3);
      // Pick the kit house closest in proportions/height.
      let name = names[0];
      let bestScore = Infinity;
      for (const n of names) {
        const s = BLD[n];
        const score = Math.abs(Math.log((s.w * s.d) / Math.max(40, area))) + Math.abs(Math.log(s.h / (levels * 3.1)));
        if (score < bestScore) {
          bestScore = score;
          name = n;
        }
      }
      const spec = BLD[name];
      const foot = Math.min(this.track.def.realGeometry ? 2.4 : 1.5, Math.max(0.6, Math.sqrt(area) * this.k / (Math.sqrt(spec.w * spec.d) * PROP_SCALE)));
      const height = Math.min(1.7, Math.max(0.7, (levels * 3.1) / spec.h)) * foot;
      const r = (Math.hypot(spec.w, spec.d) / 2) * PROP_SCALE * foot * 0.62;
      if (!this.occ.free(box.x, box.y, r)) continue;
      if (this.terrain.trackDistance(box.x, box.y) < this.trackClear + r * 0.6) continue;
      // The whole footprint on dry land, above the water line (piers and
      // harbour moles would otherwise float houses on the sea).
      const water = this.terrain.water;
      if (water) {
        const dry = [0, 1, 2, 3, 4, 5, 6, 7].every((q) => {
          const a = (q / 8) * Math.PI * 2;
          const x = box.x + Math.cos(a) * r;
          const y = box.y + Math.sin(a) * r;
          return !water.contains(x, y) && this.terrain.heightAt(x, y) > water.level + 1;
        });
        if (!dry) continue;
      }
      this.occ.add(box.x, box.y, r);
      this.built.push({ x: box.x, y: box.y, r: r * 1.25 });
      const h = Math.min(
        this.terrain.heightAt(box.x - r * 0.6, box.y),
        this.terrain.heightAt(box.x + r * 0.6, box.y),
        this.terrain.heightAt(box.x, box.y - r * 0.6),
        this.terrain.heightAt(box.x, box.y + r * 0.6),
      );
      this.kit.add(name, box.x, h - 1, box.y, box.angle, new Vector3(foot, height, foot), this.pick(FACADES), this.pick([0xf1efe8, 0x5f8a6a, 0x3f6cb3]));
    }
  }

  /** Woods filled with trees, plus every mapped single tree. */
  private woods(): void {
    const clear = this.trackClear + 8;
    const place = (x: number, y: number, pine: boolean, s: number) => {
      const p = { x, y };
      if (this.terrain.trackDistance(x, y) < clear || this.terrain.water?.contains(x, y)) return;
      if (!this.occ.free(x, y, 8 * s)) return;
      this.occ.add(x, y, 6 * s);
      const name = pine ? this.pick(["tree_pine_a", "tree_pine_b"]) : this.pick(["tree_round_a", "tree_round_b", "tree_round_c"]);
      this.kit.add(name, p.x, this.terrain.heightAt(x, y) - 0.5, p.y, this.rand() * 6.28, s, pine ? this.pick(PINE) : this.pick(LEAF));
    };
    const pineShare = this.track.def.theme === "bosco" ? 0.7 : 0.3;
    for (const poly of this.osm.raw.woods) {
      const pts = poly.map(([x, y]) => this.osm.mapRaw(x, y));
      if (pts.length < 3) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      const step = 34;
      for (let x = x0; x < x1; x += step) {
        for (let y = y0; y < y1; y += step) {
          const px = x + (this.rand() - 0.5) * step * 0.9;
          const py = y + (this.rand() - 0.5) * step * 0.9;
          if (pointInPoly(pts, px, py)) place(px, py, this.rand() < pineShare, 0.8 + this.rand() * 0.5);
        }
      }
    }
    for (const [x, y] of this.osm.raw.trees) {
      const p = this.osm.map(x, y, 12);
      if (p) place(p.x, p.y, false, 0.6 + this.rand() * 0.3);
    }
    this.fillerTrees(place, pineShare);
  }

  /**
   * Stylised greenery between the mapped features: groves by theme density
   * (dense for forest circuits), kept away from the town so streets and
   * houses stay clear.
   */
  private fillerTrees(place: (x: number, y: number, pine: boolean, s: number) => void, pineShare: number): void {
    const theme = this.track.def.theme ?? "parco";
    const density = { bosco: 0.75, parco: 0.4, citta: 0.12, porto: 0.1 }[theme];
    const cell = 80;
    const town = new Set<string>();
    for (const b of this.built) {
      for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) town.add(`${Math.floor(b.x / cell) + a},${Math.floor(b.y / cell) + c}`);
    }
    const b = this.track.bounds;
    const m = 2000;
    const step = 40;
    const seed = this.rand() * 100;
    for (let x = b.minX - m; x < b.maxX + m; x += step) {
      for (let y = b.minY - m; y < b.maxY + m; y += step) {
        const px = x + (this.rand() - 0.5) * step;
        const py = y + (this.rand() - 0.5) * step;
        if (town.has(`${Math.floor(px / cell)},${Math.floor(py / cell)}`)) continue;
        const grove =
          Math.sin(px / 430 + seed) * Math.sin(py / 370 + seed * 1.7) * 0.6 + Math.sin((px + py) / 260 + seed * 2.3) * 0.4;
        if (grove * 0.5 + 0.5 > density + (this.rand() - 0.5) * 0.3) continue;
        place(px, py, this.rand() < pineShare, 0.75 + this.rand() * 0.55);
      }
    }
  }

  /**
   * Town ground: pavements along the streets and paved plots under the
   * buildings, so the town reads as streets and squares rather than houses
   * dropped on a lawn.
   */
  private pave(): void {
    const cell = 60;
    const near = new Map<string, { x: number; y: number; r: number }[]>();
    const add = (x: number, y: number, r: number) => {
      const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      const l = near.get(k) ?? [];
      l.push({ x, y, r });
      near.set(k, l);
    };
    for (const s of this.roadSegs) {
      const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
      const n = Math.max(1, Math.ceil(L / 10));
      for (let t = 0; t <= n; t++) add(s.a.x + ((s.b.x - s.a.x) * t) / n, s.a.y + ((s.b.y - s.a.y) * t) / n, s.w / 2 + 11);
    }
    for (const b of this.built) add(b.x, b.y, b.r + 8);
    const city = this.track.def.theme === "porto" || this.track.def.theme === "citta";
    this.terrain.paintFaces((x, y) => {
      const i = Math.floor(x / cell);
      const j = Math.floor(y / cell);
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          for (const o of near.get(`${i + a},${j + b}`) ?? []) {
            if ((o.x - x) ** 2 + (o.y - y) ** 2 < o.r * o.r) return city ? 0xcdc6b7 : 0xb9b6a8;
          }
        }
      }
      return null;
    });
  }

  /** The sea plane (terrain dips below it offshore), moored boats, and lakes. */
  private water(): void {
    const w = this.terrain.water;
    const b = this.track.bounds;
    if (w) {
      const big = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 14;
      const sea = new Mesh(
        new PlaneGeometry(big, big).rotateX(-Math.PI / 2),
        new MeshPhongMaterial({ color: 0x3f7fa6, shininess: 90, specular: 0x9fc3d8 }),
      );
      sea.position.set((b.minX + b.maxX) / 2, w.level, (b.minY + b.maxY) / 2);
      sea.receiveShadow = true;
      this.group.add(sea);
      // Boats moored in sheltered water near the shore (the harbour).
      for (let x = b.minX - 600; x < b.maxX + 600; x += 26) {
        for (let y = b.minY - 600; y < b.maxY + 600; y += 30) {
          const s = this.terrain.shoreDistance(x, y);
          if (s < 14 || s > 140 || this.rand() < 0.72) continue;
          if (this.terrain.trackDistance(x, y) > 450) continue; // the harbour, not the open sea
          if (!this.occ.free(x, y, 12)) continue;
          this.occ.add(x, y, 12);
          const yacht = this.rand() < 0.35;
          this.kit.add(yacht ? "yacht" : "boat", x, w.level - 0.8, y, this.rand() < 0.5 ? 0 : Math.PI / 2, yacht ? 0.7 : 1.1, this.pick([0xf1efe8, 0x1f4fa8, 0xc8412f, 0x2f7a4f]));
        }
      }
    }
    for (const lake of this.terrain.lakes) {
      const contour = lake.poly.map((p) => new Vector2(p.x, p.y));
      const tris = ShapeUtils.triangulateShape(contour, []);
      const pos: number[] = [];
      for (const t of tris) for (const i of t) pos.push(lake.poly[i].x, lake.level, lake.poly[i].y);
      const geo = new BufferGeometry();
      geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      const m = new Mesh(geo, new MeshPhongMaterial({ color: 0x4f86a6, shininess: 80, specular: 0x9fc3d8, side: 2 }));
      m.receiveShadow = true;
      this.group.add(m);
    }
  }
}
