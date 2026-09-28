import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  type Material,
} from "three";

/** A point on the ground plane (track coordinates) with its height. */
export interface Pt3 {
  x: number;
  y: number;
  h: number;
}

interface Bucket {
  pos: number[];
  col: number[];
}

export interface BatchMaterial {
  material: Material;
  /** World units per texture tile (world-space UVs); omit for untextured. */
  tile?: number;
  /** Draw order among the surface layers (lower first). */
  order?: number;
  /** Stacking rank among coplanar ground layers: a higher layer wins the depth
   *  test (polygon offset), so near-coincident surfaces never z-fight. */
  layer?: number;
}

const tmp = new Color();

/**
 * Collects near-horizontal surface triangles (asphalt, kerbs, verges, run-off,
 * paint) following the terrain/track heights, and bakes one mesh per material
 * key. Vertex colours let differently coloured cells share one draw call; UVs
 * are world-space so textures tile seamlessly across separate pieces.
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

  /** One up-facing triangle (winding fixed from the plan view). */
  tri(key: string, a: Pt3, p: Pt3, c: Pt3, color = 0xffffff, cp?: number, cc?: number): void {
    const b = this.bucket(key);
    const up = (p.y - a.y) * (c.x - a.x) - (p.x - a.x) * (c.y - a.y);
    let q = p;
    let r = c;
    let cq = cp ?? color;
    let cr = cc ?? color;
    if (up < 0) {
      [q, r] = [c, p];
      [cq, cr] = [cr, cq];
    }
    b.pos.push(a.x, a.h, a.y, q.x, q.h, q.y, r.x, r.h, r.y);
    for (const hex of [color, cq, cr]) {
      tmp.setHex(hex);
      b.col.push(tmp.r, tmp.g, tmp.b);
    }
  }

  /** A convex quad a→b→c→d, optionally with per-corner colours. */
  quad(key: string, a: Pt3, b: Pt3, c: Pt3, d: Pt3, color = 0xffffff, cols?: [number, number, number, number]): void {
    const [ca, cb, cc, cd] = cols ?? [color, color, color, color];
    this.tri(key, a, b, c, ca, cb, cc);
    this.tri(key, a, c, d, ca, cc, cd);
  }

  /** A ribbon of `width` along a polyline whose points carry their own height. */
  strip(key: string, line: Pt3[], width: number, lift: number, color = 0xffffff): void {
    const hw = width / 2;
    for (let k = 1; k < line.length; k++) {
      const p = line[k - 1];
      const q = line[k];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len < 1e-6) continue;
      const nx = (-(q.y - p.y) / len) * hw;
      const ny = ((q.x - p.x) / len) * hw;
      this.quad(
        key,
        { x: p.x + nx, y: p.y + ny, h: p.h + lift },
        { x: q.x + nx, y: q.y + ny, h: q.h + lift },
        { x: q.x - nx, y: q.y - ny, h: q.h + lift },
        { x: p.x - nx, y: p.y - ny, h: p.h + lift },
        color,
      );
    }
  }

  /** A ribbon whose every vertex sits on the ground (`ground(x, y)` + lift). */
  drapedStrip(key: string, line: { x: number; y: number }[], width: number, ground: (x: number, y: number) => number, lift: number, color = 0xffffff): void {
    const hw = width / 2;
    const side = (i: number, sgn: number) => {
      const q = line[Math.min(i + 1, line.length - 1)];
      const o = line[Math.max(i - 1, 0)];
      const dx = q.x - o.x;
      const dy = q.y - o.y;
      const L = Math.hypot(dx, dy) || 1;
      const x = line[i].x - (dy / L) * hw * sgn;
      const y = line[i].y + (dx / L) * hw * sgn;
      return { x, y, h: ground(x, y) + lift };
    };
    for (let k = 1; k < line.length; k++) {
      this.quad(key, side(k - 1, 1), side(k, 1), side(k, -1), side(k - 1, -1), color);
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
      if (spec.tile) {
        const uv = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          uv[i * 2] = b.pos[i * 3] / spec.tile;
          uv[i * 2 + 1] = b.pos[i * 3 + 2] / spec.tile;
        }
        geo.setAttribute("uv", new Float32BufferAttribute(uv, 2));
      }
      geo.computeVertexNormals();
      if (spec.layer) {
        spec.material.polygonOffset = true;
        spec.material.polygonOffsetFactor = -spec.layer;
        spec.material.polygonOffsetUnits = -spec.layer * 2;
      }
      const mesh = new Mesh(geo, spec.material);
      mesh.receiveShadow = true;
      mesh.renderOrder = spec.order ?? 0;
      mesh.name = key;
      g.add(mesh);
    }
    return g;
  }
}
