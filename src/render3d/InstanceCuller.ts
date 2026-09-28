import {
  DynamicDrawUsage,
  Frustum,
  Matrix4,
  Sphere,
  Vector3,
  type Camera,
  type InstancedMesh,
  type Object3D,
} from "three";

interface Item {
  mesh: InstancedMesh;
  n: number;
  matrices: Float32Array;
  colors: Float32Array | null;
  /** Per instance bounding sphere: x, y, z, radius. */
  spheres: Float32Array;
}

/**
 * Per-instance frustum culling for the big instanced sets (trees, houses,
 * crowds, tyre stacks). Three culls an InstancedMesh as a whole, by a bounding
 * sphere spanning the whole map, so every instance is drawn in every pass
 * (view, shadow map). Each frame this packs only the instances inside the
 * camera frustum (grown by a margin, so shadows cast from just off-screen
 * still land) and within the fog's reach at the front of the buffers.
 */
export class InstanceCuller {
  private items: Item[] = [];
  private frustum = new Frustum();
  private pv = new Matrix4();
  private sphere = new Sphere();
  private cam = new Vector3();

  /** Track every instanced mesh under `root` with at least `min` instances. */
  add(root: Object3D, min = 24): void {
    const m4 = new Matrix4();
    const c = new Vector3();
    root.traverse((o) => {
      const mesh = o as InstancedMesh;
      if (!mesh.isInstancedMesh || mesh.count < min) return;
      const n = mesh.count;
      mesh.geometry.computeBoundingSphere();
      const gs = mesh.geometry.boundingSphere!;
      const matrices = mesh.instanceMatrix.array.slice(0, n * 16) as Float32Array;
      const colors = mesh.instanceColor ? (mesh.instanceColor.array.slice(0, n * 3) as Float32Array) : null;
      const spheres = new Float32Array(n * 4);
      for (let k = 0; k < n; k++) {
        m4.fromArray(matrices, k * 16);
        c.copy(gs.center).applyMatrix4(m4);
        spheres.set([c.x, c.y, c.z, gs.radius * m4.getMaxScaleOnAxis()], k * 4);
      }
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.instanceColor?.setUsage(DynamicDrawUsage);
      this.items.push({ mesh, n, matrices, colors, spheres });
    });
  }

  update(camera: Camera, maxDist: number, margin: number): void {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    this.cam.setFromMatrixPosition(camera.matrixWorld);
    const max2 = maxDist * maxDist;
    for (const it of this.items) {
      const dst = it.mesh.instanceMatrix.array as Float32Array;
      const dstC = it.mesh.instanceColor?.array as Float32Array | undefined;
      let count = 0;
      for (let k = 0; k < it.n; k++) {
        const x = it.spheres[k * 4];
        const y = it.spheres[k * 4 + 1];
        const z = it.spheres[k * 4 + 2];
        const dx = x - this.cam.x;
        const dy = y - this.cam.y;
        const dz = z - this.cam.z;
        if (dx * dx + dy * dy + dz * dz > max2) continue;
        this.sphere.center.set(x, y, z);
        this.sphere.radius = it.spheres[k * 4 + 3] + margin;
        if (!this.frustum.intersectsSphere(this.sphere)) continue;
        for (let q = 0; q < 16; q++) dst[count * 16 + q] = it.matrices[k * 16 + q];
        if (dstC && it.colors) for (let q = 0; q < 3; q++) dstC[count * 3 + q] = it.colors[k * 3 + q];
        count++;
      }
      it.mesh.count = count;
      it.mesh.instanceMatrix.clearUpdateRanges();
      it.mesh.instanceMatrix.addUpdateRange(0, count * 16);
      it.mesh.instanceMatrix.needsUpdate = true;
      if (it.mesh.instanceColor) {
        it.mesh.instanceColor.clearUpdateRanges();
        it.mesh.instanceColor.addUpdateRange(0, count * 3);
        it.mesh.instanceColor.needsUpdate = true;
      }
    }
  }
}
