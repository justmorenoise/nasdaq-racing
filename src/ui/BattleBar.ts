import type { Battle } from "../sim/battles";

/**
 * Row of "Battle X vs Y" chips, one per active duel. Clicking a chip frames the
 * front car of that battle. Chips are reconciled by battle id so they persist
 * smoothly while a duel lasts and disappear when it breaks up.
 */
export class BattleBar {
  readonly el = document.createElement("div");
  private chips = new Map<string, HTMLButtonElement>();

  constructor(private onSelect: (symbol: string) => void) {
    this.el.className = "battle-bar";
  }

  update(battles: Battle[]): void {
    const present = new Set(battles.map((b) => b.id));
    for (const [id, chip] of this.chips) {
      if (!present.has(id)) {
        chip.remove();
        this.chips.delete(id);
      }
    }

    battles.forEach((battle, i) => {
      let chip = this.chips.get(battle.id);
      if (!chip) {
        chip = document.createElement("button");
        chip.className = "battle-chip";
        chip.textContent = `⚔ ${battle.symbols.join(" vs ")}`;
        this.chips.set(battle.id, chip);
      }
      // Lead can change within the same battle; rebind the handler each update.
      chip.onclick = () => this.onSelect(battle.lead);
      if (this.el.children[i] !== chip) this.el.appendChild(chip);
    });
  }
}
