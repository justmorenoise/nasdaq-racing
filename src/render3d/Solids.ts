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
   * `side`, the top `top` (defaults to the side colour). y0/y1 may be given per
   * vertex, so walls and foundations can follow sloping ground.
   */
  prism(foot: Pt[], y0: number | number[], y1: number | number[], side: number, top = side): void {
    if (foot.length < 3) return;
    const lo = (i: number) => (typeof y0 === "number" ? y0 : y0[i]);
    const hi = (i: number) => (typeof y1 === "number" ? y1 : y1[i]);
    let area = 0;
    for (let i = 0; i < foot.length; i++) {
      const j = (i + 1) % foot.length;
      area += foot[i].x * foot[j].y - foot[j].x * foot[i].y;
    }
    // Normalise to counter-clockwise in (x, z) seen from +Y.
    const order = foot.map((_, i) => i);
    if (area > 0) order.reverse();
    cA.setHex(side);
    cB.setHex(top);
    this.face(order.map((i) => [foot[i].x, hi(i), foot[i].y] as [number, number, number]), cB);
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const j = order[(k + 1) % order.length];
      const a = foot[i];
      const b = foot[j];
      this.face(
        [
          [a.x, lo(i), a.y],
          [b.x, lo(j), b.y],
          [b.x, hi(j), b.y],
          [a.x, hi(i), a.y],
        ],
        cA,
      );
    }
  }

  /**
   * A wall of `thick` along segment a→b standing on the given base heights,
   * from `bottom` to `top` above them (both may be negative for foundations).
   */
  wall(a: Pt, b: Pt, ha: number, hb: number, thick: number, bottom: number, top: number, side: number, topCol = side): void {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) return;
    const nx = (-(b.y - a.y) / len) * (thick / 2);
    const ny = ((b.x - a.x) / len) * (thick / 2);
    this.prism(
      [
        { x: a.x + nx, y: a.y + ny },
        { x: b.x + nx, y: b.y + ny },
        { x: b.x - nx, y: b.y - ny },
        { x: a.x - nx, y: a.y - ny },
      ],
      [ha + bottom, hb + bottom, hb + bottom, ha + bottom],
      [ha + top, hb + top, hb + top, ha + top],
      side,
      topCol,
    );
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
