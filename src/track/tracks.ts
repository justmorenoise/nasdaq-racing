import { Track, type TrackDef, SVG_SCALE, orientByVerso } from "./Track";
import { parseCircuitSvg } from "./svgParse";
import lapData from "../../circuits/circuits.json";

/**
 * Real circuit layouts live in the SVG files in /circuits, listed (with base lap
 * times) in circuits.json. The glob is **lazy**: only the SVG of the circuit
 * actually built gets fetched — the track menu needs just id+name from the JSON,
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
  file?: string;
  verso?: "cw" | "ccw";
  /** Per-circuit size lever: multiplies fallback width and car size (default 1). */
  scale?: number;
  /** Per-circuit kerb size lever: multiplies kerb width + cell length (default 1). */
  kerbScale?: number;
  /** Fallback ribbon width override in source units (default 54). */
  width?: number;
  /** Gear-usage distribution: % of the lap per gear, keyed "1".."8". */
  distribuzione_marce?: Record<string, number>;
  /** Per-corner telemetry: speed (km/h) + gear at distances around the lap. */
  telemetria?: { punto?: string; distanza_metri: number; velocita_kmh: number; marcia: number }[];
}

const lapTimes = lapData as TrackEntry[];

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
      scale,
      kerbScale: entry.kerbScale ?? 1,
      verso: entry.verso,
      gearDistribution: gearArray(entry.distribuzione_marce),
      telemetry: telemetryPoints(entry.telemetria),
      lapLengthM: entry.lunghezza_metri,
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

/**
 * Construct a track. SVG circuits fetch their (single) file lazily and parse it
 * transform-aware (honoring `<g transform>`); hand-made tracks build from points.
 */
export async function buildTrack(id: string): Promise<Track> {
  const def = getTrackDef(id);
  const file = fileById[def.id];
  if (!file) return new Track(def); // hand-made (oval): centerline from points
  const raw = await svgLoaders[`/circuits/${file}`]();
  const parsed = parseCircuitSvg(raw, SVG_SCALE);
  const centerline = orientByVerso(parsed.centerline, def.verso);
  const fullDef: TrackDef = { ...def, edgeLoops: parsed.loops, startWorld: parsed.start };
  return new Track(fullDef, centerline);
}
