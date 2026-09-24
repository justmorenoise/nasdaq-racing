import {
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshPhongMaterial,
  Object3D,
  Vector3,
  type Material,
  type MeshStandardMaterial,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * The low-poly scenery kit authored in Blender (`_risorse/blender/build_kit.py`
 * → `public/models/kit.glb`): trees, buildings, towers, gantries, paddock and
 * harbour props. Each `kit_<name>` asset is baked once into one merged
 * geometry per material, then placed any number of times through a
 * `KitInstancer` (one InstancedMesh per asset part). Materials named `tint*`
 * take a per-instance colour (foliage shades, facades, liveries).
 */

/** Blender metres → world units for props (between track and car scale). */
export const PROP_SCALE = 4.2;

interface Part {
  geo: BufferGeometry;
  mat: Material;
  tint: boolean;
}

const assets = new Map<string, Part[]>();
const matCache = new Map<string, Material>();

function convert(src: MeshStandardMaterial): Material {
  const key = src.name;
  let m = matCache.get(key);
  if (!m) {
    const tint = key.startsWith("tint");
    m =
      key === "glass"
        ? new MeshPhongMaterial({ color: src.color, shininess: 80, specular: 0x9fb4c4, flatShading: true })
        : new MeshLambertMaterial({ color: tint ? 0xffffff : src.color, flatShading: true });
    m.name = key;
    matCache.set(key, m);
  }
  return m;
}

export async function loadKit(url = "models/kit.glb"): Promise<void> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.updateMatrixWorld(true);
    const scale = new Matrix4().makeScale(PROP_SCALE, PROP_SCALE, PROP_SCALE);
    for (const root of gltf.scene.children) {
      if (!root.name.startsWith("kit_")) continue;
      const inv = root.matrixWorld.clone().invert();
      const byMat = new Map<string, { src: MeshStandardMaterial; geos: BufferGeometry[] }>();
      root.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const src = mesh.material as MeshStandardMaterial;
        const g = mesh.geometry.clone().applyMatrix4(new Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
        g.applyMatrix4(scale);
        for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
        const entry = byMat.get(src.name) ?? { src, geos: [] };
        entry.geos.push(g.index ? g.toNonIndexed() : g);
        byMat.set(src.name, entry);
      });
      assets.set(
        root.name.slice(4),
        [...byMat.values()].map(({ src, geos }) => ({
          geo: mergeGeometries(geos),
          mat: convert(src),
          tint: src.name.startsWith("tint"),
        })),
      );
    }
  } catch {
    assets.clear();
  }
}

export function hasKit(name: string): boolean {
  return assets.has(name);
}

interface Placement {
  m: Matrix4;
  tint: Color;
  tintB: Color;
}

/** Collects placements of kit assets and bakes them into instanced meshes. */
export class KitInstancer {
  private items = new Map<string, Placement[]>();
  private e = new Object3D();

  /**
   * Place `name` with its base at (x, h, y) in track coordinates, rotated to a
   * 2D heading (radians, the asset's +X along it) and scaled.
   */
  add(
    name: string,
    x: number,
    h: number,
    y: number,
    heading = 0,
    scale: number | Vector3 = 1,
    tint = 0xffffff,
    tintB = 0xffffff,
  ): void {
    if (!assets.has(name)) return;
    const e = this.e;
    e.position.set(x, h, y);
    e.rotation.set(0, -heading, 0);
    if (typeof scale === "number") e.scale.setScalar(scale);
    else e.scale.copy(scale);
    e.updateMatrix();
    const list = this.items.get(name) ?? [];
    list.push({ m: e.matrix.clone(), tint: new Color(tint), tintB: new Color(tintB) });
    this.items.set(name, list);
  }

  build(castShadow = true): Group {
    const g = new Group();
    for (const [name, list] of this.items) {
      for (const part of assets.get(name)!) {
        const mesh = new InstancedMesh(part.geo, part.mat, list.length);
        list.forEach((p, k) => {
          mesh.setMatrixAt(k, p.m);
          if (part.tint) mesh.setColorAt(k, part.mat.name === "tint_b" ? p.tintB : p.tint);
        });
        mesh.castShadow = castShadow;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        g.add(mesh);
      }
    }
    return g;
  }
}
