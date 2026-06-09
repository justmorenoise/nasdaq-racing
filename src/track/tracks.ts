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

const lapTimes = lapData as {
  circuito: string;
  tempo_secondi: number;
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
}[];

/** Turn the circuits.json gear map {"1":…,"8":…} into an ordered [g1..g8] array. */
function gearArray(d?: Record<string, number>): number[] | undefined {
  if (!d) return undefined;
  return Array.from({ length: 8 }, (_, i) => d[String(i + 1)] ?? 0);
}

const DEFAULT_WIDTH = 54;

// id → SVG file name, so buildTrack can lazily fetch the selected circuit only.
const fileById: Record<string, string> = {};

// Desired display order (by file slug base).
const ORDER = [
  "monza",
  "monaco",
  "catalunya",
  "silverstone",
  "spa-francorchamps",
  "suzuka",
  "interlagos",
];

// Slug → circuit base, tolerating a trailing variant letter (monza-7b → monza).
const baseSlug = (slug: string) => slug.replace(/-\d+[a-z]?$/, "");

// circuits.json is the source of truth: it lists the available circuits and,
// via `file`, which SVG each one uses. Only metadata is built here (no SVG
// parsing); the geometry is loaded lazily in buildTrack.
const svgTracks: TrackDef[] = lapTimes
  .filter((e) => e.file && svgLoaders[`/circuits/${e.file}`])
  .map((entry): TrackDef => {
    const id = entry.file!.replace(/\.svg$/, "");
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
    };
  })
  .sort((a, b) => {
    const ia = ORDER.indexOf(baseSlug(a.id));
    const ib = ORDER.indexOf(baseSlug(b.id));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
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

export const DEFAULT_TRACK_ID =
  TRACKS.find((t) => t.id.startsWith("monza"))?.id ?? TRACKS[0].id;

export function getTrackDef(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
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
