import {
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshLambertMaterial,
  type Texture,
} from "three";
import { CONFIG } from "../config";
import type { Pt } from "../track/centerline";
import type { TrackLayout } from "../track/corners";
import { UNITS_PER_METRE, type Track } from "../track/Track";
import type { Occupancy } from "./Occupancy";
import type { Terrain } from "./Terrain";
import { hashString, mulberry32, pointInPoly, smooth, ValueNoise } from "./terrainField";
import { asphaltTexture, gravelTexture } from "./textures";

export interface TracksideInput {
  track: Track;
  layout: TrackLayout;
  terrain: Terrain;
  /** Free room beyond each edge [left, right] (see TrackMesh.computeReach). */
  reach: [Float32Array, Float32Array];
  /** Mapped barrier distance beyond each edge (0 = none), or null. */
  bar: [Float32Array, Float32Array] | null;
  /** Samples with a kerb on each side. */
  kerbAt: [Uint8Array, Uint8Array];
  /** Samples inside a tunnel. */
  covered: Uint8Array;
  /** Real gravel traps (OSM, in track coordinates), when enough are mapped. */
  gravel: Pt[][] | null;
}

const GRAVEL = new Color(0xdac7a0);
const TARMAC = new Color(0x8b8d91);
const TURF = new Color(0x4f8f5c); // painted green behind the kerbs
const PAVEMENT = new Color(0xc9c4b8);

/** Lateral rows per side: dense at the edge, wider apart out in the field. */
const ROWS = 24;

/**
 * The ground on both sides of the racing surface as one continuous draped
 * sheet per side: meadow, gravel traps and tarmac run-off are weights on the
 * same vertices, so the areas blend into each other instead of stacking as
 * separate overlapping patches. Run-off lies on the outside of the corners,
 * swelling after the apex where cars run wide, reaching back to the real
 * barrier where one is mapped, with wavy noise-driven borders; real gravel
 * traps (OSM) are painted where they lie. The meadow takes the terrain's own
 * colour and the sheet fades out at its outer border, so it melts into the
 * landscape without a seam.
 */
export class Trackside {
  readonly mesh: Mesh;
  /** Run-off depth beyond each edge [left, right] per sample (0 = none). */
  readonly runoff: [Float32Array, Float32Array];
  /** How far gravel or run-off reaches beyond each edge (incl. mapped traps). */
  readonly extent: [Float32Array, Float32Array];
  private n: number;

  constructor(private inp: TracksideInput) {
    this.n = inp.track.samples.length - 1;
    this.runoff = [this.runoffDepth(1), this.runoffDepth(-1)];
    this.extent = [Float32Array.from(this.runoff[0]), Float32Array.from(this.runoff[1])];
    const gravelness = [this.gravelness(1), this.gravelness(-1)];
    const geo = this.sheet(gravelness);
    this.mesh = new Mesh(geo, tracksideMaterial());
    this.mesh.name = "trackside";
    this.mesh.receiveShadow = true;
    // First among the see-through objects: the catch-fence net drawn before
    // it would otherwise be painted over.
    this.mesh.renderOrder = -1;
  }

  /** Keep trees, signs and props off the gravel and run-off. */
  claim(occ: Occupancy): void {
    const s = this.inp.track.samples;
    for (const sgn of [1, -1]) {
      const side = this.side(sgn);
      for (let i = 0; i < this.n; i++) {
        const e = this.extent[side][i];
        if (e <= 0) continue;
        const p = s[i];
        const hw = this.inp.track.hw[side][i];
        // Circles grow outward: rays fan apart on the outside of a bend.
        for (let d = 0; d <= e; d += 16) {
          occ.add(p.x + p.nx * sgn * (hw + d), p.y + p.ny * sgn * (hw + d), 12 + d * 0.12);
        }
      }
    }
  }

  private side(sgn: number): 0 | 1 {
    return sgn >= 0 ? 0 : 1;
  }

  /** Circular box blur over ±r samples. */
  private blur(a: Float32Array, r: number): Float32Array {
    const n = this.n;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += a[(i + d + n) % n];
      out[i] = s / (2 * r + 1);
    }
    return out;
  }

  /**
   * Run-off depth on side `sgn`: on the outside of each corner, rising over
   * the braking zone, deepest from the apex to past the exit, easing out along
   * the following straight. As deep as the real barrier where one is mapped,
   * else sized by how fast the corner is taken.
   */
  private runoffDepth(sgn: number): Float32Array {
    const { track, layout, reach, bar, covered } = this.inp;
    const n = this.n;
    const side = this.side(sgn);
    const raw = new Float32Array(n);
    const w = CONFIG.scenery.runOffWidth;
    const step = track.length / n;
    const street = !!track.def.street;
    // A street circuit has escape roads only at its few biggest stops.
    const runs = street ? [...layout.runs].sort((a, b) => b.peakSeverity - a.peakSeverity).slice(0, 3) : layout.runs;
    for (const run of runs) {
      if (-run.turnSign !== sgn) continue;
      const m = run.indices.length;
      const pre = Math.max(2, Math.round((25 * UNITS_PER_METRE) / step + m * 0.1));
      const post = Math.max(3, Math.round((60 * UNITS_PER_METRE) / step + m * 0.5));
      const first = run.indices[0];
      const total = pre + m + post;
      const peak = pre + (run.apexStart + run.apexEnd) / 2;
      for (let k = 0; k < total; k++) {
        const i = (first - pre + k + n * 4) % n;
        const up = smooth(0, peak, k);
        const down = 1 - smooth(pre + run.apexEnd, total, k);
        const env = Math.min(up, down);
        const b = bar && !street ? bar[side][i] : 0;
        const want = street ? w * 0.5 : b > 0 ? b - 2 * UNITS_PER_METRE : w * (0.7 + 0.9 * Math.min(1, run.peakSeverity));
        raw[i] = Math.max(raw[i], want * env);
      }
    }
    const out = this.blur(raw, 3);
    for (let i = 0; i < n; i++) {
      out[i] = covered[i] || track.nearSelf[i] ? 0 : Math.min(out[i], reach[side][i] - 2);
      if (out[i] < 6) out[i] = 0;
    }
    return out;
  }

  /**
   * How much of the run-off on side `sgn` is a gravel trap (the rest is
   * tarmac): the faster corners get gravel beyond a strip of tarmac, the slow
   * ones sealed run-off. With real traps mapped, OSM decides instead.
   */
  private gravelness(sgn: number): Float32Array {
    const out = new Float32Array(this.n);
    if (this.inp.gravel || this.inp.track.def.street) return out;
    const runs = [...this.inp.layout.runs].sort((a, b) => b.peakSeverity - a.peakSeverity);
    const fast = new Set(runs.slice(Math.floor(runs.length * 0.35)));
    const n = this.n;
    for (const run of this.inp.layout.runs) {
      if (-run.turnSign !== sgn || !fast.has(run)) continue;
      const m = run.indices.length;
      for (let k = -m; k < m * 2; k++) out[(run.indices[0] + k + n) % n] = 1;
    }
    return this.blur(out, 4);
  }

  private sheet(gravelness: Float32Array[]): BufferGeometry {
    const { track, terrain, reach, kerbAt, covered } = this.inp;
    const s = track.samples;
    const n = this.n;
    const noise = new ValueNoise(mulberry32(hashString(track.def.id + ":trackside")));
    const polys = (this.inp.gravel ?? []).map((poly) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of poly) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      return { poly, x0, y0, x1, y1 };
    });
    const inGravel = (x: number, y: number) =>
      polys.some((g) => x >= g.x0 && x <= g.x1 && y >= g.y0 && y <= g.y1 && pointInPoly(g.poly, x, y));
    const kerbW = CONFIG.scenery.kerbWidth * (track.def.kerbScale ?? 1) * 1.2 * 0.75;
    const U = UNITS_PER_METRE;
    const street = !!track.def.street;
    // Street circuit: a pavement runs along the barrier line, then the town's ground.
    const paveW = kerbW + 18;

    const pos: number[] = [];
    const col: number[] = [];
    const surf: number[] = [];
    const idx: number[] = [];
    const c = new Color();
    const grass = new Color();

    for (const sgn of [1, -1]) {
      const side = this.side(sgn);
      const depth = this.runoff[side];
      const gness = gravelness[side];
      // How far the sheet reaches: past the run-off and any mapped trap, then
      // a margin to fade out over; never into another stretch's room.
      const want = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let ext = 0;
        if (polys.length) {
          const p = s[i];
          for (let d = 4; d < reach[side][i]; d += 6) {
            if (inGravel(p.x + p.nx * sgn * (track.hw[side][i] + d), p.y + p.ny * sgn * (track.hw[side][i] + d))) ext = d;
          }
        }
        want[i] = Math.max(street ? paveW + 6 * U : 14 * U, depth[i] + 8 * U, ext + 8 * U);
        this.extent[side][i] = Math.max(depth[i], ext);
      }
      const width = this.blur(want, 4);
      for (let i = 0; i < n; i++) width[i] = Math.max(0, Math.min(width[i], reach[side][i]));

      const base = pos.length / 3;
      for (let i = 0; i <= n; i++) {
        const k = i % n;
        const p = s[k];
        const hw = track.hw[side][k];
        const W = width[k];
        // Borders wobble with low-frequency noise along the lap, so traps
        // and run-off end in organic curves instead of straight cuts.
        const wob = noise.fbm(p.dist / (90 * U), sgn * 3.1, 3);
        const edgeD = depth[k] * (1 + 0.18 * wob);
        for (let r = 0; r <= ROWS; r++) {
          const d = r === 0 ? -1 : W * (r / ROWS) ** 1.35;
          const x = p.x + p.nx * sgn * (hw + d);
          const y = p.y + p.ny * sgn * (hw + d);
          const ground = terrain.heightAt(x, y) + 0.6;
          const h = d <= 0 ? p.h + 0.45 : p.h + 0.45 + (ground - p.h - 0.45) * smooth(0, 6 * U, d);
          pos.push(x, h, y);

          const jag = noise.at(x / (7 * U), y / (7 * U)) * 2.5 * U;
          const zone = depth[k] > 0 ? 1 - smooth(edgeD - 3 * U, edgeD + 3 * U, d + jag) : 0;
          let wG: number;
          let wT: number;
          if (polys.length) {
            wG = inGravel(x, y) ? 1 : 0;
            wT = zone * (1 - wG);
          } else {
            // Gravel traps keep a strip of tarmac next to the kerb.
            wG = zone * gness[k] * smooth(5 * U, 8 * U, d + jag * 0.5);
            wT = zone - wG;
          }

          terrain.groundColor(x, y, grass);
          c.copy(grass);
          if (street) c.lerp(PAVEMENT, 1 - smooth(paveW - 1.5 * U, paveW + 1.5 * U, d + jag * 0.3));
          else if (kerbAt[side][k] && d < kerbW + 2 * U) c.lerp(TURF, 1 - smooth(kerbW, kerbW + 2 * U, d));
          c.lerp(GRAVEL, wG).lerp(TARMAC, wT);
          const alpha = W > 0 ? 1 - smooth(W * 0.72, W, d) : 0;
          col.push(c.r, c.g, c.b, alpha);
          surf.push(wG, wT);
        }
      }
      const R = ROWS + 1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (covered[i] || covered[j] || track.nearSelf[i] || track.nearSelf[j]) continue;
        if (width[i] < 1 || width[j] < 1) continue;
        for (let r = 0; r < ROWS; r++) {
          const a = base + i * R + r;
          const b = base + (i + 1) * R + r;
          idx.push(a, a + 1, b, b, a + 1, b + 1);
        }
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new Float32BufferAttribute(col, 4));
    geo.setAttribute("surf", new Float32BufferAttribute(surf, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }
}

/** Mean linear luminance of a canvas texture (so detail maps modulate around 1). */
function meanLum(tex: Texture): number {
  const cv = (tex as CanvasTexture).image as HTMLCanvasElement;
  const px = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
  const lin = (v: number) => (v / 255) ** 2.2;
  let s = 0;
  for (let i = 0; i < px.length; i += 4) s += (lin(px[i]) + lin(px[i + 1]) + lin(px[i + 2])) / 3;
  return s / (px.length / 4);
}

/**
 * Vertex colours carry the blended base colour (and the outer fade in alpha);
 * the `surf` weights add the gravel and asphalt grain on top, in world space.
 */
function tracksideMaterial(): MeshLambertMaterial {
  const sc = CONFIG.scenery;
  const gravel = gravelTexture();
  const asphalt = asphaltTexture();
  // Double-sided: the two sides of the track wind opposite ways.
  const m = new MeshLambertMaterial({ vertexColors: true, transparent: true, flatShading: true, side: DoubleSide });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -2;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.gravelMap = { value: gravel };
    sh.uniforms.asphaltMap = { value: asphalt };
    sh.uniforms.tiles = { value: [sc.gravelTile, sc.asphaltTile] };
    sh.uniforms.means = { value: [meanLum(gravel), meanLum(asphalt)] };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 surf;\nvarying vec2 vSurf;\nvarying vec2 vXZ;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSurf = surf;\nvXZ = position.xz;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform sampler2D gravelMap;\nuniform sampler2D asphaltMap;\nuniform vec2 tiles;\nuniform vec2 means;\nvarying vec2 vSurf;\nvarying vec2 vXZ;",
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float gl = dot(texture2D(gravelMap, vXZ / tiles.x).rgb, vec3(1.0 / 3.0)) / means.x;
        float al = dot(texture2D(asphaltMap, vXZ / tiles.y).rgb, vec3(1.0 / 3.0)) / means.y;
        diffuseColor.rgb *= mix(1.0, gl, vSurf.x) * mix(1.0, al, vSurf.y);`,
      );
  };
  return m;
}
