import { Track, type TrackDef } from "./Track";
import lapData from "../../circuits/circuits.json";

/**
 * Real circuit layouts come from the SVG files in /circuits (the main <path> is
 * the centerline) with base lap times from circuits.json. Names are the real
 * circuit names as provided in that file.
 */
const svgRaw = import.meta.glob("/circuits/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const lapTimes = lapData as {
  circuito: string;
  tempo_secondi: number;
  file?: string;
  verso?: "cw" | "ccw";
}[];

interface SvgPath {
  id: string;
  d: string;
}

function parsePaths(svg: string): SvgPath[] {
  return [...svg.matchAll(/<path\b([^>]*?)\/?>/g)]
    .map((m) => {
      const tag = m[1];
      const d = /\bd="([^"]+)"/.exec(tag)?.[1] ?? "";
      const id = /\bid="([^"]+)"/.exec(tag)?.[1] ?? "";
      return { id, d };
    })
    .filter((p) => p.d);
}

function extractCenterlinePath(svg: string): string {
  // New format tags the centerline `id="centerline"`; older files put it first.
  const paths = parsePaths(svg);
  if (paths.length === 0) throw new Error("No path found in circuit SVG");
  return paths.find((p) => p.id === "centerline")?.d ?? paths[0].d;
}

/**
 * New format: an `id="track"` path whose two closed subpaths are the track's
 * outer and inner edges. Returns the two subpath `d` strings, or undefined for
 * the legacy (centerline-only) format.
 */
function extractEdges(svg: string): [string, string] | undefined {
  const track = parsePaths(svg).find((p) => p.id === "track");
  if (!track) return undefined;
  const subs = (track.d.match(/[Mm][^Mm]*/g) ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return subs.length >= 2 ? [subs[0], subs[1]] : undefined;
}

/** The start/finish marker is the 2nd path in both formats; its 1st coordinate. */
function extractStartMarker(svg: string): [number, number] | undefined {
  const paths = parsePaths(svg);
  if (paths.length < 2) return undefined;
  const m = paths[1].d.match(/[Mm]\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : undefined;
}

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
// via `file`, which SVG each one uses (so e.g. Monza can switch to monza-7b.svg
// without the old monza-7.svg also showing up).
const svgByFile: Record<string, string> = {};
for (const [path, raw] of Object.entries(svgRaw)) {
  svgByFile[path.split("/").pop()!] = raw;
}

const svgTracks: TrackDef[] = lapTimes
  .map((entry): TrackDef | null => {
    const raw = entry.file ? svgByFile[entry.file] : undefined;
    if (!raw) return null;
    return {
      id: entry.file!.replace(/\.svg$/, ""),
      name: entry.circuito,
      baseLapTime: entry.tempo_secondi,
      width: 54,
      svgPath: extractCenterlinePath(raw),
      edges: extractEdges(raw),
      startMarker: extractStartMarker(raw),
      verso: entry.verso,
    };
  })
  .filter((t): t is TrackDef => t !== null)
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

export function buildTrack(id: string): Track {
  return new Track(getTrackDef(id));
}
