import type { Car } from "../sim/Car";
import type { ClockSample } from "../sim/RaceClock";
import { affiliateUrl, affiliateEnabled, AFFILIATE_REL } from "../affiliate";

function hms(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/**
 * Bottom status line (race state + session clock) plus the end-of-session podium
 * overlay (winner = most distance covered).
 */
export class RaceHud {
  readonly status = document.createElement("div");
  readonly podium = document.createElement("div");
  readonly chaseInfo = document.createElement("div");
  private trackLength: number;

  constructor(trackLength: number, private onSelect: (symbol: string) => void) {
    this.trackLength = trackLength;
    this.status.className = "race-status";
    this.podium.className = "podium hidden";
    this.chaseInfo.className = "chase-info hidden";
  }

  /** Broadcast-style gap readout while chasing; pass null to hide. */
  setChaseInfo(html: string | null): void {
    if (html == null) {
      this.chaseInfo.classList.add("hidden");
    } else {
      this.chaseInfo.innerHTML = html;
      this.chaseInfo.classList.remove("hidden");
    }
  }

  setStatus(s: ClockSample): void {
    if (s.state === "pre") {
      this.status.innerHTML = `<span class="dot pre"></span> PRE-GARA · apertura mercati`;
    } else if (s.state === "running") {
      this.status.innerHTML = `<span class="dot live"></span> LIVE · ${hms(
        s.elapsed,
      )} / ${hms(s.total)}`;
    } else {
      this.status.innerHTML = `<span class="dot done"></span> TRAGUARDO · gara conclusa`;
    }
  }

  showPodium(order: Car[], dotd?: Car | null): void {
    if (!this.podium.classList.contains("hidden")) return;
    // The day's result is the final standings: rank by daily % change (best
    // first), not by the on-track running order.
    const top = [...order].sort((a, b) => b.changePct - a.changePct).slice(0, 3);
    const medals = ["🥇", "🥈", "🥉"];
    const rows = top
      .map((car, i) => {
        const laps = Math.max(0, car.distance / this.trackLength).toFixed(1);
        const sign = car.changePct >= 0 ? "+" : "";
        const cls = car.changePct >= 0 ? "up" : "down";
        const color = `#${car.color.toString(16).padStart(6, "0")}`;
        return `<div class="podium-row" data-sym="${car.symbol}">
          <span class="podium-medal">${medals[i]}</span>
          <span class="podium-chip" style="background:${color}"></span>
          <span class="podium-sym">${car.symbol}</span>
          <span class="podium-laps">${laps} giri</span>
          <span class="podium-pct ${cls}">${sign}${car.changePct.toFixed(2)}%</span>
          ${
            affiliateEnabled
              ? `<a class="podium-invest" href="${affiliateUrl(car.symbol)}" target="_blank" rel="${AFFILIATE_REL}">Investi su ${car.symbol} ↗</a>`
              : ""
          }
        </div>`;
      })
      .join("");
    const disclaimer = affiliateEnabled
      ? `<div class="podium-disclaimer">Link sponsorizzati. Le azioni/CFD comportano rischi. Non è consulenza finanziaria.</div>`
      : "";
    // Driver of the Day: the most aggressive climber (most overtakes).
    const dotdRow = dotd
      ? `<div class="podium-dotd" data-sym="${dotd.symbol}">
          🟣 <b>Driver of the Day</b> · ${dotd.symbol}
          <span class="podium-dotd-meta">${dotd.overtakes} sorpassi</span>
        </div>`
      : "";
    this.podium.innerHTML = `
      <div class="podium-card">
        <div class="podium-title">🏁 RISULTATO DI GIORNATA</div>
        ${rows}
        ${dotdRow}
        ${disclaimer}
      </div>`;
    this.podium
      .querySelectorAll<HTMLElement>(".podium-row, .podium-dotd")
      .forEach((b) =>
        b.addEventListener("click", () => this.onSelect(b.dataset.sym!)),
      );
    // The affiliate link opens the broker; don't let it trigger the row's chase.
    this.podium.querySelectorAll<HTMLElement>(".podium-invest").forEach((a) =>
      a.addEventListener("click", (e) => e.stopPropagation()),
    );
    this.podium.classList.remove("hidden");
  }

  hidePodium(): void {
    this.podium.classList.add("hidden");
  }
}
