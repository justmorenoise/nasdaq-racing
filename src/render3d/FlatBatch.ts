import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  ShapeUtils,
  Vector2,
  type Material,
} from "three";
import type { Pt } from "../track/centerline";

interface Bucket {
  pos: number[];
  col: number[];
}

export interface BatchMaterial {
  material: Material;
  /** World units per texture tile (world-space UVs); omit for untextured. */
  tile?: number;
}

const tmp = new Color();

/**
 * Collects flat, horizontal polygons (the ground: asphalt, kerbs, gravel,
 * lines…) and bakes them into one mesh per material key. Polygons are given in
 * 2D track coordinates at a layer height; vertex colours let many differently
 * coloured cells (kerbs) share a single draw call. UVs are world-space so
 * textures tile seamlessly across separate polygons.
 */
export class FlatBatch {
  private buckets = new Map<string, Bucket>();

  private bucket(key: string): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { pos: [], col: [] };
      this.buckets.set(key, b);
    }
    return b;
  }

  private tri(b: Bucket, a: Pt, p: Pt, c: Pt, y: number): void {
    // Keep every triangle facing up (+Y) whatever the source winding.
    const up = (p.y - a.y) * (c.x - a.x) - (p.x - a.x) * (c.y - a.y);
    const [q, r] = up >= 0 ? [p, c] : [c, p];
    b.pos.push(a.x, y, a.y, q.x, y, q.y, r.x, y, r.y);
    for (let k = 0; k < 3; k++) b.col.push(tmp.r, tmp.g, tmp.b);
  }

  /** A simple or holed polygon (holes cut out), triangulated. */
  poly(key: string, pts: Pt[], y: number, color = 0xffffff, holes: Pt[][] = []): void {
    if (pts.length < 3) return;
    tmp.setHex(color);
    const b = this.bucket(key);
    const contour = pts.map((p) => new Vector2(p.x, p.y));
    const holeV = holes.map((h) => h.map((p) => new Vector2(p.x, p.y)));
    const all = [...contour, ...holeV.flat()];
    for (const [i, j, k] of ShapeUtils.triangulateShape(contour, holeV)) {
      this.tri(b, all[i], all[j], all[k], y);
    }
  }

  /** A convex quad a→b→c→d. */
  quad(key: string, a: Pt, b: Pt, c: Pt, d: Pt, y: number, color = 0xffffff): void {
    tmp.setHex(color);
    const bk = this.bucket(key);
    this.tri(bk, a, b, c, y);
    this.tri(bk, a, c, d, y);
  }

  /** A constant-width ribbon along an open polyline (lines, pit wall…). */
  strip(key: string, line: Pt[], width: number, y: number, color = 0xffffff): void {
    const h = width / 2;
    for (let k = 1; k < line.length; k++) {
      const p = line[k - 1];
      const q = line[k];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len < 1e-6) continue;
      const nx = (-(q.y - p.y) / len) * h;
      const ny = ((q.x - p.x) / len) * h;
      this.quad(
        key,
        { x: p.x + nx, y: p.y + ny },
        { x: q.x + nx, y: q.y + ny },
        { x: q.x - nx, y: q.y - ny },
        { x: p.x - nx, y: p.y - ny },
        y,
        color,
      );
    }
  }

  build(materials: Record<string, BatchMaterial>): Group {
    const g = new Group();
    for (const [key, b] of this.buckets) {
      const spec = materials[key];
      if (!spec || b.pos.length === 0) continue;
      const geo = new BufferGeometry();
      geo.setAttribute("position", new Float32BufferAttribute(b.pos, 3));
      geo.setAttribute("color", new Float32BufferAttribute(b.col, 3));
      const n = b.pos.length / 3;
      const normals = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) normals[i * 3 + 1] = 1;
      geo.setAttribute("normal", new Float32BufferAttribute(normals, 3));
      if (spec.tile) {
        const uv = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          uv[i * 2] = b.pos[i * 3] / spec.tile;
          uv[i * 2 + 1] = b.pos[i * 3 + 2] / spec.tile;
        }
        geo.setAttribute("uv", new Float32BufferAttribute(uv, 2));
      }
      const mesh = new Mesh(geo, spec.material);
      mesh.receiveShadow = true;
      mesh.name = key;
      g.add(mesh);
    }
    return g;
  }
}
