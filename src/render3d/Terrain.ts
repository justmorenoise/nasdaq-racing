import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
} from "three";
import { CONFIG } from "../config";
import type { Track } from "../track/Track";
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
  readonly mesh: Mesh;
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
  private noise: ValueNoise;
  private faceCenters!: Float32Array;
  private colors!: Float32Array;

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
    };
    let field: FieldOutput;
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
    return new Terrain(track, field);
  }

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
    const built = this.buildMesh(this.noise);
    this.mesh = built.mesh;
    this.faceCenters = built.centers;
    this.colors = built.colors;
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

  private buildMesh(noise: ValueNoise): { mesh: Mesh; centers: Float32Array; colors: Float32Array } {
    const { nx, ny, cell } = this;
    const tris = (nx - 1) * (ny - 1) * 2;
    const pos = new Float32Array(tris * 9);
    const col = new Float32Array(tris * 9);
    const centers = new Float32Array(tris * 2);
    const c = new Color();
    let t = 0;
    const P = (i: number, j: number) => [this.x0 + i * cell, this.hgt[this.idx(i, j)], this.y0 + j * cell] as const;
    let hMax = -Infinity;
    for (const v of this.hgt) hMax = Math.max(hMax, v);
    const snowLine = this.water ? hMax * 0.72 : Infinity;
    const emit = (a: readonly number[], b: readonly number[], d: readonly number[]) => {
      // Wind every face counter-clockwise seen from above (front face up).
      const cross = (d[2] - a[2]) * (b[0] - a[0]) - (d[0] - a[0]) * (b[2] - a[2]);
      if (cross < 0) [b, d] = [d, b];
      pos.set([a[0], a[1], a[2], d[0], d[1], d[2], b[0], b[1], b[2]], t * 9);
      const cx = (a[0] + b[0] + d[0]) / 3;
      const cy = (a[2] + b[2] + d[2]) / 3;
      const ch = (a[1] + b[1] + d[1]) / 3;
      centers[t * 2] = cx;
      centers[t * 2 + 1] = cy;
      // Slope from the face normal's vertical component.
      const ux = d[0] - a[0], uy = d[1] - a[1], uz = d[2] - a[2];
      const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
      const nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
      const up = Math.abs(nyv) / (Math.hypot(nxv, nyv, nzv) || 1);
      const n = noise.at(cx / 180, cy / 180);
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
      for (let v = 0; v < 3; v++) col.set([c.r, c.g, c.b], t * 9 + v * 3);
      t++;
    };
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const p00 = P(i, j), p10 = P(i + 1, j), p01 = P(i, j + 1), p11 = P(i + 1, j + 1);
        if ((i + j) % 2) {
          emit(p00, p10, p11);
          emit(p00, p11, p01);
        } else {
          emit(p00, p10, p01);
          emit(p10, p11, p01);
        }
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.name = "terrain";
    return { mesh, centers, colors: col };
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

  /** Rebuild the ground mesh after height edits (keeps the same Mesh object). */
  rebuildMesh(): void {
    const built = this.buildMesh(this.noise);
    this.mesh.geometry.dispose();
    this.mesh.geometry = built.mesh.geometry;
    this.faceCenters = built.centers;
    this.colors = built.colors;
  }

  /** Recolour ground faces (e.g. city streets): `fn` returns a colour or null to keep. */
  paintFaces(fn: (x: number, y: number) => number | null): void {
    const c = new Color();
    const n = this.faceCenters.length / 2;
    for (let t = 0; t < n; t++) {
      const hex = fn(this.faceCenters[t * 2], this.faceCenters[t * 2 + 1]);
      if (hex == null) continue;
      c.setHex(hex);
      for (let v = 0; v < 3; v++) this.colors.set([c.r, c.g, c.b], t * 9 + v * 3);
    }
    (this.mesh.geometry.getAttribute("color") as Float32BufferAttribute).needsUpdate = true;
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
