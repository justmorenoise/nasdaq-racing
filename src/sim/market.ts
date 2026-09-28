/**
 * US market calendar for the Nasdaq regular session (09:30–16:00 ET, weekdays,
 * exchange holidays excluded). Decides live vs demo mode: out of hours there
 * are no price moves to race on, so the viewer shows a simulated race instead.
 */

const OPEN_SEC = 9.5 * 3600;
const CLOSE_SEC = 16 * 3600;

/** Full-day Nasdaq closures (ET dates). Early closes (13:00) are treated as full days. */
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04",
  "2028-09-04", "2028-11-23", "2028-12-25",
]);

interface EtParts {
  date: string; // YYYY-MM-DD in New York
  secOfDay: number;
  weekday: string; // Mon…Sun
  /** New York wall-clock time read as if it were UTC, minus the real instant. */
  offsetMs: number;
}

function et(nowMs: number): EtParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // some engines emit 24 for midnight
  const y = Number(get("year"));
  const mo = Number(get("month"));
  const d = Number(get("day"));
  const min = Number(get("minute"));
  const s = Number(get("second"));
  const wall = Date.UTC(y, mo - 1, d, hour, min, s);
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    secOfDay: hour * 3600 + min * 60 + s,
    weekday: get("weekday"),
    offsetMs: wall - Math.floor(nowMs / 1000) * 1000,
  };
}

function tradingDay(p: EtParts): boolean {
  return p.weekday !== "Sat" && p.weekday !== "Sun" && !HOLIDAYS.has(p.date);
}

/** Whether the regular session is open at `nowMs`. */
export function marketOpen(nowMs = Date.now()): boolean {
  const p = et(nowMs);
  return tradingDay(p) && p.secOfDay >= OPEN_SEC && p.secOfDay < CLOSE_SEC;
}

/** The instant of the next session open after `nowMs` (null if none within two weeks). */
export function nextOpen(nowMs = Date.now()): number | null {
  for (let day = 0; day < 14; day++) {
    const probe = et(nowMs + day * 86400000);
    if (!tradingDay(probe)) continue;
    const [y, m, d] = probe.date.split("-").map(Number);
    // 09:30 New York wall time on that date, back to an instant (offset taken
    // at 09:30 itself, so a DST switch that day is honoured).
    let at = Date.UTC(y, m - 1, d, 9, 30) - probe.offsetMs;
    at = Date.UTC(y, m - 1, d, 9, 30) - et(at).offsetMs;
    if (at > nowMs) return at;
  }
  return null;
}
