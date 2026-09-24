import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Mesh,
  MeshLambertMaterial,
} from "three";
import type { Pt } from "../track/centerline";

const cA = new Color();
const cB = new Color();

/**
 * Accumulates flat-shaded, vertex-coloured low-poly solids (boxes and extruded
 * footprints) into one merged mesh, so a whole scenery layer is a single draw
 * call. Positions are given in 2D track coordinates plus a height range.
 */
export class Solids {
  private pos: number[] = [];
  private col: number[] = [];

  private face(ps: [number, number, number][], c: Color): void {
    // Fan-triangulate a convex planar face given counter-clockwise from outside.
    for (let k = 1; k < ps.length - 1; k++) {
      for (const p of [ps[0], ps[k], ps[k + 1]]) {
        this.pos.push(p[0], p[1], p[2]);
        this.col.push(c.r, c.g, c.b);
      }
    }
  }

  /**
   * Extrude a convex footprint (any winding) from y0 to y1. Sides take
   * `side`, the top `top` (defaults to the side colour).
   */
  prism(foot: Pt[], y0: number, y1: number, side: number, top = side): void {
    if (foot.length < 3) return;
    let area = 0;
    for (let i = 0; i < foot.length; i++) {
      const j = (i + 1) % foot.length;
      area += foot[i].x * foot[j].y - foot[j].x * foot[i].y;
    }
    // Normalise to counter-clockwise in (x, z) seen from +Y.
    const f = area > 0 ? [...foot].reverse() : foot;
    cA.setHex(side);
    cB.setHex(top);
    this.face(f.map((p) => [p.x, y1, p.y] as [number, number, number]), cB);
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      this.face(
        [
          [a.x, y0, a.y],
          [b.x, y0, b.y],
          [b.x, y1, b.y],
          [a.x, y1, a.y],
        ],
        cA,
      );
    }
  }

  /** Oriented box: centre (cx, cy) on the ground plane, `a` = unit long axis. */
  box(
    cx: number,
    cy: number,
    ax: number,
    ay: number,
    halfLen: number,
    halfDepth: number,
    y0: number,
    y1: number,
    side: number,
    top = side,
  ): void {
    const nx = -ay;
    const ny = ax;
    this.prism(
      [
        { x: cx - ax * halfLen - nx * halfDepth, y: cy - ay * halfLen - ny * halfDepth },
        { x: cx + ax * halfLen - nx * halfDepth, y: cy + ay * halfLen - ny * halfDepth },
        { x: cx + ax * halfLen + nx * halfDepth, y: cy + ay * halfLen + ny * halfDepth },
        { x: cx - ax * halfLen + nx * halfDepth, y: cy - ay * halfLen + ny * halfDepth },
      ],
      y0,
      y1,
      side,
      top,
    );
  }

  /** A sloped slab from the front edge (height yf) up to the back edge (yb). */
  ramp(front: [Pt, Pt], back: [Pt, Pt], yf: number, yb: number, color: number): void {
    cA.setHex(color);
    const [f0, f1] = front;
    const [b0, b1] = back;
    const top: [number, number, number][] = [
      [f0.x, yf, f0.y],
      [f1.x, yf, f1.y],
      [b1.x, yb, b1.y],
      [b0.x, yb, b0.y],
    ];
    // Emit both windings so the slab reads from any camera angle.
    this.face(top, cA);
    this.face([...top].reverse(), cA);
  }

  get empty(): boolean {
    return this.pos.length === 0;
  }

  build(castShadow = true): Mesh {
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("color", new Float32BufferAttribute(this.col, 3));
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    return mesh;
  }
}
