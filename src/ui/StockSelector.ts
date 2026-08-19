import { NASDAQ_TOP } from "../data/nasdaq100";
import { t } from "../i18n";

/**
 * Toggle panel for choosing which stocks race. Defaults to all (top 20).
 * Emits the selected symbol list on every change.
 */
export class StockSelector {
  readonly el = document.createElement("div");
  private selected: Set<string>;

  constructor(
    initial: string[],
    private onChange: (symbols: string[]) => void,
  ) {
    this.selected = new Set(initial);
    this.el.className = "panel selector hidden";

    const title = document.createElement("div");
    title.className = "panel-title";
    title.textContent = t("selector.title");
    this.el.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "selector-grid";
    for (const stock of NASDAQ_TOP) {
      const item = document.createElement("label");
      item.className = "selector-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = this.selected.has(stock.symbol);
      cb.addEventListener("change", () => {
        if (cb.checked) this.selected.add(stock.symbol);
        else this.selected.delete(stock.symbol);
        this.onChange(this.orderedSelection());
      });
      const dot = document.createElement("span");
      dot.className = "selector-dot";
      dot.style.background = `#${stock.color.toString(16).padStart(6, "0")}`;
      const label = document.createElement("span");
      label.textContent = stock.symbol;
      item.append(cb, dot, label);
      grid.appendChild(item);
    }
    this.el.appendChild(grid);
  }

  private orderedSelection(): string[] {
    return NASDAQ_TOP.map((s) => s.symbol).filter((s) => this.selected.has(s));
  }

  toggle(): void {
    this.el.classList.toggle("hidden");
  }
}
