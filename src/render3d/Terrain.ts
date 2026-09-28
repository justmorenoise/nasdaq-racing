import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
} from "three";
import { CONFIG } from "../config";
import { UNITS_PER_METRE, type Track } from "../track/Track";
import type { OsmWorld } from "./osm";
import {
  computeField,
  sampleHeight,
  smooth,
  terrainNoise,
  type FieldInput,
  type FieldOutput,
  type ThemeName,
  type ValueNoise,
} from "./terrainField";

export { hashString, mulberry32, pointInPoly } from "./terrainField";

/** Muted, reference-matched palette (olive grass, warm dirt, grey rock). */
const PAL = {
  grassA: new Color(0x93ab62),
  grassB: new Color(0x7f9a52),
  grassC: new Color(0xa3b872),
  forest: new Color(0x5f7b43),
  dirt: new Color(0xb49d74),
  rock: new Color(0x9a938a),
  snow: new Color(0xf1f1ed),
  sand: new Color(0xdac9a0),
  quay: new Color(0xbdb8ae),
};

/** Cells per side of a mesh chunk (frustum culling + per-chunk resolution). */
const CHUNK = 64;

interface Chunk {
  mesh: Mesh;
  centers: Float32Array;
  colors: Float32Array;
  faces: number;
}

export interface Water {
  level: number;
  contains(x: number, y: number): boolean;
}

/**
 * The landscape the circuit sits in: a low-poly, flat-shaded heightfield.
 * The heights are computed by `terrainField.ts` — in a Web Worker when
 * available, so the loading screen stays alive — and this class turns them
 * into the mesh and answers queries (`heightAt`, `trackDistance`,
 * `shoreDistance`) for every other layer; `flattenRoads` terraces streets.
 */
export class Terrain {
  /** The ground, as chunks the renderer can cull (main view, shadows, AO). */
  readonly mesh = new Group();
  readonly skirt: Mesh;
  readonly water: Water | null = null;
  readonly corridor: number;
  /** Distance of each node to the centerline (approximate EDT). */
  readonly dist: Float32Array;
  /** Inland water bodies (OSM), each with its surface level. */
  readonly lakes: { poly: { x: number; y: number }[]; level: number }[];
  private x0: number;
  private y0: number;
  private cell: number;
  private nx: number;
  private ny: number;
  private hgt: Float32Array;
  private fixedMask: Uint8Array;
  private seaDist: Float32Array | null;
  private seaSide: FieldOutput["seaSide"];
  private rimH: number;
  /** Grass colour variation wavelength (world units). */
  private get colorScale(): number {
    return 180 * (this.track.def.realGeometry ? UNITS_PER_METRE : 1);
  }
  private noise: ValueNoise;
  private chunks: Chunk[] = [];
  private material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });

  /** Build the terrain for a track, computing the heights off the main thread. */
  static async create(track: Track, osm: OsmWorld | null): Promise<Terrain> {
    const n = track.samples.length - 1;
    const samples = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const p = track.samples[i];
      samples.set([p.x, p.y, p.h, p.dist], i * 4);
    }
    const coast = osm?.coastSegments() ?? null;
    const input: FieldInput = {
      id: track.def.id,
      theme: (track.def.theme ?? "parco") as ThemeName,
      width: track.def.width,
      runOff: CONFIG.scenery.runOffWidth,
      bounds: { ...track.bounds },
      samples,
      length: track.length,
      coast: coast?.segs ?? null,
      seaSign: coast?.sign ?? 1,
      lakes: osm ? osm.lakes().map((poly) => Float32Array.from(poly.flatMap((p) => [p.x, p.y]))) : [],
      unit: track.def.realGeometry ? UNITS_PER_METRE : 1,
    };
    let field: FieldOutput;
    const t0 = performance.now();
    try {
      field = await new Promise<FieldOutput>((resolve, reject) => {
        const w = new Worker(new URL("./terrainWorker.ts", import.meta.url), { type: "module" });
        w.onmessage = (e) => {
          resolve(e.data as FieldOutput);
          w.terminate();
        };
        w.onerror = (e) => {
          reject(e);
          w.terminate();
        };
        w.postMessage(input);
      });
    } catch {
      field = computeField(input);
    }
    Terrain.fieldMs = Math.round(performance.now() - t0);
    return new Terrain(track, field);
  }

  /** Time the height field took (dev readout). */
  static fieldMs = 0;

  private constructor(
    private track: Track,
    f: FieldOutput,
  ) {
    this.x0 = f.x0;
    this.y0 = f.y0;
    this.cell = f.cell;
    this.nx = f.nx;
    this.ny = f.ny;
    this.corridor = f.corridor;
    this.hgt = f.hgt;
    this.dist = f.dist;
    this.fixedMask = f.fixed;
    this.seaDist = f.seaDist;
    this.seaSide = f.seaSide;
    this.rimH = f.rimH;
    this.lakes = f.lakes.map((l) => {
      const poly: { x: number; y: number }[] = [];
      for (let q = 0; q < l.poly.length; q += 2) poly.push({ x: l.poly[q], y: l.poly[q + 1] });
      return { poly, level: l.level };
    });
    if (f.waterLevel !== null) this.water = { level: f.waterLevel, contains: (x, y) => this.shoreDistance(x, y) > 0 };
    this.noise = terrainNoise(track.def.id);
    this.mesh.name = "terrain";
    this.skirt = this.buildSkirt();
  }

  private idx(i: number, j: number): number {
    return j * this.nx + i;
  }

  /** Signed distance past the shoreline (positive = out at sea). */
  shoreDistance(x: number, y: number): number {
    if (this.seaDist) {
      const i = Math.round(Math.max(0, Math.min(this.nx - 1, (x - this.x0) / this.cell)));
      const j = Math.round(Math.max(0, Math.min(this.ny - 1, (y - this.y0) / this.cell)));
      return this.seaDist[this.idx(i, j)];
    }
    const s = this.seaSide;
    if (!s) return -Infinity;
    return ((s.horizontal ? y : x) - s.shore) * s.dir;
  }

  get seaInfo() {
    return this.seaSide;
  }

  /**
   * Ground height at a point, interpolated on the very triangles the mesh
   * draws, so anything placed with it sits exactly on the visible surface.
   */
  heightAt(x: number, y: number): number {
    return sampleHeight(this.hgt, this.nx, this.ny, this.x0, this.y0, this.cell, x, y);
  }

  /** Distance to the centerline at a point (from the grid EDT). */
  trackDistance(x: number, y: number): number {
    const i = Math.round(Math.max(0, Math.min(this.nx - 1, (x - this.x0) / this.cell)));
    const j = Math.round(Math.max(0, Math.min(this.ny - 1, (y - this.y0) / this.cell)));
    return this.dist[this.idx(i, j)];
  }

  /**
   * Coarsest step (cells per quad) at which the chunk stays within `tol` of
   * the full-resolution surface — flat plains, the sea floor and city blocks
   * collapse to a few big faces, hills keep their facets. Chunks touching the
   * track corridor stay at full resolution. `heightAt` always samples the full
   * grid, so placed objects are off by at most `tol` on coarse chunks.
   */
  private chunkStep(i0: number, j0: number, i1: number, j1: number): number {
    let near = Infinity;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = this.idx(i, j);
        if (this.fixedMask[k]) return 1;
        near = Math.min(near, this.dist[k]);
      }
    }
    const tol = near < this.cell * 40 ? 1.5 : 5;
    for (const s of [8, 4, 2]) {
      if ((i1 - i0) % s || (j1 - j0) % s) continue;
      let ok = true;
      for (let j = j0; j <= j1 && ok; j++) {
        for (let i = i0; i <= i1; i++) {
          const ci = i0 + Math.min(i1 - i0 - s, Math.floor((i - i0) / s) * s);
          const cj = j0 + Math.min(j1 - j0 - s, Math.floor((j - j0) / s) * s);
          const tx = (i - ci) / s;
          const ty = (j - cj) / s;
          const h00 = this.hgt[this.idx(ci, cj)], h10 = this.hgt[this.idx(ci + s, cj)];
          const h01 = this.hgt[this.idx(ci, cj + s)], h11 = this.hgt[this.idx(ci + s, cj + s)];
          const est = h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty;
          if (Math.abs(est - this.hgt[this.idx(i, j)]) > tol) {
            ok = false;
            break;
          }
        }
      }
      if (ok) return s;
    }
    return 1;
  }

  /** (Re)build every chunk mesh from the current heights. */
  private buildChunks(): void {
    for (const c of this.chunks) {
      this.mesh.remove(c.mesh);
      c.mesh.geometry.dispose();
    }
    this.chunks = [];
    let hMax = -Infinity;
    for (const v of this.hgt) hMax = Math.max(hMax, v);
    const snowLine = this.water ? hMax * 0.72 : Infinity;
    for (let cj = 0; cj < this.ny - 1; cj += CHUNK) {
      for (let ci = 0; ci < this.nx - 1; ci += CHUNK) {
        const i1 = Math.min(ci + CHUNK, this.nx - 1);
        const j1 = Math.min(cj + CHUNK, this.ny - 1);
        this.chunks.push(this.buildChunk(ci, cj, i1, j1, this.chunkStep(ci, cj, i1, j1), snowLine));
      }
    }
    for (const c of this.chunks) this.mesh.add(c.mesh);
  }

  private buildChunk(i0: number, j0: number, i1: number, j1: number, step: number, snowLine: number): Chunk {
    const { cell } = this;
    const qi = (i1 - i0) / step;
    const qj = (j1 - j0) / step;
    // Faces: the quads, plus a skirt hanging from the chunk's rim that hides the
    // hairline cracks where a neighbour uses a different step.
    const faces = qi * qj * 2 + (qi + qj) * 2 * 4;
    const pos = new Float32Array(faces * 9);
    const col = new Float32Array(faces * 9);
    const centers = new Float32Array(faces * 2);
    const c = new Color();
    let t = 0;
    const P = (i: number, j: number) => [this.x0 + i * cell, this.hgt[this.idx(i, j)], this.y0 + j * cell] as const;
    const shade = (cx: number, cy: number, ch: number, up: number) => {
      const n = this.noise.at(cx / this.colorScale, cy / this.colorScale);
      c.copy(PAL.grassA).lerp(n > 0 ? PAL.grassC : PAL.grassB, Math.abs(n) * 0.9);
      if (up < 0.93) c.lerp(PAL.forest, 0.4);
      if (up < 0.8) c.lerp(PAL.dirt, 0.6);
      if (up < 0.62) c.copy(PAL.rock);
      if (ch > snowLine && up > 0.55) c.copy(PAL.snow);
      if (this.water) {
        const s = this.shoreDistance(cx, cy);
        // A town harbour has concrete quays; open coast gets a beach.
        if (s > -60) c.copy(this.track.def.street ? PAL.quay : PAL.sand);
      }
    };
    const emit = (a: readonly number[], b: readonly number[], d: readonly number[], skirt = false) => {
      if (!skirt) {
        // Wind every face counter-clockwise seen from above (front face up).
        const cross = (d[2] - a[2]) * (b[0] - a[0]) - (d[0] - a[0]) * (b[2] - a[2]);
        if (cross < 0) [b, d] = [d, b];
      }
      pos.set([a[0], a[1], a[2], d[0], d[1], d[2], b[0], b[1], b[2]], t * 9);
      const cx = (a[0] + b[0] + d[0]) / 3;
      const cy = (a[2] + b[2] + d[2]) / 3;
      centers[t * 2] = cx;
      centers[t * 2 + 1] = cy;
      const ux = d[0] - a[0], uy = d[1] - a[1], uz = d[2] - a[2];
      const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
      const nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
      const up = skirt ? 1 : Math.abs(nyv) / (Math.hypot(nxv, nyv, nzv) || 1);
      shade(cx, cy, (a[1] + b[1] + d[1]) / 3, up);
      for (let v = 0; v < 3; v++) col.set([c.r, c.g, c.b], t * 9 + v * 3);
      t++;
    };
    for (let j = j0; j < j1; j += step) {
      for (let i = i0; i < i1; i += step) {
        const p00 = P(i, j), p10 = P(i + step, j), p01 = P(i, j + step), p11 = P(i + step, j + step);
        if (((i + j) / step) % 2) {
          emit(p00, p10, p11);
          emit(p00, p11, p01);
        } else {
          emit(p00, p10, p01);
          emit(p10, p11, p01);
        }
      }
    }
    const drop = step > 1 ? 8 : 3;
    const skirtEdge = (a: readonly number[], b: readonly number[]) => {
      const a2 = [a[0], a[1] - drop, a[2]];
      const b2 = [b[0], b[1] - drop, b[2]];
      // Both windings: the crack may be seen from either side.
      emit(a, b, b2, true);
      emit(a, b2, a2, true);
      emit(a, b2, b, true);
      emit(a, a2, b2, true);
    };
    for (let i = i0; i < i1; i += step) {
      skirtEdge(P(i, j0), P(i + step, j0));
      skirtEdge(P(i + step, j1), P(i, j1));
    }
    for (let j = j0; j < j1; j += step) {
      skirtEdge(P(i1, j), P(i1, j + step));
      skirtEdge(P(i0, j + step), P(i0, j));
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return { mesh, centers, colors: col, faces };
  }

  /**
   * Cut terraces for roads: nodes under each road (and a short shoulder) are
   * set to the road's smoothed longitudinal profile, so streets run level
   * across hillsides instead of crumpling over the facets. Call
   * `rebuildMesh()` afterwards.
   */
  flattenRoads(roads: { pts: { x: number; y: number }[]; w: number }[]): void {
    for (const r of roads) {
      if (r.pts.length < 2) continue;
      const raw = r.pts.map((p) => this.heightAt(p.x, p.y));
      const prof = raw.map((_, i) => {
        let s = 0;
        let n = 0;
        for (let d = -3; d <= 3; d++) {
          const j = i + d;
          if (j < 0 || j >= raw.length) continue;
          s += raw[j];
          n++;
        }
        return s / n;
      });
      const inner = r.w / 2 + 2;
      const outer = inner + this.cell * 1.5;
      for (let k = 1; k < r.pts.length; k++) {
        const a = r.pts[k - 1];
        const b = r.pts[k];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const L2 = dx * dx + dy * dy || 1e-9;
        const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - outer - this.x0) / this.cell));
        const i1 = Math.min(this.nx - 1, Math.ceil((Math.max(a.x, b.x) + outer - this.x0) / this.cell));
        const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - outer - this.y0) / this.cell));
        const j1 = Math.min(this.ny - 1, Math.ceil((Math.max(a.y, b.y) + outer - this.y0) / this.cell));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const kk = this.idx(i, j);
            if (this.fixedMask[kk]) continue;
            const x = this.x0 + i * this.cell;
            const y = this.y0 + j * this.cell;
            const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2));
            const d = Math.hypot(x - a.x - dx * t, y - a.y - dy * t);
            if (d > outer) continue;
            const target = prof[k - 1] + (prof[k] - prof[k - 1]) * t - 0.3;
            const wgt = d <= inner ? 1 : 1 - smooth(inner, outer, d);
            this.hgt[kk] += (target - this.hgt[kk]) * wgt;
          }
        }
      }
    }
  }

  /** Build (or rebuild, after height edits such as `flattenRoads`) the ground mesh. */
  buildMesh(): void {
    this.buildChunks();
  }

  /** Recolour ground faces (e.g. city streets): `fn` returns a colour or null to keep. */
  paintFaces(fn: (x: number, y: number) => number | null): void {
    const c = new Color();
    for (const ch of this.chunks) {
      let touched = false;
      for (let t = 0; t < ch.faces; t++) {
        const hex = fn(ch.centers[t * 2], ch.centers[t * 2 + 1]);
        if (hex == null) continue;
        c.setHex(hex);
        for (let v = 0; v < 3; v++) ch.colors.set([c.r, c.g, c.b], t * 9 + v * 3);
        touched = true;
      }
      if (touched) (ch.mesh.geometry.getAttribute("color") as Float32BufferAttribute).needsUpdate = true;
    }
  }

  /** A huge flat plane at the rim height so the tilted camera never sees the edge. */
  private buildSkirt(): Mesh {
    const size = Math.max(this.nx, this.ny) * this.cell * 8;
    const geo = new PlaneGeometry(size, size).rotateX(-Math.PI / 2);
    const mesh = new Mesh(geo, new MeshLambertMaterial({ color: PAL.grassB }));
    mesh.position.set(this.x0 + (this.nx * this.cell) / 2, this.rimH - 0.3, this.y0 + (this.ny * this.cell) / 2);
    mesh.receiveShadow = true;
    return mesh;
  }
}
