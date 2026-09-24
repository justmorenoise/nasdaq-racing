import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Low-poly F1 car. The model is authored in Blender (`public/models/car.glb`,
 * nose along +X, 30 units long) with named materials `body`, `helmet`, `carbon`,
 * `tyre` and wheel nodes `wheel_*`. Until it loads — or if it's missing — a
 * procedural stand-in with the same conventions is used, so the race never waits
 * on an asset.
 */

export const CAR_LEN = 30;
export const WHEEL_R = 2.1;

export interface CarParts {
  root: Group;
  /** Wheel pivots, spun about their local Z (the axle) by the view. */
  wheels: Object3D[];
}

type Slot = "body" | "helmet" | "carbon" | "tyre";

const shared: Record<"carbon" | "tyre", MeshStandardMaterial> = {
  carbon: new MeshStandardMaterial({ color: 0x1c1f25, roughness: 0.55, metalness: 0.2, flatShading: true }),
  tyre: new MeshStandardMaterial({ color: 0x17181b, roughness: 0.9, flatShading: true }),
};

const paintCache = new Map<number, MeshStandardMaterial>();
function paint(hex: number): MeshStandardMaterial {
  let m = paintCache.get(hex);
  if (!m) {
    m = new MeshStandardMaterial({ color: new Color(hex), roughness: 0.35, metalness: 0.15, flatShading: true });
    paintCache.set(hex, m);
  }
  return m;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry {
  return new BoxGeometry(w, h, d).translate(x, y, z);
}

type SlotGeos = Partial<Record<Slot, BufferGeometry>>;

/** Geometry merged per material slot: 1 draw call per slot, plus the wheels. */
interface Template {
  parts: SlotGeos;
  wheels: { pos: Vector3; parts: SlotGeos }[];
}

function proceduralTemplate(): Template {
  const body = mergeGeometries([
    box(14, 1.9, 3.4, 5.5, 2.3, 0), // monocoque / nose
    box(4, 1.2, 2.2, 13.5, 1.9, 0), // nose tip
    box(11, 2.3, 8.6, -2.5, 2.1, 0), // sidepods
    box(13, 2.6, 3.2, -4.5, 3.4, 0), // engine cover
    box(3, 1.6, 2.2, -1.2, 5.1, 0), // airbox
    box(2.4, 0.35, 9.4, -13.4, 5.9, 0), // rear wing main plane
    box(3.2, 0.3, 11.2, 14.6, 0.9, 0), // front wing
  ]);
  const carbon = mergeGeometries([
    box(27, 0.4, 8.2, 0, 0.7, 0), // floor
    box(3.4, 3.8, 0.3, -13.4, 4.1, 4.6), // rear endplates
    box(3.4, 3.8, 0.3, -13.4, 4.1, -4.6),
    box(3.4, 1.2, 0.3, 14.6, 1.2, 5.6), // front endplates
    box(3.4, 1.2, 0.3, 14.6, 1.2, -5.6),
    box(1, 2.8, 0.5, -12.6, 4.2, 0), // wing pylon
    box(2.2, 0.35, 0.35, 3.2, 4.6, 0), // halo
  ]);
  const helmet = new IcosahedronGeometry(1.35, 1).translate(1.6, 4.5, 0);
  const tyre = new CylinderGeometry(WHEEL_R, WHEEL_R, 2.2, 12).rotateX(Math.PI / 2);
  const wheelAt = (x: number, z: number) => ({ pos: new Vector3(x, WHEEL_R, z), parts: { tyre } });
  return {
    parts: { body, carbon, helmet },
    wheels: [wheelAt(9.2, 4.6), wheelAt(9.2, -4.6), wheelAt(-9.4, 4.6), wheelAt(-9.4, -4.6)],
  };
}

function slotOf(materialName: string): Slot | null {
  const n = materialName.toLowerCase();
  if (n.startsWith("body")) return "body";
  if (n.startsWith("helmet")) return "helmet";
  if (n.startsWith("carbon")) return "carbon";
  if (n.startsWith("tyre") || n.startsWith("tire")) return "tyre";
  return null;
}

/**
 * Bake a loaded glTF scene into a Template: every mesh outside the wheels is
 * transformed into car space and merged per slot; each `wheel_*` subtree is
 * merged per slot in its own hub space so it can spin about its axle.
 */
function compile(scene: Object3D): Template {
  scene.updateMatrixWorld(true);
  const collect = (root: Object3D, space: Matrix4, skip: (o: Object3D) => boolean): SlotGeos => {
    const bySlot = new Map<Slot, BufferGeometry[]>();
    const inv = space.clone().invert();
    const walk = (o: Object3D) => {
      if (skip(o)) return;
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        const slot = slotOf((mesh.material as MeshStandardMaterial).name) ?? "carbon";
        const g = mesh.geometry.clone().applyMatrix4(new Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
        // Keep only what every slot shares, so geometries merge cleanly.
        for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
        const list = bySlot.get(slot) ?? [];
        list.push(g.index ? g.toNonIndexed() : g);
        bySlot.set(slot, list);
      }
      o.children.forEach(walk);
    };
    walk(root);
    const out: SlotGeos = {};
    for (const [slot, list] of bySlot) out[slot] = mergeGeometries(list);
    return out;
  };
  const isWheel = (o: Object3D) => o.name.startsWith("wheel");
  const wheelNodes: Object3D[] = [];
  scene.traverse((o) => {
    if (isWheel(o)) wheelNodes.push(o);
  });
  return {
    parts: collect(scene, scene.matrixWorld, (o) => isWheel(o)),
    wheels: wheelNodes.map((w) => {
      // Hub space: translation only, so the wheel keeps the car's scale.
      const pos = new Vector3().setFromMatrixPosition(w.matrixWorld);
      return { pos, parts: collect(w, new Matrix4().makeTranslation(pos.x, pos.y, pos.z), () => false) };
    }),
  };
}

let template: Template = proceduralTemplate();

/** Try to load the Blender model; silently keeps the stand-in on failure. */
export async function loadCarModel(url = "models/car.glb"): Promise<void> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    template = compile(gltf.scene);
  } catch {
    /* keep the procedural stand-in */
  }
}

/** Build one car, painted with the stock's colours. */
export function buildCar(bodyHex: number, helmetHex: number): CarParts {
  const matFor = (slot: Slot) =>
    slot === "body" ? paint(bodyHex) : slot === "helmet" ? paint(helmetHex) : shared[slot];
  const add = (parent: Object3D, parts: SlotGeos) => {
    for (const [slot, geo] of Object.entries(parts) as [Slot, BufferGeometry][]) {
      const m = new Mesh(geo, matFor(slot));
      m.castShadow = true;
      parent.add(m);
    }
  };
  const root = new Group();
  add(root, template.parts);
  const wheels = template.wheels.map((w) => {
    const pivot = new Object3D();
    pivot.position.copy(w.pos);
    add(pivot, w.parts);
    root.add(pivot);
    return pivot;
  });
  return { root, wheels };
}
