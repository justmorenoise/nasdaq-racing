export type RaceState = "pre" | "running" | "finished";

export interface ClockSample {
  state: RaceState;
  /** Seconds since session open, clamped to [0, total]. */
  elapsed: number;
  /** Total session length in seconds. */
  total: number;
  /** elapsed / total in [0, 1]. */
  fraction: number;
}

const OPEN_SEC = 9.5 * 3600; // 09:30 ET
const CLOSE_SEC = 16 * 3600; // 16:00 ET
const REAL_TOTAL = CLOSE_SEC - OPEN_SEC; // 23400s

/**
 * Maps wall-clock time to a race state. Default mode follows the real US market
 * session (09:30–16:00 ET, weekdays). A demo mode runs a compressed session of
 * fixed length from page load, so the product can be shown at any hour.
 */
export class RaceClock {
  private startMs: number;

  constructor(
    private demoSeconds: number | null = null,
    nowMs: number = Date.now(),
  ) {
    this.startMs = nowMs;
  }

  sample(nowMs: number = Date.now()): ClockSample {
    return this.demoSeconds != null
      ? this.sampleDemo(nowMs)
      : this.sampleReal(nowMs);
  }

  private sampleDemo(nowMs: number): ClockSample {
    const total = this.demoSeconds!;
    const elapsedRaw = (nowMs - this.startMs) / 1000;
    const elapsed = Math.min(Math.max(elapsedRaw, 0), total);
    const state: RaceState = elapsedRaw >= total ? "finished" : "running";
    return { state, elapsed, total, fraction: elapsed / total };
  }

  private sampleReal(nowMs: number): ClockSample {
    const { secOfDay, weekend } = etTime(nowMs);
    if (weekend) {
      return { state: "finished", elapsed: REAL_TOTAL, total: REAL_TOTAL, fraction: 1 };
    }
    let state: RaceState = "running";
    if (secOfDay < OPEN_SEC) state = "pre";
    else if (secOfDay >= CLOSE_SEC) state = "finished";
    const elapsed = Math.min(Math.max(secOfDay - OPEN_SEC, 0), REAL_TOTAL);
    return { state, elapsed, total: REAL_TOTAL, fraction: elapsed / REAL_TOTAL };
  }
}

/** Current time-of-day in America/New_York, in seconds, plus weekend flag. */
function etTime(nowMs: number): { secOfDay: number; weekend: boolean } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(nowMs));

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // some engines emit 24 for midnight
  const secOfDay = hour * 3600 + Number(get("minute")) * 60 + Number(get("second"));
  const wd = get("weekday");
  return { secOfDay, weekend: wd === "Sat" || wd === "Sun" };
}
