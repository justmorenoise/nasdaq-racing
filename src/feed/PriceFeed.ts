/** A single price tick for one symbol. */
export interface PriceUpdate {
  symbol: string;
  /** Latest price. */
  price: number;
  /** Daily change vs the session-open/previous-close baseline, in percent. */
  changePct: number;
  /** Timestamp (ms epoch). */
  ts: number;
}

export type PriceListener = (updates: PriceUpdate[]) => void;

/**
 * Abstraction boundary between the data source and the rest of the app.
 * v1 ships `SimulatedFeed`; phase 2 adds `EtoroFeed` (server-fanned WebSocket)
 * behind this same interface - nothing else in the app should change.
 */
export interface PriceFeed {
  /** Begin emitting updates for the given symbols. */
  start(symbols: string[]): void;
  stop(): void;
  /** Subscribe to batched updates. Returns an unsubscribe function. */
  onUpdate(listener: PriceListener): () => void;
  /** Latest known value per symbol. */
  snapshot(): Map<string, PriceUpdate>;
}
