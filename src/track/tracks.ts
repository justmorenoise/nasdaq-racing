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

function allPaths(svg: string): string[] {
  return [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
}

function extractCenterlinePath(svg: string): string {
  // The first <path d="..."> in these files is the track centerline.
  const paths = allPaths(svg);
  if (paths.length === 0) throw new Error("No path found in circuit SVG");
  return paths[0];
}

/** The 2nd path is the start/finish marker; return its first coordinate. */
function extractStartMarker(svg: string): [number, number] | undefined {
  const paths = allPaths(svg);
  if (paths.length < 2) return undefined;
  const m = paths[1].match(/[Mm]\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : undefined;
}

function lapTimeFor(
  base: string,
): { name: string; time: number; verso?: "cw" | "ccw" } | null {
  const entry = lapTimes.find((c) => c.circuito.toLowerCase() === base);
  return entry
    ? { name: entry.circuito, time: entry.tempo_secondi, verso: entry.verso }
    : null;
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

const svgTracks: TrackDef[] = Object.entries(svgRaw)
  .map(([path, raw]): TrackDef | null => {
    const slug = path.split("/").pop()!.replace(/\.svg$/, ""); // e.g. monza-7
    const base = slug.replace(/-\d+$/, ""); // e.g. monza
    const lap = lapTimeFor(base);
    if (!lap) return null;
    return {
      id: slug,
      name: lap.name,
      baseLapTime: lap.time,
      width: 54,
      svgPath: extractCenterlinePath(raw),
      startMarker: extractStartMarker(raw),
      verso: lap.verso,
    };
  })
  .filter((t): t is TrackDef => t !== null)
  .sort((a, b) => {
    const ia = ORDER.indexOf(a.id.replace(/-\d+$/, ""));
    const ib = ORDER.indexOf(b.id.replace(/-\d+$/, ""));
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
