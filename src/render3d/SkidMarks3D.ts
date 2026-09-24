import {
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import type { Car } from "../sim/Car";
import type { Track } from "../track/Track";
import { LAYER } from "./coords";

const SKID_REL_SPEED = 0.62; // lay marks below this profile speed (corner braking)
const STAMP_GAP = 8; // min world distance a car travels between stamps
const CAPACITY = 12000; // tyre streaks kept; the oldest are recycled

/**
 * Rubber laid down where cars brake hard. Each stamp is two short dark streaks
 * (one per rear tyre) written into a fixed-size instanced ring buffer, so
 * memory stays bounded however long the session runs, while overlapping
 * translucent streaks darken naturally into a rubbered-in braking zone.
 */
export class SkidMarks3D {
  readonly mesh: InstancedMesh;
  private next = 0;
  private lastStamp = new Map<string, number>();
  private threshJitter = new Map<string, number>();
  private tyreOff: number;
  private m = new Matrix4();
  private q = new Quaternion();
  private p = new Vector3();
  private s = new Vector3(1, 1, 1);
  private up = new Vector3(0, 1, 0);

  constructor(track: Track) {
    const w = track.def.width;
    this.tyreOff = w * 0.22;
    const geo = new PlaneGeometry(w * 0.5, Math.max(1.4, w * 0.06)).rotateX(-Math.PI / 2);
    const mat = new MeshBasicMaterial({
      color: 0x0d0f12,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.mesh = new InstancedMesh(geo, mat, CAPACITY);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  update(cars: Iterable<Car>, poseOf: (c: Car) => { x: number; y: number; tangent: number }): void {
    let dirty = false;
    for (const car of cars) {
      if (!car.seeded) continue;
      let j = this.threshJitter.get(car.symbol);
      if (j === undefined) {
        j = (Math.random() * 2 - 1) * 0.01;
        this.threshJitter.set(car.symbol, j);
      }
      if (car.relSpeed > SKID_REL_SPEED * (1 + j)) continue;
      const last = this.lastStamp.get(car.symbol) ?? -Infinity;
      if (car.distance - last < STAMP_GAP) continue;
      this.lastStamp.set(car.symbol, car.distance);

      const pose = poseOf(car);
      this.q.setFromAxisAngle(this.up, -pose.tangent);
      const nx = -Math.sin(pose.tangent);
      const ny = Math.cos(pose.tangent);
      for (const off of [-this.tyreOff, this.tyreOff]) {
        this.p.set(pose.x + nx * off, LAYER.skid, pose.y + ny * off);
        this.m.compose(this.p, this.q, this.s);
        this.mesh.setMatrixAt(this.next, this.m);
        this.next = (this.next + 1) % CAPACITY;
        this.mesh.count = Math.min(CAPACITY, this.mesh.count + 1);
      }
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
