import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from "@supabase/supabase-js";
import type { PriceFeed, PriceListener, PriceUpdate } from "./PriceFeed";

interface PriceRow {
  symbol: string;
  price: number;
  change_pct: number;
  ts: string | null;
}

/**
 * Real-data feed backed by Supabase. A scheduled Edge Function writes prices to
 * the `prices` table (one shared Finnhub key server-side); this feed reads the
 * initial snapshot and then receives live updates via Realtime — same
 * `PriceFeed` interface as the simulated feed, so nothing else changes.
 */
export class SupabaseFeed implements PriceFeed {
  private client: SupabaseClient;
  private listeners = new Set<PriceListener>();
  private latest = new Map<string, PriceUpdate>();
  private channel: RealtimeChannel | null = null;
  private symbols = new Set<string>();
  private stopped = false;
  private reconnectTimer: number | null = null;

  constructor(url: string, anonKey: string) {
    this.client = createClient(url, anonKey, {
      auth: { persistSession: false },
    });
  }

  start(symbols: string[]): void {
    this.symbols = new Set(symbols);
    this.stopped = false;
    void this.connect();
  }

  private async connect(): Promise<void> {
    await this.loadSnapshot();
    if (this.stopped) return;

    this.channel = this.client
      .channel("prices-feed")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "prices" },
        (payload) => {
          const row = payload.new as PriceRow;
          if (!row?.symbol || !this.symbols.has(row.symbol)) return;
          const u = this.toUpdate(row);
          this.latest.set(u.symbol, u);
          this.emit([u]);
        },
      )
      .subscribe((status) => {
        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          this.scheduleReconnect();
        }
      });
  }

  /** Fetch the current snapshot, retrying with backoff on failure. */
  private async loadSnapshot(attempt = 0): Promise<void> {
    if (this.stopped) return;
    const { data, error } = await this.client
      .from("prices")
      .select("symbol, price, change_pct, ts");
    if (error || !data) {
      if (attempt < 5) {
        window.setTimeout(
          () => void this.loadSnapshot(attempt + 1),
          1000 * (attempt + 1),
        );
      }
      return;
    }
    const batch: PriceUpdate[] = [];
    for (const row of data as PriceRow[]) {
      if (!this.symbols.has(row.symbol)) continue;
      const u = this.toUpdate(row);
      this.latest.set(u.symbol, u);
      batch.push(u);
    }
    if (batch.length) this.emit(batch);
  }

  /** Tear down and re-establish the channel after a transient failure. */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      if (this.channel) {
        void this.client.removeChannel(this.channel);
        this.channel = null;
      }
      void this.connect();
    }, 2000);
  }

  private toUpdate(row: PriceRow): PriceUpdate {
    return {
      symbol: row.symbol,
      price: Number(row.price),
      changePct: Number(row.change_pct),
      ts: row.ts ? Date.parse(row.ts) : Date.now(),
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.channel) {
      void this.client.removeChannel(this.channel);
      this.channel = null;
    }
  }

  onUpdate(listener: PriceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): Map<string, PriceUpdate> {
    return new Map(this.latest);
  }

  private emit(updates: PriceUpdate[]): void {
    for (const l of this.listeners) l(updates);
  }
}
