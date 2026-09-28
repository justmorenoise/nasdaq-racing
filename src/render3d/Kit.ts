import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
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

/**
 * A part's material with a depth rank: parts are authored as overlays of the
 * earlier ones (a truck's white roof on its tinted trailer, a motorhome's
 * stripe), often flush or a few centimetres proud, so each later part wins
 * the depth test instead of z-fighting the one below.
 */
function layered(m: Material, rank: number): Material {
  const k = Math.min(rank, 3);
  if (k === 0) return m;
  const key = `${m.name}#${k}`;
  let c = matCache.get(key);
  if (!c) {
    c = m.clone();
    c.polygonOffset = true;
    c.polygonOffsetFactor = -k;
    c.polygonOffsetUnits = -k * 2;
    matCache.set(key, c);
  }
  return c;
}

/**
 * Assets whose base part's top must show through a flush overlay: the truck's
 * trailer roof wears the team colour, its white band only rings the sides.
 * (Elsewhere the overlay's top is meant to win, e.g. a building's cornice.)
 */
const BASE_TOP_SHOWS = new Set(["truck"]);

/**
 * Drop an overlay part's up-facing faces that lie flush with the top of a part
 * beneath (the white cap on a truck's tinted trailer): the base's top shows,
 * as authored, and the overlay keeps only its sides.
 */
function dropFlushTops(geo: BufferGeometry, below: BufferGeometry[]): BufferGeometry {
  const key = (y: number) => Math.round(y * 100);
  const tops = new Set<number>();
  const upFaces = (g: BufferGeometry, fn: (y: number, t: number) => void) => {
    const p = g.getAttribute("position");
    for (let t = 0; t < p.count; t += 3) {
      const y = p.getY(t);
      if (Math.abs(p.getY(t + 1) - y) > 1e-3 || Math.abs(p.getY(t + 2) - y) > 1e-3) continue;
      const ax = p.getX(t + 1) - p.getX(t), az = p.getZ(t + 1) - p.getZ(t);
      const bx = p.getX(t + 2) - p.getX(t), bz = p.getZ(t + 2) - p.getZ(t);
      // Up-facing in three's right-handed frame: (b − a) × (c − a) has +Y.
      if (az * bx - ax * bz > 0) fn(y, t);
    }
  };
  for (const g of below) upFaces(g, (y) => tops.add(key(y)));
  const drop = new Set<number>();
  upFaces(geo, (y, t) => {
    if (tops.has(key(y))) drop.add(t);
  });
  if (!drop.size) return geo;
  const out = new BufferGeometry();
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.getAttribute(name);
    const src = a.array as Float32Array;
    const kept: number[] = [];
    for (let t = 0; t < a.count; t += 3) {
      if (drop.has(t)) continue;
      for (let v = 0; v < 3 * a.itemSize; v++) kept.push(src[t * a.itemSize + v]);
    }
    out.setAttribute(name, new Float32BufferAttribute(kept, a.itemSize));
  }
  return out;
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
      const merged = [...byMat.values()].map(({ src, geos }) => ({ src, geo: mergeGeometries(geos) }));
      assets.set(
        root.name.slice(4),
        merged.map(({ src, geo }, k) => ({
          geo: k && BASE_TOP_SHOWS.has(root.name.slice(4)) ? dropFlushTops(geo, merged.slice(0, k).map((p) => p.geo)) : geo,
          mat: layered(convert(src), k),
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
