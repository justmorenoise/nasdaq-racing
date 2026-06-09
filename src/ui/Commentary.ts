import type { Car } from "../sim/Car";
import type { Battle } from "../sim/battles";

/**
 * "Race radio" — a small live feed of one-line commentary derived from the same
 * race state the rest of the UI reads (standings, on-track order, battles, big
 * % moves). Newest line on top; lines fade out after a few seconds. The feed is
 * rate-limited and de-duplicated so it reads like a commentator, not a log.
 */
const COOLDOWN_MS = 2200; // min gap between spoken lines
const LINE_TTL_MS = 10000; // how long a line stays on screen
const MAX_LINES = 3;
const MOVE_THRESHOLD = 0.5; // % move over the sample window worth calling out
const SAMPLE_AGE_MS = 6000; // window for the big-mover comparison
const TOP_N = 14; // only narrate the front of the field

/** A clickable, highlighted ticker symbol inside a commentary line. */
function symSpan(s: string): string {
  return `<span class="radio-sym" data-sym="${s}">${s}</span>`;
}

export class Commentary {
  readonly el = document.createElement("div");
  private lastSpoke = 0;
  private prevLeader: string | null = null;
  private prevRank = new Map<string, number>();
  private pctSample = new Map<string, { pct: number; t: number }>();
  private seenBattles = new Map<string, number>(); // id → last announced (ms)

  constructor(private onSelect: (symbol: string) => void) {
    this.el.className = "commentary";
    // Clicking a ticker name in a line follows that car.
    this.el.addEventListener("click", (e) => {
      const hit = (e.target as HTMLElement).closest(".radio-sym") as HTMLElement | null;
      if (hit?.dataset.sym) this.onSelect(hit.dataset.sym);
    });
  }

  /** Feed the latest race state; emits at most one line per cooldown. */
  update(standings: Car[], order: Car[], battles: Battle[]): void {
    const now = performance.now();
    const msg = this.pickMessage(standings, order, battles, now);

    // Always keep the derived state fresh, even when we don't speak.
    this.prevLeader = standings[0]?.symbol ?? null;
    this.prevRank = new Map(order.map((c, i) => [c.symbol, i]));

    if (msg && now - this.lastSpoke >= COOLDOWN_MS) {
      this.lastSpoke = now;
      this.push(msg);
    }
  }

  /** Choose the single most interesting line for this tick, or null. */
  private pickMessage(
    standings: Car[],
    order: Car[],
    battles: Battle[],
    now: number,
  ): string | null {
    if (!standings.length) return null;

    // 1. New leader at the top of the standings.
    const leader = standings[0];
    if (this.prevLeader && leader.symbol !== this.prevLeader) {
      return `🏁 ${symSpan(leader.symbol)} è la nuova vetta!`;
    }

    // 2. A fresh battle (not announced in the last 12s).
    for (const b of battles) {
      const last = this.seenBattles.get(b.id) ?? 0;
      this.seenBattles.set(b.id, now);
      if (now - last > 12000 && b.symbols.length >= 2) {
        return `⚔ Lotta in pista: ${b.symbols.map(symSpan).join(" vs ")}`;
      }
    }

    // 3. The biggest on-track position gain at the front (an overtake).
    let bestGain = 0;
    let mover: Car | null = null;
    let newRank = 0;
    order.forEach((car, i) => {
      if (i >= TOP_N) return;
      const prev = this.prevRank.get(car.symbol);
      if (prev !== undefined && prev - i > bestGain) {
        bestGain = prev - i;
        mover = car;
        newRank = i;
      }
    });
    if (mover && bestGain > 0) {
      const passed = order[newRank + 1];
      const who = passed ? ` su ${symSpan(passed.symbol)}` : "";
      return `🔻 ${symSpan((mover as Car).symbol)} sorpassa${who} per la P${newRank + 1}!`;
    }

    // 4. A sharp % move since the last sample.
    for (const car of standings) {
      const s = this.pctSample.get(car.symbol);
      if (!s) {
        this.pctSample.set(car.symbol, { pct: car.changePct, t: now });
        continue;
      }
      if (now - s.t < SAMPLE_AGE_MS) continue;
      const delta = car.changePct - s.pct;
      this.pctSample.set(car.symbol, { pct: car.changePct, t: now });
      if (Math.abs(delta) >= MOVE_THRESHOLD) {
        const sign = car.changePct >= 0 ? "+" : "";
        return delta > 0
          ? `📈 ${symSpan(car.symbol)} vola, ora ${sign}${car.changePct.toFixed(2)}%`
          : `📉 ${symSpan(car.symbol)} perde colpi, ora ${sign}${car.changePct.toFixed(2)}%`;
      }
    }

    return null;
  }

  private push(html: string): void {
    const line = document.createElement("div");
    line.className = "commentary-line";
    line.innerHTML = html;
    // New line enters from the top (fade-in), pushing the others down.
    this.el.prepend(line);
    // Anything beyond the last MAX_LINES (the oldest) fades out.
    const live = [...this.el.children].filter(
      (c) => !c.classList.contains("fading"),
    ) as HTMLElement[];
    for (let i = MAX_LINES; i < live.length; i++) this.expire(live[i]);
    // Each line also expires on its own after a while.
    setTimeout(() => this.expire(line), LINE_TTL_MS);
  }

  /** Fade a line out, then remove it (idempotent). */
  private expire(el: HTMLElement): void {
    if (el.classList.contains("fading")) return;
    el.classList.add("fading");
    setTimeout(() => el.remove(), 500);
  }
}
