"""Real circuit geometry from OpenStreetMap, for the game's track builder.

Input:  raw/<slug>.circuit.json  (the `type=circuit` relation, see README.md)
        raw/<slug>.f1.json       (Fast-F1 fastest Q lap path + corners, ~/dev/fastf1_work/geometry.py)
Output: public/osm/<slug>.track.json, metres on the same local plane as process.py
        (x east, y south):
          line    the lap centerline every STEP m, starting at the timing line, in race direction
          pit     the pit lane polyline, entry → exit (may be missing)
          corners official corner numbers at their arc-length `s` along `line` and F1 lap distance `d`

The OSM relation gives the geometry; the Fast-F1 lap, rigidly fitted onto it, gives
where the lap starts and which way it runs (and picks the right relation when a
circuit has several layouts). Needs numpy + scipy (the Fast-F1 venv has both).
"""
import json
import math
import os
import sys

import numpy as np
from scipy.spatial import cKDTree

from process import CENTRES, project

STEP = 3.0
OUT = os.path.join("..", "..", "public", "osm")


def chain(ways):
    """Join way polylines end to end into closed rings (longest first)."""
    left = [np.asarray(w, float) for w in ways if len(w) > 1]
    rings = []
    while left:
        cur = left.pop(0)
        grown = True
        while grown:
            grown = False
            if np.hypot(*(cur[0] - cur[-1])) < 1.5 and len(cur) > 3:
                break
            for k, w in enumerate(left):
                if np.hypot(*(w[0] - cur[-1])) < 1.5:
                    cur = np.vstack([cur, w[1:]])
                elif np.hypot(*(w[-1] - cur[-1])) < 1.5:
                    cur = np.vstack([cur, w[::-1][1:]])
                else:
                    continue
                left.pop(k)
                grown = True
                break
        if np.hypot(*(cur[0] - cur[-1])) < 1.5:
            rings.append(cur[:-1])
    return sorted(rings, key=lambda r: -ring_length(r))


def ring_length(r):
    return float(np.sum(np.hypot(*(np.roll(r, -1, 0) - r).T)))


def resample(r, step, closed=True):
    pts = np.vstack([r, r[:1]]) if closed else r
    seg = np.hypot(*np.diff(pts, axis=0).T)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = max(2, int(round(s[-1] / step)))
    t = np.linspace(0, s[-1], n, endpoint=not closed)
    return np.column_stack([np.interp(t, s, pts[:, 0]), np.interp(t, s, pts[:, 1])])


def smooth_ring(r, sigma_pts):
    """Circular Gaussian smoothing: removes the Douglas-Peucker kinks OSM ways carry."""
    k = int(3 * sigma_pts)
    w = np.exp(-0.5 * (np.arange(-k, k + 1) / sigma_pts) ** 2)
    w /= w.sum()
    pad = np.vstack([r[-k:], r, r[:k]])
    return np.column_stack([np.convolve(pad[:, i], w, mode="valid") for i in (0, 1)])


def fit(path, ring):
    """Rigid fit (rotation, optional mirror, translation) of the F1 path onto the
    ring: ICP from a sweep of starting angles; returns (rms, transform fn)."""
    tree = cKDTree(ring)
    best = (math.inf, None)
    c_ring = ring.mean(0)
    for mirror in (False, True):
        src0 = path * ([1, -1] if mirror else [1, 1])
        c_src = src0.mean(0)
        for a0 in np.radians(np.arange(0, 360, 15)):
            R = np.array([[math.cos(a0), -math.sin(a0)], [math.sin(a0), math.cos(a0)]])
            t = c_ring - c_src @ R.T
            for _ in range(40):
                cur = src0 @ R.T + t
                _, idx = tree.query(cur)
                dst = ring[idx]
                ms, md = src0.mean(0), dst.mean(0)
                H = (src0 - ms).T @ (dst - md)
                U, _, Vt = np.linalg.svd(H)
                Rn = Vt.T @ U.T
                if np.linalg.det(Rn) < 0:
                    Vt[1] *= -1
                    Rn = Vt.T @ U.T
                R, t = Rn, md - ms @ Rn.T
            d, _ = tree.query(src0 @ R.T + t)
            rms = float(np.sqrt(np.mean(d ** 2)))
            if rms < best[0]:
                best = (rms, (lambda p, R=R, t=t, m=mirror: (np.asarray(p) * ([1, -1] if m else [1, 1])) @ R.T + t))
    return best


def main(slug):
    lat0, lon0 = CENTRES[slug]
    P = project(lat0, lon0)
    f1 = json.load(open(f"raw/{slug}.f1.json"))
    path = np.asarray(f1["path"], float)
    rels = json.load(open(f"raw/{slug}.circuit.json"))["elements"]
    best = None
    for rel in rels:
        seen = set()
        ways = []
        for m in rel["members"]:
            # Some relations list a way twice (Silverstone): chaining would fork.
            if m["type"] == "way" and m.get("role", "") == "" and m.get("geometry") and m["ref"] not in seen:
                seen.add(m["ref"])
                ways.append([P(g["lat"], g["lon"]) for g in m["geometry"]])
        for ring in chain(ways)[:2]:
            ring = resample(ring, 1.0)
            if abs(ring_length(ring) - f1["lap_m"]) > f1["lap_m"] * 0.08:
                continue
            rms, tf = fit(path, ring)
            if best is None or rms < best[0]:
                best = (rms, ring, tf, rel)
    if not best:
        print(slug, "no matching circuit ring")
        return
    rms, ring, tf, rel = best
    ring = smooth_ring(resample(ring, 1.0), 4.0)
    tree = cKDTree(ring)
    fp = tf(path)
    _, i0 = tree.query(fp[0])
    _, i1 = tree.query(fp[min(40, len(fp) - 1)])
    n = len(ring)
    forward = ((i1 - i0) % n) < n / 2
    ring = np.roll(ring, -i0, 0)
    if not forward:
        ring = np.vstack([ring[:1], ring[1:][::-1]])
    line = resample(ring, STEP)
    L = ring_length(line)

    # Corners at their arc-length along the line (the F1 lap distance is the racing line's).
    ltree = cKDTree(line)
    corners = []
    for c in f1["corners"]:
        _, k = ltree.query(tf([[c["x"], c["y"]]])[0])
        corners.append({"n": c["n"], "l": c["l"], "s": round(float(k * L / len(line)), 1), "d": c["d"]})

    pit = None
    pits = [[P(g["lat"], g["lon"]) for g in m["geometry"]] for m in rel["members"]
            if m["type"] == "way" and m.get("role") == "pit_lane" and m.get("geometry")]
    if pits:
        segs = [np.asarray(p, float) for p in pits]
        pl = segs[0]
        for s in segs[1:]:
            ends = [(np.hypot(*(s[0] - pl[-1])), s), (np.hypot(*(s[-1] - pl[-1])), s[::-1]),
                    (np.hypot(*(s[-1] - pl[0])), None), (np.hypot(*(s[0] - pl[0])), None)]
            d, seg = min(ends, key=lambda e: e[0])
            if seg is not None:
                pl = np.vstack([pl, seg[1:]])
            else:
                pl = np.vstack([(s if np.hypot(*(s[-1] - pl[0])) <= np.hypot(*(s[0] - pl[0])) else s[::-1])[:-1], pl])
        pl = resample(pl, STEP, closed=False)
        # Run the pit lane the way the cars do: along the adjacent track's direction.
        _, k = ltree.query(pl[len(pl) // 2])
        tdir = line[(k + 1) % len(line)] - line[k - 1]
        pdir = pl[min(len(pl) - 1, len(pl) // 2 + 1)] - pl[len(pl) // 2 - 1]
        if float(np.dot(tdir, pdir)) < 0:
            pl = pl[::-1]
        pit = [[round(float(x), 1), round(float(y), 1)] for x, y in pl]

    out = {
        "name": rel["tags"].get("name"),
        "length": round(L, 1),
        "line": [[round(float(x), 1), round(float(y), 1)] for x, y in line],
        "pit": pit,
        "corners": corners,
        "attribution": "© OpenStreetMap contributors (ODbL); timing line/direction from Fast-F1",
    }
    json.dump(out, open(os.path.join(OUT, f"{slug}.track.json"), "w"), separators=(",", ":"))
    print(f"{slug:18s} {out['name'][:28]:28s} L={L:6.0f} m (F1 {f1['lap_m']:.0f})  fit rms {rms:4.1f} m  "
          f"pit {'yes' if pit else 'no '}  corners {len(corners)}")


if __name__ == "__main__":
    for s in sys.argv[1:] or CENTRES:
        main(s)
