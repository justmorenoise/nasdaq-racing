"""Low-poly F1 car for Nasdaq Grand Prix.

Run: Blender --background --factory-startup --python build_car.py
Writes car.blend next to this script and public/models/car.glb.

Conventions the game relies on (src/render3d/CarModel.ts):
  nose along +X, ground at 0, 30 world units long (root scale),
  materials body / helmet / carbon / tyre, wheel nodes wheel_* spinning about
  their local axle with their origin at the hub.
"""
import os
import bpy
import bmesh
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
LENGTH_M = 5.6
SCALE = 30 / LENGTH_M

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def material(name, rgb, rough=0.5, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    return m


MAT = {
    "body": material("body", (0.8, 0.05, 0.05), 0.35, 0.1),
    "helmet": material("helmet", (0.95, 0.85, 0.1), 0.3),
    "carbon": material("carbon", (0.03, 0.035, 0.045), 0.5, 0.2),
    "tyre": material("tyre", (0.02, 0.02, 0.022), 0.9),
    "rim": material("carbon_rim", (0.12, 0.12, 0.14), 0.4, 0.6),
}

root = bpy.data.objects.new("car", None)
scene.collection.objects.link(root)
root.scale = (SCALE, SCALE, SCALE)


def link(name, bm, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(MAT[mat])
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    ob.parent = root
    return ob


def hull(name, pts, mat):
    """Convex hull of a point cloud: quick, clean low-poly volumes."""
    bm = bmesh.new()
    for p in pts:
        bm.verts.new(p)
    bmesh.ops.convex_hull(bm, input=bm.verts)
    # Drop interior leftovers the hull op may keep.
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    return link(name, bm, mat)


def box(x0, x1, y0, y1, z0, z1):
    return [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]


def section(x, hw, z0, z1, top_hw=None):
    """Four corners of a (trapezoid) cross-section at station x."""
    t = hw if top_hw is None else top_hw
    return [(x, -hw, z0), (x, hw, z0), (x, -t, z1), (x, t, z1)]


# --- Chassis ---------------------------------------------------------------
hull("floor", section(-2.15, 0.78, 0.04, 0.09) + section(1.1, 0.78, 0.04, 0.09) + section(1.5, 0.35, 0.05, 0.09), "carbon")
hull("sidepods",
     section(0.55, 0.74, 0.1, 0.58, 0.66) + section(-0.2, 0.72, 0.1, 0.55, 0.6)
     + section(-1.2, 0.5, 0.1, 0.42, 0.34) + section(-1.75, 0.3, 0.1, 0.3, 0.2), "body")
hull("tub", section(-0.3, 0.4, 0.12, 0.66, 0.32) + section(1.05, 0.33, 0.14, 0.62, 0.22), "body")
hull("nose", section(1.0, 0.3, 0.2, 0.62, 0.18) + section(2.2, 0.16, 0.18, 0.42, 0.1) + section(2.95, 0.09, 0.16, 0.28, 0.05), "body")
hull("engine_cover",
     section(-0.15, 0.34, 0.4, 0.8, 0.2) + section(-0.35, 0.3, 0.4, 0.98, 0.14)
     + section(-1.2, 0.24, 0.35, 0.7, 0.1) + section(-2.0, 0.12, 0.3, 0.5, 0.05), "body")
hull("airbox_intake", section(-0.16, 0.1, 0.84, 0.97, 0.08) + section(-0.24, 0.1, 0.84, 0.97, 0.08), "carbon")
# Cockpit opening shadow, sitting on the tub top.
hull("cockpit", section(0.55, 0.24, 0.6, 0.67, 0.2) + section(-0.1, 0.26, 0.6, 0.67, 0.22), "carbon")

# --- Driver + halo ---------------------------------------------------------
bm = bmesh.new()
bmesh.ops.create_icosphere(bm, subdivisions=2, radius=0.15)
bmesh.ops.translate(bm, verts=bm.verts, vec=(0.12, 0, 0.76))
link("helmet", bm, "helmet")
hull("halo_front", box(0.6, 0.66, -0.03, 0.03, 0.62, 0.86), "carbon")
for s in (1, -1):
    hull(f"halo_side_{'l' if s > 0 else 'r'}",
         [(0.6, 0.02 * s, 0.84), (0.6, 0.06 * s, 0.88), (-0.05, 0.24 * s, 0.84), (-0.05, 0.28 * s, 0.88),
          (-0.15, 0.26 * s, 0.66), (-0.1, 0.3 * s, 0.66)], "carbon")

# --- Wings -----------------------------------------------------------------
hull("front_wing_main", section(2.65, 0.98, 0.07, 0.11) + section(3.08, 0.98, 0.07, 0.1), "carbon")
hull("front_wing_flap", section(2.62, 0.96, 0.14, 0.2) + section(2.8, 0.96, 0.12, 0.16), "body")
for s in (1, -1):
    hull(f"front_endplate_{s}", box(2.55, 3.08, 0.97 * s, 1.0 * s, 0.05, 0.3), "carbon")
hull("rear_wing_main", section(-2.3, 0.52, 0.8, 0.86) + section(-1.95, 0.52, 0.82, 0.86), "body")
hull("rear_wing_flap", section(-2.25, 0.52, 0.92, 1.0) + section(-2.05, 0.52, 0.9, 0.95), "carbon")
for s in (1, -1):
    hull(f"rear_endplate_{s}", box(-2.4, -1.85, 0.52 * s, 0.55 * s, 0.35, 1.02), "carbon")
hull("rear_pylon", box(-2.15, -1.95, -0.03, 0.03, 0.4, 0.84), "carbon")
hull("diffuser", section(-1.8, 0.62, 0.05, 0.12) + section(-2.3, 0.62, 0.1, 0.32), "carbon")

# --- Suspension arms (thin) --------------------------------------------------
for x, hw in ((1.8, 0.66), (-1.8, 0.62)):
    for s in (1, -1):
        hull(f"arm_{x}_{s}", [(x - 0.06, 0.3 * s, 0.3), (x + 0.06, 0.3 * s, 0.3), (x, hw * s, 0.34),
                              (x - 0.06, 0.3 * s, 0.33), (x + 0.06, 0.3 * s, 0.33), (x, hw * s, 0.37)], "carbon")

# --- Wheels ------------------------------------------------------------------
R = 0.36


def wheel(name, x, y, width):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=R, radius2=R, depth=width)
    # Cylinder axis Z → Y (the axle).
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(1.5707963, 3, "X"))
    ob = link(name, bm, "tyre")
    ob.location = (x, y, R)
    # Rim disc on the outer face.
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=R * 0.62, radius2=R * 0.62, depth=0.02)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(1.5707963, 3, "X"))
    side = 1 if y > 0 else -1
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, side * (width / 2 + 0.005), 0))
    rim = link("rim" + name[5:], bm, "rim")
    rim.parent = ob
    return ob


wheel("wheel_fl", 1.8, 0.8, 0.3)
wheel("wheel_fr", 1.8, -0.8, 0.3)
wheel("wheel_rl", -1.8, 0.78, 0.4)
wheel("wheel_rr", -1.8, -0.78, 0.4)

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "car.blend"))
bpy.ops.export_scene.gltf(
    filepath=os.path.join(ROOT, "public", "models", "car.glb"),
    export_format="GLB",
    export_yup=True,
    export_apply=True,
    export_materials="EXPORT",
    export_normals=True,
)
print("CAR_OK", len(bpy.data.objects))
