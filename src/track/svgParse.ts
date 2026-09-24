import type { Pt } from "./centerline";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Result of parsing a circuit SVG: centerline, optional real edge loops, start. */
export interface ParsedCircuit {
  /** Dense centerline polyline, already scaled to world units. */
  centerline: Pt[];
  /** Closed edge loops (outer + N inner islands), scaled. Undefined if the file
   *  has no `#track` geometry (legacy centerline-only layouts). */
  loops?: Pt[][];
  /** Start/finish marker in world coords, if a marker path is present. */
  start?: Pt;
}

/**
 * Parse a circuit SVG honoring `<g>` grouping and `transform="matrix(…)"`.
 *
 * The regex approach this replaces read only `<path>` ids/coords and silently
 * ignored ancestor transforms, so layouts whose `#track`/`#centerline` live on a
 * transformed `<g>` (e.g. suzuka-2b) fell back to a fixed-width ribbon. Here we
 * parse into a *live* (hidden) DOM so the browser's `getCTM()` gives each path's
 * cumulative transform, which we bake into the sampled points. Files with no
 * transforms (identity CTM) sample identically to before - no regression.
 */
export function parseCircuitSvg(raw: string, scale: number): ParsedCircuit {
  const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
  const svg = doc.documentElement as unknown as SVGSVGElement;

  // getCTM only returns a matrix for elements rendered in the document.
  const holder = document.createElement("div");
  holder.style.cssText =
    "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden;";
  holder.appendChild(svg);
  document.body.appendChild(holder);
  try {
    const centerEl = firstPath(svg.querySelector("#centerline")) ?? firstPath(svg);
    if (!centerEl) throw new Error("No centerline path found in circuit SVG");
    const centerline = samplePathEl(centerEl, SVG_SAMPLES, scale);

    const trackEl = svg.querySelector("#track");
    const loops = trackEl ? collectLoops(trackEl, scale) : undefined;

    const start = findStart(svg, centerEl, trackEl, scale);
    return { centerline, loops: loops && loops.length ? loops : undefined, start };
  } finally {
    holder.remove();
  }
}

const SVG_SAMPLES = 520;

/** The element itself if a `<path>`, else its first descendant `<path>`. */
function firstPath(el: Element | null): SVGPathElement | null {
  if (!el) return null;
  if (el.tagName.toLowerCase() === "path") return el as SVGPathElement;
  return el.querySelector("path");
}

/** Cumulative transform from a (rendered) element's user space to the SVG root. */
function ctmOf(el: SVGGraphicsElement): DOMMatrix {
  return el.getCTM() ?? new DOMMatrix();
}

function applyM(m: DOMMatrix, x: number, y: number, scale: number): Pt {
  return { x: (m.a * x + m.c * y + m.e) * scale, y: (m.b * x + m.d * y + m.f) * scale };
}

/** Sample a `d` string into `count` arc-length-uniform points (local coords). */
function sampleD(d: string, count: number): Pt[] {
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", d);
  const total = p.getTotalLength();
  const out: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const pt = p.getPointAtLength((i / count) * total);
    out.push({ x: pt.x, y: pt.y });
  }
  return out;
}

/** Sample a live path element, baking its CTM and the world scale into points. */
function samplePathEl(el: SVGPathElement, count: number, scale: number): Pt[] {
  const m = ctmOf(el);
  return sampleD(el.getAttribute("d") ?? "", count).map((p) => applyM(m, p.x, p.y, scale));
}

/** Split a `d` into its `M`/`m` subpaths (each isolated moveto is absolute). */
function subpaths(d: string): string[] {
  return (d.match(/[Mm][^Mm]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/**
 * All closed edge loops under `#track`: every `<path>` (the element itself or, if
 * it's a `<g>`, its descendant paths), split into subpaths so a single fill path
 * carrying outer + multiple inner islands yields one loop each. Each path's own
 * CTM is applied, so nested transforms land the loops in world space.
 */
function collectLoops(trackEl: Element, scale: number): Pt[][] {
  const paths =
    trackEl.tagName.toLowerCase() === "path"
      ? [trackEl as SVGPathElement]
      : Array.from(trackEl.querySelectorAll("path"));
  const loops: Pt[][] = [];
  for (const path of paths) {
    const m = ctmOf(path);
    for (const sub of subpaths(path.getAttribute("d") ?? "")) {
      const loop = sampleD(sub, SVG_SAMPLES).map((p) => applyM(m, p.x, p.y, scale));
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/**
 * Start/finish marker: the `#start` path if present, else the first `<path>` that
 * is neither the centerline nor part of `#track`. Its first point in world space.
 */
function findStart(
  svg: SVGSVGElement,
  centerEl: SVGPathElement,
  trackEl: Element | null,
  scale: number,
): Pt | undefined {
  const explicit = firstPath(svg.querySelector("#start"));
  let el = explicit;
  if (!el) {
    for (const p of Array.from(svg.querySelectorAll("path"))) {
      if (p === centerEl) continue;
      if (trackEl && (trackEl === p || trackEl.contains(p))) continue;
      el = p as SVGPathElement;
      break;
    }
  }
  if (!el) return undefined;
  const m = ctmOf(el);
  const p0 = el.getPointAtLength(0);
  return applyM(m, p0.x, p0.y, scale);
}
