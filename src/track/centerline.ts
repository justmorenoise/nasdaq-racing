export interface Pt {
  x: number;
  y: number;
}

/**
 * Sample an SVG path's `d` string into a dense, arc-length-uniform polyline
 * using the browser's path geometry (handles every path command correctly).
 * @param scale multiply coordinates so the layout matches the world scale the
 *   car/profile constants expect (~0..1500).
 */
export function sampleSvgPath(d: string, count: number, scale = 1): Pt[] {
  const path = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );
  path.setAttribute("d", d);
  const total = path.getTotalLength();
  const pts: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const p = path.getPointAtLength((i / count) * total);
    pts.push({ x: p.x * scale, y: p.y * scale });
  }
  return pts;
}

/** Catmull-Rom basis (uniform, tension 0.5), position only. */
function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const a = 2 * p1;
  const b = -p0 + p2;
  const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
  const d = -p0 + 3 * p1 - 3 * p2 + p3;
  return 0.5 * (a + b * t + c * t * t + d * t * t * t);
}

/** Smooth a sparse closed list of control points into a dense polyline. */
export function catmullRomPolyline(
  control: [number, number][],
  subdiv: number,
): Pt[] {
  const n = control.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = control[(i - 1 + n) % n];
    const p1 = control[i];
    const p2 = control[(i + 1) % n];
    const p3 = control[(i + 2) % n];
    for (let j = 0; j < subdiv; j++) {
      const t = j / subdiv;
      out.push({
        x: cr(p0[0], p1[0], p2[0], p3[0], t),
        y: cr(p0[1], p1[1], p2[1], p3[1], t),
      });
    }
  }
  return out;
}
