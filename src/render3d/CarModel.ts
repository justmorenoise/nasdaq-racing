import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
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

/** Procedural stand-in geometry, merged per material slot. */
function proceduralTemplate(): { parts: Partial<Record<Slot, BufferGeometry>>; wheel: BufferGeometry; wheelPos: [number, number, number][] } {
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
  const wheel = new CylinderGeometry(WHEEL_R, WHEEL_R, 2.2, 12).rotateX(Math.PI / 2);
  return {
    parts: { body, carbon, helmet },
    wheel,
    wheelPos: [
      [9.2, WHEEL_R, 4.6],
      [9.2, WHEEL_R, -4.6],
      [-9.4, WHEEL_R, 4.6],
      [-9.4, WHEEL_R, -4.6],
    ],
  };
}

let gltfTemplate: Group | null = null;
const procedural = proceduralTemplate();

/** Try to load the Blender model; silently keeps the stand-in on failure. */
export async function loadCarModel(url = "models/car.glb"): Promise<void> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltfTemplate = gltf.scene;
  } catch {
    gltfTemplate = null;
  }
}

function slotOf(materialName: string): Slot | null {
  const n = materialName.toLowerCase();
  if (n.startsWith("body")) return "body";
  if (n.startsWith("helmet")) return "helmet";
  if (n.startsWith("carbon")) return "carbon";
  if (n.startsWith("tyre") || n.startsWith("tire")) return "tyre";
  return null;
}

/** Build one car, painted with the stock's colours. */
export function buildCar(bodyHex: number, helmetHex: number): CarParts {
  const matFor = (slot: Slot) =>
    slot === "body" ? paint(bodyHex) : slot === "helmet" ? paint(helmetHex) : shared[slot];

  if (gltfTemplate) {
    const root = gltfTemplate.clone(true);
    const wheels: Object3D[] = [];
    root.traverse((o) => {
      if (o.name.startsWith("wheel")) wheels.push(o);
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      const src = mesh.material as MeshStandardMaterial;
      const slot = slotOf(src.name);
      if (slot) mesh.material = matFor(slot);
    });
    const g = new Group();
    g.add(root);
    return { root: g, wheels };
  }

  const root = new Group();
  for (const [slot, geo] of Object.entries(procedural.parts) as [Slot, BufferGeometry][]) {
    const m = new Mesh(geo, matFor(slot));
    m.castShadow = true;
    root.add(m);
  }
  const wheels = procedural.wheelPos.map(([x, y, z]) => {
    const pivot = new Object3D();
    pivot.position.set(x, y, z);
    const w = new Mesh(procedural.wheel, shared.tyre);
    w.castShadow = true;
    pivot.add(w);
    root.add(pivot);
    return pivot;
  });
  return { root, wheels };
}
