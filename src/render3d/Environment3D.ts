import { Group, Mesh, MeshPhongMaterial, PlaneGeometry } from "three";
import { CONFIG } from "../config";
import type { Track, TrackTheme } from "../track/Track";
import { KitInstancer, PROP_SCALE } from "./Kit";
import type { Occupancy } from "./Occupancy";
import { Solids } from "./Solids";
import { hashString, mulberry32, type Terrain } from "./Terrain";

const LEAF = [0x6f8f45, 0x7b9a4b, 0x5f7f3e, 0x86a152, 0x6a8a48];
const PINE = [0x3f6a43, 0x4a7548, 0x365f3c, 0x557d4b];
const AUTUMN = [0xc98c3a, 0xb8742f, 0xd4a24a];
const FACADES = [0xe9dcc4, 0xf1e7d3, 0xdcc3a1, 0xe6cfa6, 0xd5dadf, 0xefece4, 0xe2bfa6, 0xd7c9ab, 0xc9b79a];
const CARS = [0xe8e4da, 0x2a2d33, 0xc8412f, 0x4e7fc4, 0x9aa3ab, 0xe6b422];

interface ThemeSpec {
  treeStep: number;
  /** Keep a tree where the grove noise exceeds this (−1 = everywhere). */
  treeThreshold: number;
  pineShare: number;
  city: boolean;
}

const THEMES: Record<TrackTheme, ThemeSpec> = {
  parco: { treeStep: 46, treeThreshold: 0.05, pineShare: 0.3, city: false },
  bosco: { treeStep: 36, treeThreshold: -0.6, pineShare: 0.7, city: false },
  citta: { treeStep: 60, treeThreshold: 0.6, pineShare: 0.15, city: true },
  porto: { treeStep: 48, treeThreshold: 0.2, pineShare: 0.55, city: true },
};

/**
 * The world around the circuit, themed per track (`tema`): tree groves and
 * forest belts right up to the barriers, bushes and rocks, a street-grid town
 * of detailed Blender buildings (streets painted onto the terrain, lamps,
 * parked cars, trees in the squares) and, for harbour circuits, the sea with
 * a quay, piers with moored yachts and boats, a lighthouse, containers and cranes.
 */
export class Environment3D {
  readonly group = new Group();
  private rand: () => number;
  private spec: ThemeSpec;
  private kit = new KitInstancer();
  private solids = new Solids();

  constructor(
    private track: Track,
    private terrain: Terrain,
    private occ: Occupancy,
  ) {
    this.rand = mulberry32(hashString(track.def.id + ":env"));
    this.spec = THEMES[track.def.theme ?? "parco"];
    if (terrain.water) this.harbour();
    if (this.spec.city) this.city();
    this.trees();
    this.group.add(this.kit.build());
    if (!this.solids.empty) this.group.add(this.solids.build());
  }

  private pick<T>(a: T[]): T {
    return a[Math.floor(this.rand() * a.length)];
  }

  private get clearance(): number {
    return this.track.def.width / 2 + CONFIG.scenery.runOffWidth + 30;
  }

  private area(margin: number) {
    const b = this.track.bounds;
    return { x0: b.minX - margin, x1: b.maxX + margin, y0: b.minY - margin, y1: b.maxY + margin };
  }

  private grove(x: number, y: number, seed: number): number {
    return (
      Math.sin(x / 430 + seed) * Math.sin(y / 370 + seed * 1.7) * 0.7 +
      Math.sin((x + y) / 260 + seed * 2.3) * 0.3 +
      Math.sin((x - y) / 180 + seed * 0.7) * 0.2
    );
  }

  private trees(): void {
    const sp = this.spec;
    const a = this.area(2000);
    const seed = this.rand() * 100;
    const clear = this.clearance;
    const rounds = ["tree_round_a", "tree_round_b", "tree_round_c"];
    const pines = ["tree_pine_a", "tree_pine_b"];
    for (let x = a.x0; x < a.x1; x += sp.treeStep) {
      for (let y = a.y0; y < a.y1; y += sp.treeStep) {
        const px = x + (this.rand() - 0.5) * sp.treeStep * 0.9;
        const py = y + (this.rand() - 0.5) * sp.treeStep * 0.9;
        const d = this.terrain.trackDistance(px, py);
        // Denser belts just behind the barriers, like the reference circuits.
        const belt = d < clear + 160 ? 0.35 : 0;
        if (this.grove(px, py, seed) + belt < sp.treeThreshold + (this.rand() - 0.5) * 0.3) continue;
        if (d < clear) continue;
        if (this.terrain.water?.contains(px, py)) continue;
        const s = 0.75 + this.rand() * 0.55;
        if (!this.occ.free(px, py, 10 * s)) continue;
        const h = this.terrain.heightAt(px, py) - 0.5;
        const pine = this.rand() < sp.pineShare;
        const autumn = this.rand() < 0.07;
        const col = autumn ? this.pick(AUTUMN) : pine ? this.pick(PINE) : this.pick(LEAF);
        this.kit.add(pine ? this.pick(pines) : this.pick(rounds), px, h, py, this.rand() * 6.28, s, col);
        if (this.rand() < 0.25) {
          const bx = px + (this.rand() - 0.5) * 30;
          const by = py + (this.rand() - 0.5) * 30;
          if (this.terrain.trackDistance(bx, by) > clear && this.occ.free(bx, by, 4)) {
            this.kit.add("bush", bx, this.terrain.heightAt(bx, by) - 0.3, by, this.rand() * 6.28, 0.8 + this.rand() * 0.6, this.pick(LEAF));
          }
        }
      }
    }
    // Rocks on the steeper ground (mountain backdrops, forest ridges).
    const r = this.area(2400);
    for (let k = 0; k < 400; k++) {
      const x = r.x0 + this.rand() * (r.x1 - r.x0);
      const y = r.y0 + this.rand() * (r.y1 - r.y0);
      if (this.terrain.trackDistance(x, y) < 600 || this.terrain.water?.contains(x, y)) continue;
      const g = Math.abs(this.terrain.heightAt(x + 20, y) - this.terrain.heightAt(x - 20, y)) / 40;
      if (g < 0.3) continue;
      this.kit.add("rock", x, this.terrain.heightAt(x, y) - 1, y, this.rand() * 6.28, 1.5 + this.rand() * 3);
    }
  }

  /**
   * Town blocks on a street grid: the streets are painted onto the terrain;
   * each block carries 1–4 kit buildings on a paved plot, with lamps and
   * parked cars along the kerb, and the odd leafy square.
   */
  private city(): void {
    const a = this.area(1500);
    const block = 125;
    const road = 18;
    const clear = this.clearance + 30;
    const blds = ["bld_a", "bld_b", "bld_c", "bld_d", "bld_e", "bld_f"];
    const blocks = new Set<string>();
    const key = (i: number, j: number) => `${i},${j}`;
    const ni = Math.ceil((a.x1 - a.x0) / block);
    const nj = Math.ceil((a.y1 - a.y0) / block);
    for (let i = 0; i < ni; i++) {
      for (let j = 0; j < nj; j++) {
        const cx = a.x0 + (i + 0.5) * block;
        const cy = a.y0 + (j + 0.5) * block;
        const d = this.terrain.trackDistance(cx, cy);
        if (d < clear + block * 0.7) continue;
        if (this.terrain.shoreDistance(cx, cy) > -120) continue;
        // The town thins out into countryside away from the circuit.
        if (d > 1300 + this.rand() * 400) continue;
        if (!this.occ.free(cx, cy, block * 0.3)) continue;
        blocks.add(key(i, j));
        this.occ.add(cx, cy, block * 0.45);
        const h = this.terrain.heightAt(cx, cy);
        const inner = block / 2 - road / 2;
        if (this.rand() < 0.1) {
          for (let t = 0; t < 4; t++) {
            this.kit.add("tree_round_b", cx + (this.rand() - 0.5) * inner, h - 0.5, cy + (this.rand() - 0.5) * inner, this.rand() * 6.28, 0.9, this.pick(LEAF));
          }
          continue;
        }
        const split = this.rand() < 0.35 ? 1 : this.rand() < 0.5 ? 2 : 4;
        const lots: [number, number, number][] =
          split === 1
            ? [[cx, cy, inner]]
            : split === 2
              ? [[cx - inner / 2, cy, inner / 2], [cx + inner / 2, cy, inner / 2]]
              : [
                  [cx - inner / 2, cy - inner / 2, inner / 2],
                  [cx + inner / 2, cy - inner / 2, inner / 2],
                  [cx - inner / 2, cy + inner / 2, inner / 2],
                  [cx + inner / 2, cy + inner / 2, inner / 2],
                ];
        for (const [lx, ly, half] of lots) {
          const name = this.pick(blds);
          // Kit footprints are ~9-16 m: scale to fill the lot.
          const s = Math.min(1.4, Math.max(0.8, (half * 2 * 0.95) / (13 * PROP_SCALE)));
          const hh = Math.min(
            this.terrain.heightAt(lx - half, ly - half),
            this.terrain.heightAt(lx + half, ly + half),
            this.terrain.heightAt(lx - half, ly + half),
            this.terrain.heightAt(lx + half, ly - half),
          );
          const face = [0, Math.PI / 2, Math.PI, -Math.PI / 2][Math.floor(this.rand() * 4)];
          this.kit.add(name, lx, hh - 1, ly, face, s, this.pick(FACADES), this.pick([0xf1efe8, 0x5f8a6a, 0x3f6cb3]));
        }
        for (let k = -1; k <= 1; k += 2) {
          const ex = cx + k * (inner + 4);
          this.kit.add("lamp", ex, this.terrain.heightAt(ex, cy), cy, k > 0 ? Math.PI : 0, 1);
          if (this.rand() < 0.6) {
            const py = cy + (this.rand() - 0.5) * inner;
            this.kit.add("car_parked", ex, this.terrain.heightAt(ex, py), py, Math.PI / 2, 1, this.pick(CARS));
          }
        }
      }
    }
    // Streets and sidewalks painted onto the terrain under the town.
    const x0 = a.x0;
    const y0 = a.y0;
    this.terrain.paintFaces((x, y) => {
      const i = Math.floor((x - x0) / block);
      const j = Math.floor((y - y0) / block);
      const lx = x - x0 - i * block;
      const ly = y - y0 - j * block;
      const nearRoad = Math.min(lx, block - lx, ly, block - ly) < road / 2 + 6;
      if (!blocks.has(key(i, j))) {
        const adj = blocks.has(key(i - 1, j)) || blocks.has(key(i + 1, j)) || blocks.has(key(i, j - 1)) || blocks.has(key(i, j + 1));
        return adj && nearRoad ? 0x7a7d83 : null;
      }
      return nearRoad ? 0x7a7d83 : 0xcbc4b5;
    });
  }

  /** Sea, quay, piers with moored boats and yachts, a lighthouse, containers and cranes. */
  private harbour(): void {
    const w = this.terrain.water!;
    const info = this.terrain.seaInfo!;
    const b = this.track.bounds;
    const big = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 12;
    const sea = new Mesh(
      new PlaneGeometry(big, big).rotateX(-Math.PI / 2),
      new MeshPhongMaterial({ color: 0x3f7fa6, shininess: 90, specular: 0x9fc3d8 }),
    );
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    if (info.horizontal) sea.position.set(cx, w.level, info.shore + (info.dir * big) / 2 - info.dir * 400);
    else sea.position.set(info.shore + (info.dir * big) / 2 - info.dir * 400, w.level, cy);
    sea.receiveShadow = true;
    this.group.add(sea);

    const along0 = (info.horizontal ? b.minX : b.minY) - 700;
    const along1 = (info.horizontal ? b.maxX : b.maxY) + 700;
    const pt = (u: number, v: number) => (info.horizontal ? { x: u, y: info.shore + info.dir * v } : { x: info.shore + info.dir * v, y: u });
    // Heading that points out to sea (the kit's +X).
    const seaward = info.horizontal ? (info.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : info.dir > 0 ? 0 : Math.PI;
    const g = this.solids;
    g.prism([pt(along0, -40), pt(along1, -40), pt(along1, 8), pt(along0, 8)], w.level - 6, w.level + 5, 0xa9a59c, 0xc9c5bb);
    for (let u = along0 + 200; u < along1 - 100; u += 380) {
      g.prism([pt(u - 10, 8), pt(u + 10, 8), pt(u + 10, 260), pt(u - 10, 260)], w.level - 6, w.level + 3, 0xa9a59c, 0xc4bfb4);
      for (let v = 40; v < 250; v += 26) {
        for (const sgn of [-1, 1]) {
          if (this.rand() < 0.25) continue;
          const c = pt(u + sgn * (24 + this.rand() * 4), v);
          const yacht = this.rand() < 0.4;
          this.kit.add(yacht ? "yacht" : "boat", c.x, w.level - 0.8, c.y, seaward, yacht ? 0.8 : 1.2, this.pick([0xf1efe8, 0x1f4fa8, 0xc8412f, 0x2f7a4f]));
        }
      }
    }
    const lh = pt(along1 - 300, 30);
    g.prism([pt(along1 - 330, 8), pt(along1 - 270, 8), pt(along1 - 270, 60), pt(along1 - 330, 60)], w.level - 6, w.level + 5, 0xa9a59c, 0xc9c5bb);
    this.kit.add("lighthouse", lh.x, w.level + 5, lh.y, 0, 1.4);
    for (let k = 0; k < 3; k++) {
      const c = pt(along0 + 150 + k * 90, -18);
      this.kit.add("dock_crane", c.x, w.level + 5, c.y, seaward + Math.PI / 2, 1);
    }
    for (let k = 0; k < 24; k++) {
      const c = pt(along0 + 60 + (k % 8) * 30, -28);
      this.kit.add("container", c.x, w.level + 5 + Math.floor(k / 8) * 2.6 * PROP_SCALE, c.y, seaward + Math.PI / 2, 1, this.pick([0xc8412f, 0x1f4fa8, 0xe6b422, 0x2f7a4f, 0xe8862a]));
    }
  }
}
