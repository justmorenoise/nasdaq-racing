"""Distil raw OpenStreetMap extracts into compact, stylisable features.

Input:  raw/<slug>.json   (Overpass `out geom`, see query.ql / README.md)
Output: public/osm/<slug>.json, coordinates in metres on a local plane
        (x east, y SOUTH, i.e. screen-like y-down) around the query centre.

The game aligns these to its drawn circuit at load time (src/render3d/osm.ts)
and renders them in the low-poly kit style: this is guidance for *where*
things are (stands, buildings, woods, water, roads, gravel), not a replica.
Data © OpenStreetMap contributors, ODbL.
"""
import json
import math
import os
import sys

CENTRES = {
    "monza": (45.6205, 9.2865),
    "monaco": (43.7347, 7.4206),
    "catalunya": (41.5700, 2.2611),
    "silverstone": (52.0786, -1.0169),
    "spa-francorchamps": (50.4372, 5.9714),
    "suzuka": (34.8431, 136.5410),
    "interlagos": (-23.7036, -46.6997),
}
OUT = os.path.join("..", "..", "public", "osm")
ROAD_W = {
    "motorway": 14, "trunk": 12, "primary": 11, "secondary": 9, "tertiary": 8,
    "unclassified": 6, "residential": 6.5, "living_street": 5, "service": 4.5,
    "primary_link": 7, "secondary_link": 7, "tertiary_link": 6, "trunk_link": 8, "motorway_link": 8,
    "pedestrian": 6,
}


def project(lat0, lon0):
    kx = math.cos(math.radians(lat0)) * 111320.0
    ky = 110540.0

    def f(lat, lon):
        return round((lon - lon0) * kx, 1), round(-(lat - lat0) * ky, 1)

    return f


def dp(pts, eps):
    """Douglas-Peucker simplification (closed rings split at their far point)."""
    if len(pts) < 3:
        return pts
    if pts[0] == pts[-1]:
        far = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
        if far == 0:
            return pts[:1]
        return dp(pts[: far + 1], eps)[:-1] + dp(pts[far:], eps)
    ax, ay = pts[0]
    bx, by = pts[-1]
    dx, dy = bx - ax, by - ay
    L = math.hypot(dx, dy) or 1e-9
    best, idx = 0, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        d = abs(dy * px - dx * py + bx * ay - by * ax) / L
        if d > best:
            best, idx = d, i
    if best > eps:
        return dp(pts[: idx + 1], eps)[:-1] + dp(pts[idx:], eps)
    return [pts[0], pts[-1]]


def obb(pts):
    """Minimum-area oriented box over the hull edges: centre, w, d, angle."""
    best = None
    n = len(pts)
    for i in range(n - 1):
        ex, ey = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
        L = math.hypot(ex, ey)
        if L < 1e-6:
            continue
        ux, uy = ex / L, ey / L
        us = [p[0] * ux + p[1] * uy for p in pts]
        vs = [-p[0] * uy + p[1] * ux for p in pts]
        w, d = max(us) - min(us), max(vs) - min(vs)
        if best is None or w * d < best[0]:
            cu, cv = (max(us) + min(us)) / 2, (max(vs) + min(vs)) / 2
            best = (w * d, cu * ux - cv * uy, cu * uy + cv * ux, w, d, math.atan2(uy, ux))
    if not best:
        return None
    _, cx, cy, w, d, a = best
    return [round(cx, 1), round(cy, 1), round(w, 1), round(d, 1), round(a, 3)]


def trackside(slug, P):
    """Proximity test to the lap (the circuit relation's ways), on a 20 m hash grid."""
    cells = set()
    circ = f"raw/{slug}.circuit.json"
    if os.path.exists(circ):
        for r in json.load(open(circ))["elements"]:
            for m in r.get("members", []):
                g = m.get("geometry") or []
                for a, b in zip(g, g[1:]):
                    ax, ay = P(a["lat"], a["lon"])
                    bx, by = P(b["lat"], b["lon"])
                    k = max(1, int(math.hypot(bx - ax, by - ay) / 10))
                    for t in range(k + 1):
                        cells.add((int((ax + (bx - ax) * t / k) // 20), int((ay + (by - ay) * t / k) // 20)))

    def near(g, r):
        n = int(r // 20) + 1
        for x, y in g:
            ci, cj = int(x // 20), int(y // 20)
            if any((ci + a, cj + b) in cells for a in range(-n, n + 1) for b in range(-n, n + 1)):
                return True
        return False

    return near


def closed(g):
    return len(g) > 3 and g[0] == g[-1]


def main(slug):
    lat0, lon0 = CENTRES[slug]
    P = project(lat0, lon0)
    els = json.load(open(f"raw/{slug}.json"))["elements"]
    out = {k: [] for k in ("raceway", "stands", "buildings", "woods", "water", "coast", "roads", "crossings",
                           "trees", "parking", "gravel", "walls", "fences", "paved")}
    near = trackside(slug, P)
    for e in els:
        t = e.get("tags", {})
        if e["type"] == "node":
            p = P(e["lat"], e["lon"])
            if t.get("natural") == "tree":
                out["trees"].append(p)
            elif t.get("highway") == "crossing":
                out["crossings"].append(p)
            continue
        geoms = []
        if e["type"] == "way" and e.get("geometry"):
            geoms = [[P(g["lat"], g["lon"]) for g in e["geometry"]]]
        elif e["type"] == "relation":
            for m in e.get("members", []):
                if m.get("role") == "outer" and m.get("geometry"):
                    geoms.append([P(g["lat"], g["lon"]) for g in m["geometry"]])
        for g in geoms:
            if len(g) < 2:
                continue
            name = (t.get("name") or "").lower()
            hw = t.get("highway")
            if hw == "raceway":
                out["raceway"].append(dp(g, 2))
            elif t.get("building") == "grandstand" or t.get("man_made") == "grandstand" or "grandstand" in name or "tribun" in name:
                if closed(g):
                    b = obb(g)
                    if b:
                        out["stands"].append(b)
            elif t.get("building") and closed(g):
                b = obb(g)
                if b and b[2] * b[3] > 12:
                    lv = t.get("building:levels")
                    try:
                        lv = float(str(lv).split(";")[0])
                    except (TypeError, ValueError):
                        lv = 0
                    b.append(round(lv, 1))
                    out["buildings"].append(b)
            elif (t.get("natural") == "wood" or t.get("landuse") == "forest") and closed(g):
                out["woods"].append(dp(g, 6))
            elif t.get("natural") == "coastline":
                out["coast"].append(dp(g, 3))
            elif (t.get("natural") == "water" or t.get("landuse") in ("reservoir", "basin")) and closed(g):
                out["water"].append(dp(g, 3))
            elif t.get("amenity") == "parking" and closed(g):
                out["parking"].append(dp(g, 2))
            elif closed(g) and (t.get("surface") in ("gravel", "sand", "fine_gravel", "pebblestone") or t.get("natural") == "sand"):
                out["gravel"].append(dp(g, 2))
            elif hw in ROAD_W and not t.get("tunnel") and not t.get("bridge") == "yes":
                out["roads"].append({"w": ROAD_W[hw], "p": dp(g, 2)})
            elif t.get("barrier") in ("wall", "retaining_wall", "guard_rail") and not closed(g):
                out["walls"].append(dp(g, 2))
            elif t.get("barrier") == "fence" and near(g, 120):
                # Catch fences and spectator fences along the lap: they bound the run-off.
                out["fences"].append(dp(g, 2))
            elif closed(g) and not t.get("building") and (t.get("area:highway") or t.get("surface") in ("asphalt", "concrete", "paved")) and near(g, 60):
                out["paved"].append(dp(g, 2))
    # The circuit relation (type=circuit) gives the full lap even where the
    # track is public road (Monaco); its role-less members are the lap itself.
    out["lap"] = []
    circ = f"raw/{slug}.circuit.json"
    if os.path.exists(circ):
        try:
            rels = json.load(open(circ))["elements"]
        except ValueError:
            rels = []
        if rels:
            for m in rels[0].get("members", []):
                if m["type"] == "way" and m.get("role", "") == "" and m.get("geometry"):
                    out["lap"].append(dp([P(g["lat"], g["lon"]) for g in m["geometry"]], 2))
    out["attribution"] = "© OpenStreetMap contributors (ODbL)"
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{slug}.json")
    json.dump(out, open(path, "w"), separators=(",", ":"))
    print(slug, {k: len(v) for k, v in out.items() if isinstance(v, list)}, os.path.getsize(path) // 1024, "KB")


if __name__ == "__main__":
    for s in sys.argv[1:] or CENTRES:
        main(s)
