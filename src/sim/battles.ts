import { CONFIG } from "../config";
import type { Track } from "../track/Track";
import type { Car } from "./Car";

export interface Battle {
  /** Stable id (sorted symbols) so chips persist while membership holds. */
  id: string;
  symbols: string[];
  /** The car to frame when the battle is clicked (front of the group). */
  lead: string;
}

function makeBattle(group: Car[], leadBy: (c: Car) => number): Battle {
  const symbols = group.map((c) => c.symbol);
  const lead = group.reduce((a, b) => (leadBy(b) > leadBy(a) ? b : a));
  return {
    id: [...symbols].sort().join("|"),
    symbols,
    lead: lead.symbol,
  };
}

/**
 * Detect clusters of cars in a duel. Two strategies (config-selectable) kept for
 * comparison:
 *  - 'perf': stocks whose daily % change are within a small window of each other.
 *  - 'track': cars physically close on the circuit (a real visual battle).
 * Multiple battles can be returned. Groups are capped to keep chips meaningful.
 */
export function detectBattles(cars: Iterable<Car>, track: Track): Battle[] {
  return CONFIG.battle.strategy === "perf"
    ? byPerformance(cars)
    : byTrackProximity(cars, track);
}

function byPerformance(cars: Iterable<Car>): Battle[] {
  const sorted = [...cars].sort((a, b) => b.changePct - a.changePct);
  const { perfPctWindow, maxGroupSize } = CONFIG.battle;
  const battles: Battle[] = [];
  let group: Car[] = [];

  const flush = () => {
    if (group.length >= 2) battles.push(makeBattle(group, (c) => c.changePct));
    group = [];
  };

  for (const car of sorted) {
    if (group.length === 0) {
      group = [car];
    } else if (
      group[group.length - 1].changePct - car.changePct <= perfPctWindow &&
      group.length < maxGroupSize
    ) {
      group.push(car);
    } else {
      flush();
      group = [car];
    }
  }
  flush();
  return battles;
}

function byTrackProximity(cars: Iterable<Car>, track: Track): Battle[] {
  const L = track.length;
  const maxGap = L * CONFIG.battle.trackGapFrac;
  const { maxGroupSize } = CONFIG.battle;

  // Sort by position along the lap (wrapped), then sweep adjacency, including
  // the wrap-around seam.
  const sorted = [...cars]
    .map((c) => ({ car: c, pos: track.wrap(c.progress) }))
    .sort((a, b) => a.pos - b.pos);
  if (sorted.length < 2) return [];

  const battles: Battle[] = [];
  let group: Car[] = [sorted[0].car];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].pos - sorted[i - 1].pos;
    if (gap <= maxGap && group.length < maxGroupSize) {
      group.push(sorted[i].car);
    } else {
      if (group.length >= 2)
        battles.push(makeBattle(group, (c) => c.progress));
      group = [sorted[i].car];
    }
  }
  if (group.length >= 2) battles.push(makeBattle(group, (c) => c.progress));
  return battles;
}
