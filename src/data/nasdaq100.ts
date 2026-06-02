export interface StockDef {
  symbol: string;
  name: string;
  /** Approximate reference price, used as the simulated session-open baseline. */
  basePrice: number;
  /** Livery / brand color (hex) — the car body. */
  color: number;
  /** Optional secondary color (hex) for the helmet; random if omitted. */
  color2?: number;
}

/**
 * Top ~20 Nasdaq 100 names (by weight) with brand-ish livery colors.
 * `basePrice` is the simulated-mode session baseline; aligned to recent real
 * reference prices (Finnhub previous close) so the demo starts realistically.
 * With the real feed (`feed=supabase`) these are unused — live prices win.
 */
export const NASDAQ_TOP: StockDef[] = [
  { symbol: "NVDA", name: "NVIDIA", basePrice: 224, color: 0x76b900 },
  { symbol: "AAPL", name: "Apple", basePrice: 306, color: 0xa3aaae },
  { symbol: "MSFT", name: "Microsoft", basePrice: 461, color: 0x00a4ef },
  { symbol: "AMZN", name: "Amazon", basePrice: 261, color: 0xff9900 },
  { symbol: "AVGO", name: "Broadcom", basePrice: 460, color: 0xcc092f },
  { symbol: "META", name: "Meta", basePrice: 600, color: 0x0866ff },
  { symbol: "TSLA", name: "Tesla", basePrice: 416, color: 0xe82127 },
  { symbol: "GOOGL", name: "Alphabet A", basePrice: 376, color: 0x4285f4 },
  { symbol: "GOOG", name: "Alphabet C", basePrice: 373, color: 0x34a853 },
  { symbol: "COST", name: "Costco", basePrice: 946, color: 0xe31837 },
  { symbol: "NFLX", name: "Netflix", basePrice: 86, color: 0xe50914 },
  { symbol: "TMUS", name: "T-Mobile", basePrice: 187, color: 0xe20074 },
  { symbol: "PLTR", name: "Palantir", basePrice: 161, color: 0x101113 },
  { symbol: "CSCO", name: "Cisco", basePrice: 121, color: 0x1ba0d7 },
  { symbol: "AMD", name: "AMD", basePrice: 510, color: 0xed1c24 },
  { symbol: "PEP", name: "PepsiCo", basePrice: 142, color: 0x004b93 },
  { symbol: "INTU", name: "Intuit", basePrice: 354, color: 0x365ebf },
  { symbol: "TXN", name: "Texas Instr.", basePrice: 293, color: 0xcc0000 },
  { symbol: "QCOM", name: "Qualcomm", basePrice: 229, color: 0x3253dc },
  { symbol: "AMGN", name: "Amgen", basePrice: 329, color: 0x0063c3 },
];

export const DEFAULT_SYMBOLS = NASDAQ_TOP.map((s) => s.symbol);

export function getStockDef(symbol: string): StockDef | undefined {
  return NASDAQ_TOP.find((s) => s.symbol === symbol);
}
