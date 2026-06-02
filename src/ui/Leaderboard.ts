import type { Car } from "../sim/Car";

interface Row {
  el: HTMLElement;
  posEl: HTMLElement;
  priceEl: HTMLElement;
  deltaEl: HTMLElement;
}

function fmtSigned(n: number, digits = 2): string {
  return (n >= 0 ? "+" : "") + n.toFixed(digits);
}

/**
 * Live standings panel: one row per followed stock with price, numeric delta and
 * percent delta, re-sorted by percent change (best on top). Clicking a row asks
 * the camera to chase that car.
 */
export class Leaderboard {
  readonly el = document.createElement("div");
  private list = document.createElement("div");
  private rows = new Map<string, Row>();

  constructor(private onSelect: (symbol: string) => void) {
    this.el.className = "panel leaderboard";
    const title = document.createElement("div");
    title.className = "panel-title";
    title.textContent = "CLASSIFICA";
    this.el.append(title, this.list);
  }

  private ensureRow(car: Car): Row {
    let row = this.rows.get(car.symbol);
    if (row) return row;

    const el = document.createElement("button");
    el.className = "lb-row";
    el.style.setProperty("--team", `#${car.color.toString(16).padStart(6, "0")}`);
    el.addEventListener("click", () => this.onSelect(car.symbol));

    const posEl = document.createElement("span");
    posEl.className = "lb-pos";
    const chip = document.createElement("span");
    chip.className = "lb-chip";

    const main = document.createElement("span");
    main.className = "lb-main";
    const sym = document.createElement("span");
    sym.className = "lb-sym";
    sym.textContent = car.symbol;
    const priceEl = document.createElement("span");
    priceEl.className = "lb-price";
    main.append(sym, priceEl);

    const deltaEl = document.createElement("span");
    deltaEl.className = "lb-delta";

    el.append(posEl, chip, main, deltaEl);
    row = { el, posEl, priceEl, deltaEl };
    this.rows.set(car.symbol, row);
    return row;
  }

  /** @param order cars sorted by percent change (best first). */
  update(order: Car[], followed: string | null): void {
    const present = new Set(order.map((c) => c.symbol));
    for (const [sym, row] of this.rows) {
      if (!present.has(sym)) {
        row.el.remove();
        this.rows.delete(sym);
      }
    }

    order.forEach((car, i) => {
      const row = this.ensureRow(car);
      // Place each row at index i. Rows 0..i-1 are already correct, so insert
      // before the node currently at i (append when none).
      const current = this.list.children[i];
      if (current !== row.el) this.list.insertBefore(row.el, current ?? null);

      row.posEl.textContent = String(i + 1);
      const delta = car.price - car.basePrice;
      row.priceEl.textContent = `${car.price.toFixed(2)}  ${fmtSigned(delta)}`;
      row.deltaEl.textContent = `${fmtSigned(car.changePct)}%`;
      const cls = car.changePct >= 0 ? "up" : "down";
      row.deltaEl.className = `lb-delta ${cls}`;
      row.el.classList.toggle("followed", car.symbol === followed);
    });
  }
}
