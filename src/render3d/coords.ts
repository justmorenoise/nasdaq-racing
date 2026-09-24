import { Vector3 } from "three";

/**
 * The simulation lives on a 2D plane (x right, y down, SVG units ×3). In the 3D
 * scene that plane is the ground: world (x, y) → Three (x, h, y) with Y up. Seen
 * from above with the camera's up vector toward −Z this keeps the 2D layout
 * unmirrored, so every 2D offset/normal from `track/` applies unchanged.
 */
export function v3(x: number, y: number, h = 0): Vector3 {
  return new Vector3(x, h, y);
}

/** Y-rotation that turns a model whose nose points along +X onto a 2D heading. */
export function headingToRotY(tangent: number): number {
  return -tangent;
}

/** World units per metre: a car (≈5.6 m) is 30 units long, as in the 2D view. */
export const UNITS_PER_M = 30 / 5.6;

/** Heights above the local track surface that cars and rubber marks sit at. */
export const LAYER = {
  asphalt: 0.6,
  skid: 0.66,
} as const;
