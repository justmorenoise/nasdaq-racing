import { Track, type TrackDef, type TrackTheme, SVG_SCALE, UNITS_PER_METRE, orientByVerso } from "./Track";
import type { Pt } from "./centerline";
import { parseCircuitSvg } from "./svgParse";
import lapData from "../../circuits/circuits.json";

/**
 * Real circuit layouts live in the SVG files in /circuits, listed (with base lap
 * times) in circuits.json. The glob is **lazy**: only the SVG of the circuit
 * actually built gets fetched - the track menu needs just id+name from the JSON,
 * and switching tracks reloads the page, so one SVG is ever loaded per session.
 */
const svgLoaders = import.meta.glob("/circuits/*.svg", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

interface TrackEntry {
  circuito: string;
  /** Stable, human-readable id used in the ?track= URL and the <select>. */
  slug?: string;
  tempo_secondi: number;
  /** Real lap length in metres (for aligning telemetry distances). */
  lunghezza_metri?: number;
  /** Real asphalt width in metres (used with the OSM geometry). */
  larghezza_metri?: number;
  file?: string;
  verso?: "cw" | "ccw";
  /** Scenery theme (default "parco"): trees and grass, a forest, a city, or a harbour city. */
  tema?: TrackTheme;
  /** Street circuit: barriers at the kerb, sidewalks and buildings instead of run-off. */
  cittadino?: boolean;
  /** Tunnels as [from-sector, to-sector] telemetry labels (the "to" sector's braking starts just after the exit). */
  gallerie?: [string, string][];
  /** Per-circuit size lever: multiplies fallback width and car size (default 1). */
  scale?: number;
  /** Per-circuit kerb size lever: multiplies kerb width + cell length (default 1). */
  kerbScale?: number;
  /** Fallback ribbon width override in source units (default 54). */
  width?: number;
  /** Gear-usage distribution: % of the lap per gear, keyed "1".."8". */
  distribuzione_marce?: Record<string, number>;
  /** Real elevation profile [metres along the lap, metres above the lowest point] (Fast-F1 Z). */
  altimetria?: [number, number][];
  /** Per-corner telemetry: speed (km/h) + gear at distances around the lap. */
  telemetria?: { punto?: string; distanza_metri: number; velocita_kmh: number; marcia: number }[];
}

const lapTimes = lapData as unknown as TrackEntry[];

/** Turn the circuits.json gear map {"1":…,"8":…} into an ordered [g1..g8] array. */
function gearArray(d?: Record<string, number>): number[] | undefined {
  if (!d) return undefined;
  return Array.from({ length: 8 }, (_, i) => d[String(i + 1)] ?? 0);
}

/** Map circuits.json telemetry rows to the internal TelemetryPoint shape. */
function telemetryPoints(rows?: TrackEntry["telemetria"]) {
  if (!rows?.length) return undefined;
  return rows.map((r) => ({
    label: r.punto,
    distM: r.distanza_metri,
    kmh: r.velocita_kmh,
    gear: r.marcia,
  }));
}

const DEFAULT_WIDTH = 54;

// id → SVG file name, so buildTrack can lazily fetch the selected circuit only.
const fileById: Record<string, string> = {};

// circuits.json is the source of truth: it lists the available circuits (in the
// order they should appear in the menu) and, via `file`, which SVG each one uses.
// Each circuit's `slug` is its stable id; if absent we fall back to the file name
// minus its variant suffix (monza-7b.svg → monza). Only metadata is built here
// (no SVG parsing); the geometry is loaded lazily in buildTrack.
const svgTracks: TrackDef[] = lapTimes
  .filter((e) => e.file && svgLoaders[`/circuits/${e.file}`])
  .map((entry): TrackDef => {
    const id = entry.slug ?? entry.file!.replace(/\.svg$/, "").replace(/-\d+[a-z]?$/, "");
    const scale = entry.scale ?? 1;
    fileById[id] = entry.file!;
    return {
      id,
      name: entry.circuito,
      baseLapTime: entry.tempo_secondi,
      width: (entry.width ?? DEFAULT_WIDTH) * scale,
      widthM: entry.larghezza_metri,
      scale,
      kerbScale: entry.kerbScale ?? 1,
      verso: entry.verso,
      theme: entry.tema,
      street: entry.cittadino ?? false,
      tunnels: entry.gallerie,
      gearDistribution: gearArray(entry.distribuzione_marce),
      telemetry: telemetryPoints(entry.telemetria),
      lapLengthM: entry.lunghezza_metri,
      elevation: entry.altimetria,
    };
  });

// American-style superspeedway oval (hand-made, since none of the real set is an oval).
const libertyOval: TrackDef = {
  id: "liberty-oval",
  name: "Liberty Oval",
  baseLapTime: 42,
  width: 58,
  points: [
    [1440, 430],
    [1252, 635],
    [800, 722],
    [348, 635],
    [160, 430],
    [348, 225],
    [800, 138],
    [1252, 225],
  ],
  verso: "cw",
};

export const TRACKS: TrackDef[] = [...svgTracks, libertyOval];

// Default = the first circuit listed in circuits.json (the menu's top entry).
export const DEFAULT_TRACK_ID = TRACKS[0].id;

export function getTrackDef(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}

/**
 * Resolve a `?track=` URL value to a track id. The primary, versatile scheme is
 * a **numeric index** into TRACKS (`?track=0`, `?track=1`, …), which stays valid
 * however circuits are named; an explicit slug/id (`?track=monza`) is still
 * accepted for hand-written or older links. Anything else falls back to the
 * default circuit.
 */
export function resolveTrackParam(param: string | null): string {
  if (param) {
    if (/^\d+$/.test(param)) {
      const i = Number(param);
      if (i >= 0 && i < TRACKS.length) return TRACKS[i].id;
    }
    const byId = TRACKS.find((t) => t.id === param);
    if (byId) return byId.id;
  }
  return DEFAULT_TRACK_ID;
}

/** The `?track=` value (index into TRACKS) to write for a given track id. */
export function trackParamFor(id: string): string {
  const i = TRACKS.findIndex((t) => t.id === id);
  return String(i < 0 ? 0 : i);
}

/** Real layout from OpenStreetMap (`_risorse/osm/track.py`), metres, starting at the timing line. */
interface OsmTrack {
  length: number;
  line: [number, number][];
  pit: [number, number][] | null;
  corners: { n: number; l: string; s: number; d: number }[];
}

async function loadOsmTrack(id: string): Promise<OsmTrack | null> {
  try {
    const res = await fetch(`osm/${id}.track.json`);
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;
    const t = (await res.json()) as OsmTrack;
    return t.line?.length > 50 ? t : null;
  } catch {
    return null;
  }
}

/** The asphalt's two edges as closed loops, offset from the centerline. */
function offsetLoops(line: Pt[], half: number): Pt[][] {
  const n = line.length;
  const side = (sgn: number) =>
    line.map((p, i) => {
      const a = line[(i - 1 + n) % n];
      const b = line[(i + 1) % n];
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: p.x - ((b.y - a.y) / L) * half * sgn, y: p.y + ((b.x - a.x) / L) * half * sgn };
    });
  return [side(1), side(-1)];
}

/**
 * Construct a track. Circuits mapped in OpenStreetMap use the real layout at a
 * uniform scale (UNITS_PER_METRE) with their real asphalt width; otherwise SVG
 * circuits fetch their (single) file lazily and parse it transform-aware
 * (honoring `<g transform>`); hand-made tracks build from points.
 */
export async function buildTrack(id: string): Promise<Track> {
  const def = getTrackDef(id);
  const osm = def.widthM ? await loadOsmTrack(def.id) : null;
  if (osm && def.widthM) {
    const U = UNITS_PER_METRE;
    const centerline = osm.line.map(([x, y]) => ({ x: x * U, y: y * U }));
    const width = def.widthM * U;
    return new Track(
      {
        ...def,
        width,
        scale: 1,
        kerbScale: 1,
        realGeometry: true,
        edgeLoops: offsetLoops(centerline, width / 2),
        startWorld: centerline[0],
        pitLane: osm.pit?.map(([x, y]) => ({ x: x * U, y: y * U })),
        corners: osm.corners.map((c) => ({ n: c.n, letter: c.l, distM: c.d, frac: c.s / osm.length })),
      },
      centerline,
    );
  }
  const file = fileById[def.id];
  if (!file) return new Track(def); // hand-made (oval): centerline from points
  const raw = await svgLoaders[`/circuits/${file}`]();
  const parsed = parseCircuitSvg(raw, SVG_SCALE);
  const centerline = orientByVerso(parsed.centerline, def.verso);
  const fullDef: TrackDef = { ...def, edgeLoops: parsed.loops, startWorld: parsed.start };
  return new Track(fullDef, centerline);
}
