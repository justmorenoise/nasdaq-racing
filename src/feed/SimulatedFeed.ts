import type { PriceFeed, PriceListener, PriceUpdate } from "./PriceFeed";
import { getStockDef } from "../data/nasdaq100";

interface SimState {
  basePrice: number;
  changePct: number;
  /** Slowly drifting mean the change reverts toward (the day's "trend"). */
  bias: number;
  sigma: number; // volatility
  theta: number; // mean-reversion strength
}

/** Box-Muller standard normal. */
function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Mean-reverting random walk on each stock's daily % change. Each symbol gets
 * its own volatility and a slowly drifting bias so the field spreads out over a
 * session and positions trade hands — producing overtakes and battles.
 */
export class SimulatedFeed implements PriceFeed {
  private states = new Map<string, SimState>();
  private listeners = new Set<PriceListener>();
  private timer: number | null = null;
  private readonly tickMs = 1000;

  start(symbols: string[]): void {
    const wanted = new Set(symbols);
    // Drop states no longer requested; keep existing ones running.
    for (const sym of [...this.states.keys()]) {
      if (!wanted.has(sym)) this.states.delete(sym);
    }
    for (const symbol of symbols) {
      if (this.states.has(symbol)) continue;
      const def = getStockDef(symbol);
      const bias = gaussian() * 1.6; // the day's trend (spreads the field)
      this.states.set(symbol, {
        basePrice: def?.basePrice ?? 100,
        changePct: bias + gaussian() * 0.4,
        bias,
        // Gentle volatility so the standings evolve gradually (like intraday data),
        // letting the on-track positions track the leaderboard smoothly.
        sigma: 0.05 + Math.random() * 0.06,
        theta: 0.02 + Math.random() * 0.03,
      });
    }
    if (this.timer === null) {
      this.timer = window.setInterval(() => this.tick(), this.tickMs);
    }
    // Emit an initial snapshot so consumers have starting values immediately.
    this.emit(this.buildUpdates());
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  onUpdate(listener: PriceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): Map<string, PriceUpdate> {
    const map = new Map<string, PriceUpdate>();
    for (const u of this.buildUpdates()) map.set(u.symbol, u);
    return map;
  }

  private tick(): void {
    const dt = this.tickMs / 1000;
    for (const st of this.states.values()) {
      // Drift the bias on a slow random walk (the evolving daily trend).
      st.bias += gaussian() * 0.02 * Math.sqrt(dt);
      st.bias = Math.max(-6, Math.min(6, st.bias));
      // Ornstein-Uhlenbeck step on the change percent.
      st.changePct +=
        st.theta * (st.bias - st.changePct) * dt +
        st.sigma * Math.sqrt(dt) * gaussian();
    }
    this.emit(this.buildUpdates());
  }

  private buildUpdates(): PriceUpdate[] {
    const ts = Date.now();
    const out: PriceUpdate[] = [];
    for (const [symbol, st] of this.states) {
      out.push({
        symbol,
        changePct: st.changePct,
        price: st.basePrice * (1 + st.changePct / 100),
        ts,
      });
    }
    return out;
  }

  private emit(updates: PriceUpdate[]): void {
    for (const l of this.listeners) l(updates);
  }
}
