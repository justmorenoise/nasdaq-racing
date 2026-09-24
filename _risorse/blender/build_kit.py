"""Low-poly scenery kit for Nasdaq Grand Prix (style of _risorse/ref).

Run inside Blender (MCP or: Blender --background --factory-startup --python build_kit.py).
Writes kit.blend next to this script and public/models/kit.glb.

Conventions the game relies on (src/render3d/Kit.ts):
  * every asset is a top-level empty named `kit_<name>` at the origin of its
    footprint (ground level, +X = its "front/along" axis), children are meshes;
  * units are metres (the game scales by PROP_SCALE);
  * a material named `tint*` is white and gets a per-instance colour.
"""
import math
import os
import random

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(bpy.data.filepath)) if bpy.data.filepath else None
HERE = HERE or os.path.join(os.path.expanduser("~"), "dev/workspace/nasdaq_run_game_0626/_risorse/blender")
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
random.seed(7)

# Start from an empty scene without resetting preferences (keeps the MCP add-on alive).
for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
    for block in list(coll):
        coll.remove(block)
scene = bpy.context.scene

_mats = {}


def mat(name, rgb, rough=0.85, metal=0.0):
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.diffuse_color = (*rgb, 1)
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*[c ** 2.2 for c in rgb], 1)  # sRGB → linear
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    _mats[name] = m
    return m


def hexrgb(h):
    return ((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255


def M(name, hexcol, rough=0.85, metal=0.0):
    return mat(name, hexrgb(hexcol), rough, metal)


TINT = M("tint", 0xFFFFFF)
TINT2 = M("tint_b", 0xFFFFFF)
BARK = M("bark", 0x6B4F36)
GLASS = M("glass", 0x3E4E5C, 0.25, 0.3)
FRAME = M("frame", 0xE9E6DF)
ROOF_T = M("roof_terracotta", 0xB0603F)
ROOF_G = M("roof_grey", 0x8C9096)
CONCRETE = M("concrete", 0xC9C6BE)
STEEL = M("steel", 0x8E969E, 0.5, 0.6)
DARK = M("dark", 0x2A2D33)
WHITE = M("white", 0xF1F0EC)
RED = M("red", 0xC8412F)
YELLOW = M("yellow", 0xE9B532)
GREEN_SIGN = M("sign_green", 0x2F7A4F)
SHUTTER = M("shutter", 0x5F8A6A)
WATER_TANK = M("tank", 0xD8D4CA)
SKIN = M("skin", 0xE0B48E)
TYRE = M("tyre", 0x1D1F24)

_current = None


def asset(name):
    global _current
    e = bpy.data.objects.new(f"kit_{name}", None)
    scene.collection.objects.link(e)
    _current = e
    return e


def link(bm, material, name="part"):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    ob.parent = _current
    return ob


def box(material, x0, x1, y0, y1, z0, z1, name="box"):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    bmesh.ops.scale(bm, verts=bm.verts, vec=(x1 - x0, y1 - y0, z1 - z0))
    bmesh.ops.translate(bm, verts=bm.verts, vec=((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    return link(bm, material, name)


def cyl(material, x, y, z0, z1, r, seg=8, r2=None, name="cyl"):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=z1 - z0)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y, (z0 + z1) / 2))
    return link(bm, material, name)


def wheel(x, y, r, w):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=r, radius2=r, depth=w)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, "X"))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y, r))
    return link(bm, TYRE, "wheel")


def blob(material, x, y, z, r, sub=1, squash=1.0, jitter=0.18, name="blob"):
    """Faceted icosphere with jittered vertices: the reference's lumpy canopies."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    for v in bm.verts:
        v.co *= 1 + random.uniform(-jitter, jitter)
        v.co.z *= squash
    bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y, z))
    return link(bm, material, name)


def hull(material, pts, name="hull"):
    bm = bmesh.new()
    for p in pts:
        bm.verts.new(p)
    bmesh.ops.convex_hull(bm, input=bm.verts)
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    return link(bm, material, name)


# ---------------------------------------------------------------- vegetation
def tree_round(name, h, lumps):
    asset(name)
    cyl(BARK, 0, 0, 0, h * 0.45, 0.3, 6, 0.22)
    top = h * 0.58
    for i in range(lumps):
        a = i / lumps * math.tau + random.uniform(-0.3, 0.3)
        rr = h * 0.2
        blob(TINT, math.cos(a) * rr, math.sin(a) * rr, top + random.uniform(-0.3, 0.6), h * random.uniform(0.26, 0.32), 1, 0.88)
    blob(TINT, 0, 0, top + h * 0.2, h * 0.3, 1, 0.85)


def tree_pine(name, h, tiers):
    asset(name)
    cyl(BARK, 0, 0, 0, h * 0.25, 0.25, 6, 0.18)
    for i in range(tiers):
        t = i / tiers
        z0 = h * (0.18 + t * 0.62)
        r = h * (0.3 - t * 0.2)
        cyl(TINT, 0, 0, z0, z0 + h * 0.36, r, 7, 0.02)


def bush(name):
    asset(name)
    for i in range(3):
        a = i * 2.1
        blob(TINT, math.cos(a) * 0.6, math.sin(a) * 0.6, 0.55, random.uniform(0.7, 0.95), 1, 0.75)


tree_round("tree_round_a", 9, 4)
tree_round("tree_round_b", 7, 3)
tree_round("tree_round_c", 11, 5)
tree_pine("tree_pine_a", 13, 3)
tree_pine("tree_pine_b", 10, 4)
bush("bush")


def rock(name):
    asset(name)
    blob(ROOF_G, 0, 0, 0.6, 1.6, 0, 0.7, 0.35)


rock("rock")


# --------------------------------------------------------------- buildings
def windows_on(w, d, floors, fh, x0, y0, shop=False):
    """Window insets on all four facades, 3 m bays."""
    for f in range(floors):
        z = (f + 0.35) * fh
        if shop and f == 0:
            continue
        for side in (0, 1, 2, 3):
            L = w if side in (0, 2) else d
            n = max(1, int(L // 3.2))
            for k in range(n):
                u = -L / 2 + (k + 0.5) * L / n
                if side == 0:
                    box(GLASS, x0 + w / 2 - 0.05, x0 + w / 2 + 0.08, y0 + u - 0.55, y0 + u + 0.55, z, z + 1.5)
                elif side == 2:
                    box(GLASS, x0 - w / 2 - 0.08, x0 - w / 2 + 0.05, y0 + u - 0.55, y0 + u + 0.55, z, z + 1.5)
                elif side == 1:
                    box(GLASS, x0 + u - 0.55, x0 + u + 0.55, y0 + d / 2 - 0.05, y0 + d / 2 + 0.08, z, z + 1.5)
                else:
                    box(GLASS, x0 + u - 0.55, x0 + u + 0.55, y0 - d / 2 - 0.08, y0 - d / 2 + 0.05, z, z + 1.5)


def building(name, w, d, floors, roof="flat", balconies=True, shop=False):
    asset(name)
    fh = 3.1
    H = floors * fh
    box(TINT, -w / 2, w / 2, -d / 2, d / 2, 0, H)
    # Cornice band + base course.
    box(FRAME, -w / 2 - 0.15, w / 2 + 0.15, -d / 2 - 0.15, d / 2 + 0.15, H - 0.35, H)
    box(CONCRETE, -w / 2 - 0.1, w / 2 + 0.1, -d / 2 - 0.1, d / 2 + 0.1, 0, 0.6)
    windows_on(w, d, floors, fh, 0, 0, shop)
    if shop:
        # Shop fronts + striped awnings on the front (+X) facade.
        n = max(1, int(d // 4))
        for k in range(n):
            u = -d / 2 + (k + 0.5) * d / n
            box(GLASS, w / 2 - 0.05, w / 2 + 0.08, u - 1.3, u + 1.3, 0.3, 2.6)
            hull(RED if k % 2 else TINT2, [(w / 2, u - 1.6, 3.0), (w / 2, u + 1.6, 3.0), (w / 2 + 1.6, u - 1.6, 2.4),
                                            (w / 2 + 1.6, u + 1.6, 2.4), (w / 2, u - 1.6, 3.1), (w / 2, u + 1.6, 3.1)])
    if balconies:
        for f in range(1 if shop else 1, floors):
            z = f * fh
            n = max(1, int(d // 4.5))
            for k in range(n):
                u = -d / 2 + (k + 0.5) * d / n
                box(FRAME, w / 2, w / 2 + 1.0, u - 1.1, u + 1.1, z, z + 0.18)
                box(STEEL, w / 2 + 0.9, w / 2 + 1.0, u - 1.1, u + 1.1, z + 0.18, z + 1.0)
                box(SHUTTER, w / 2 + 0.02, w / 2 + 0.1, u - 0.95, u - 0.6, z + 0.35, z + 2.2)
    if roof == "pitched":
        hull(ROOF_T, [(-w / 2 - 0.4, -d / 2 - 0.4, H), (w / 2 + 0.4, -d / 2 - 0.4, H), (-w / 2 - 0.4, d / 2 + 0.4, H),
                      (w / 2 + 0.4, d / 2 + 0.4, H), (-w / 2 - 0.4, 0, H + min(w, d) * 0.32), (w / 2 + 0.4, 0, H + min(w, d) * 0.32)])
    else:
        box(ROOF_G, -w / 2 + 0.3, w / 2 - 0.3, -d / 2 + 0.3, d / 2 - 0.3, H - 0.3, H + 0.05)
        box(CONCRETE, -w / 2 + 1, -w / 2 + 3.2, -d / 2 + 1, -d / 2 + 2.6, H, H + 1.4)  # AC / plant
        cyl(WATER_TANK, w / 4, d / 4, H, H + 1.8, 0.8, 8)
        box(CONCRETE, w / 4 - 1.3, w / 4 + 1.3, -d / 4 - 1.2, -d / 4 + 1.2, H, H + 2.6)  # stair head


building("bld_a", 12, 12, 4, "flat", True, True)
building("bld_b", 10, 14, 5, "pitched", True, False)
building("bld_c", 14, 10, 3, "pitched", False, True)
building("bld_d", 12, 16, 6, "flat", True, False)
building("bld_e", 9, 9, 3, "flat", False, False)
building("bld_f", 16, 12, 7, "flat", True, True)


# ------------------------------------------------------------ trackside kit
def marshal_tower():
    asset("marshal_tower")
    for sx in (-1.2, 1.2):
        for sy in (-1.2, 1.2):
            cyl(STEEL, sx, sy, 0, 7, 0.12, 5)
    for z in (1.8, 3.6, 5.4):
        box(STEEL, -1.3, 1.3, -1.3, 1.3, z, z + 0.12)
    box(WHITE, -1.6, 1.6, -1.6, 1.6, 7, 9.2)
    box(GLASS, 1.55, 1.7, -1.3, 1.3, 7.8, 8.9)
    hull(ROOF_G, [(-2, -2, 9.2), (2, -2, 9.2), (-2, 2, 9.2), (2, 2, 9.2), (0, 0, 10.6)])


marshal_tower()

asset("gantry_post")
box(STEEL, -0.5, 0.5, -0.5, 0.5, 0, 7.5)
box(CONCRETE, -0.9, 0.9, -0.9, 0.9, 0, 0.6)

asset("gantry_beam")  # 1 m long along +Y; the game scales it across the track
box(STEEL, -0.45, 0.45, -0.5, 0.5, 6.6, 7.4)
box(STEEL, -0.08, 0.08, -0.5, 0.5, 7.4, 8.2)

asset("sign_panel")  # 4 m wide green road sign hanging under the gantry
box(GREEN_SIGN, -0.1, 0.1, -2, 2, 7.6, 9.4)
box(WHITE, 0.1, 0.14, -1.6, 1.6, 8.3, 8.7)

asset("lamp")
cyl(STEEL, 0, 0, 0, 7, 0.1, 6)
box(STEEL, 0, 1.4, -0.08, 0.08, 6.9, 7.05)
box(WHITE, 1.1, 1.7, -0.25, 0.25, 6.7, 6.95)

asset("flag")
cyl(STEEL, 0, 0, 0, 6, 0.06, 5)
box(TINT, 0, 1.6, -0.02, 0.02, 4.8, 5.9)

asset("billboard")
for y in (-2.2, 2.2):
    box(STEEL, -0.1, 0.1, y - 0.1, y + 0.1, 0, 3)
box(TINT, -0.15, 0.15, -3, 3, 2.6, 5)
box(WHITE, 0.15, 0.2, -2.4, 2.4, 3.3, 4.2)

asset("tv_platform")
for sx in (-1, 1):
    for sy in (-1, 1):
        cyl(STEEL, sx, sy, 0, 4, 0.1, 5)
box(DARK, -1.3, 1.3, -1.3, 1.3, 4, 4.25)
box(DARK, -0.3, 0.6, -0.3, 0.3, 4.25, 5.2)
cyl(DARK, 0.2, 0, 5.2, 5.5, 0.12, 6)

asset("tent")  # paddock gazebo
for sx in (-2, 2):
    for sy in (-2, 2):
        cyl(STEEL, sx, sy, 0, 2.4, 0.05, 4)
hull(WHITE, [(-2.2, -2.2, 2.4), (2.2, -2.2, 2.4), (-2.2, 2.2, 2.4), (2.2, 2.2, 2.4), (0, 0, 3.6)])
box(TINT, -2.2, 2.2, -2.2, -2.15, 2.1, 2.4)

asset("truck")  # team transporter, trailer tinted
box(TINT, -7, 5, -1.25, 1.25, 1.0, 4.0)
box(WHITE, -7.02, 5.02, -1.27, 1.27, 3.7, 4.0)
box(DARK, 5, 7.6, -1.2, 1.2, 0.9, 3.6)
box(GLASS, 7.55, 7.65, -1.0, 1.0, 2.3, 3.3)
for x in (-6, -4.6, 3.5, 6.4):
    for y in (-1.15, 1.15):
        wheel(x, y, 0.5, 0.35)

asset("motorhome")
box(WHITE, -5, 5, -1.3, 1.3, 0.5, 3.4)
box(TINT, -5.02, 5.02, -1.32, 1.32, 1.4, 1.8)
box(GLASS, -3.5, 3.5, 1.3, 1.36, 1.9, 2.8)

asset("car_parked")
box(TINT, -2.1, 2.1, -0.9, 0.9, 0.35, 1.0)
hull(TINT, [(-1.3, -0.8, 1.0), (1.0, -0.8, 1.0), (-1.3, 0.8, 1.0), (1.0, 0.8, 1.0), (-1.0, -0.7, 1.5), (0.5, -0.7, 1.5), (-1.0, 0.7, 1.5), (0.5, 0.7, 1.5)])
box(GLASS, 0.5, 1.02, -0.72, 0.72, 1.02, 1.45)
for x in (-1.3, 1.3):
    for y in (-0.85, 0.85):
        box(TYRE, x - 0.35, x + 0.35, y - 0.12, y + 0.12, 0, 0.62)

asset("person")
box(DARK, -0.15, 0.15, -0.2, 0.2, 0, 0.85)
box(TINT, -0.18, 0.18, -0.25, 0.25, 0.85, 1.45)
blob(SKIN, 0, 0, 1.62, 0.16, 1, 1.0, 0.05)

asset("telehandler")  # the yellow recovery crane of the refs
box(YELLOW, -2.2, 2.2, -1.1, 1.1, 0.7, 1.8)
box(YELLOW, -0.6, 1.2, 0.2, 1.1, 1.8, 3.2)
box(GLASS, 1.15, 1.25, 0.3, 1.0, 2.2, 3.0)
hull(YELLOW, [(-2.0, -0.35, 1.9), (-2.0, 0.35, 1.9), (-2.0, -0.35, 2.5), (-2.0, 0.35, 2.5),
              (5.5, -0.25, 5.8), (5.5, 0.25, 5.8), (5.5, -0.25, 6.3), (5.5, 0.25, 6.3)])
box(DARK, 5.4, 6.2, -0.8, 0.8, 5.0, 5.3)
for x in (-1.5, 1.5):
    for y in (-1.15, 1.15):
        wheel(x, y, 0.65, 0.5)

asset("barrier_banner")  # 4 m of concrete wall with a sponsor banner (tinted)
box(CONCRETE, -2, 2, -0.35, 0.35, 0, 1.1)
box(TINT, -2, 2, 0.35, 0.4, 0.1, 1.0)
box(WHITE, -1.4, 1.4, 0.4, 0.43, 0.4, 0.7)

asset("fence")  # 4 m catch-fence bay: posts + top rail (mesh drawn in code)
box(STEEL, -0.06, 0.06, -0.06, 0.06, 0, 4.2)
box(STEEL, -2, 2, -0.04, 0.04, 4.1, 4.2)

asset("yacht")
hull(WHITE, [(-9, -2.2, 0), (7, -2.2, 0), (-9, 2.2, 0), (7, 2.2, 0), (10, 0, 0.3), (-9, -2.4, 2), (8, -2.4, 2), (-9, 2.4, 2), (8, 2.4, 2), (11, 0, 2.2)])
box(WHITE, -6, 3, -1.8, 1.8, 2, 3.6)
box(GLASS, -5, 2.5, -1.85, 1.85, 2.4, 3.2)
box(WHITE, -4, 1, -1.4, 1.4, 3.6, 4.6)

asset("boat")
hull(TINT, [(-3, -1, 0), (2.5, -1, 0), (-3, 1, 0), (2.5, 1, 0), (3.6, 0, 0.3), (-3, -1.1, 1), (3, -1.1, 1), (-3, 1.1, 1), (3, 1.1, 1), (4, 0, 1.1)])
box(WHITE, -1.5, 0.5, -0.7, 0.7, 1, 1.9)

asset("lighthouse")
cyl(WHITE, 0, 0, 0, 12, 1.4, 10, 1.0)
for z in (2, 6):
    cyl(RED, 0, 0, z, z + 2, 1.32 - z * 0.03, 10, 1.24 - z * 0.03)
cyl(GLASS, 0, 0, 12, 13.4, 0.8, 8)
cyl(RED, 0, 0, 13.4, 14.4, 1.0, 8, 0.1)

asset("dock_crane")
for sx in (-2.5, 2.5):
    for sy in (-2.5, 2.5):
        box(YELLOW, sx - 0.25, sx + 0.25, sy - 0.25, sy + 0.25, 0, 14)
box(YELLOW, -3, 3, -3, 3, 14, 16)
box(YELLOW, -12, 18, -0.6, 0.6, 16, 17.4)
box(DARK, 1, 4, -1.4, 1.4, 16, 18.5)

asset("container")
box(TINT, -3, 3, -1.2, 1.2, 0, 2.6)
for x in (-2.5, -1.5, -0.5, 0.5, 1.5, 2.5):
    box(TINT, x - 0.08, x + 0.08, -1.25, 1.25, 0.1, 2.5)

asset("umbrella")
cyl(STEEL, 0, 0, 0, 2.2, 0.04, 4)
cyl(TINT, 0, 0, 2.0, 2.5, 1.4, 8, 0.05)

# Low-poly flat shading everywhere.
for ob in scene.objects:
    if ob.type == "MESH":
        for p in ob.data.polygons:
            p.use_smooth = False

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "kit.blend"), copy=True)
bpy.ops.export_scene.gltf(
    filepath=os.path.join(ROOT, "public", "models", "kit.glb"),
    export_format="GLB",
    export_yup=True,
    export_apply=True,
    export_materials="EXPORT",
)
result = {"assets": sorted(o.name for o in scene.objects if o.name.startswith("kit_"))}
print("KIT_OK", result)
