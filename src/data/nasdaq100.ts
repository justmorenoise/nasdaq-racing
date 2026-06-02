export interface StockDef {
  symbol: string;
  name: string;
  /** Approximate reference price, used as the simulated session-open baseline. */
  basePrice: number;
  /** Livery / brand color (hex). */
  color: number;
}

/**
 * Top ~20 Nasdaq 100 names (by weight) with brand-ish livery colors.
 * Prices are approximate reference values only — the prototype uses simulated
 * data, so exact figures don't matter. In phase 2 these come from eToro.
 */
export const NASDAQ_TOP: StockDef[] = [
  { symbol: "NVDA", name: "NVIDIA", basePrice: 135, color: 0x76b900 },
  { symbol: "AAPL", name: "Apple", basePrice: 230, color: 0xa3aaae },
  { symbol: "MSFT", name: "Microsoft", basePrice: 430, color: 0x00a4ef },
  { symbol: "AMZN", name: "Amazon", basePrice: 205, color: 0xff9900 },
  { symbol: "AVGO", name: "Broadcom", basePrice: 235, color: 0xcc092f },
  { symbol: "META", name: "Meta", basePrice: 600, color: 0x0866ff },
  { symbol: "TSLA", name: "Tesla", basePrice: 345, color: 0xe82127 },
  { symbol: "GOOGL", name: "Alphabet A", basePrice: 190, color: 0x4285f4 },
  { symbol: "GOOG", name: "Alphabet C", basePrice: 192, color: 0x34a853 },
  { symbol: "COST", name: "Costco", basePrice: 960, color: 0xe31837 },
  { symbol: "NFLX", name: "Netflix", basePrice: 900, color: 0xe50914 },
  { symbol: "TMUS", name: "T-Mobile", basePrice: 235, color: 0xe20074 },
  { symbol: "PLTR", name: "Palantir", basePrice: 75, color: 0x101113 },
  { symbol: "CSCO", name: "Cisco", basePrice: 60, color: 0x1ba0d7 },
  { symbol: "AMD", name: "AMD", basePrice: 140, color: 0xed1c24 },
  { symbol: "PEP", name: "PepsiCo", basePrice: 155, color: 0x004b93 },
  { symbol: "INTU", name: "Intuit", basePrice: 650, color: 0x365ebf },
  { symbol: "TXN", name: "Texas Instr.", basePrice: 195, color: 0xcc0000 },
  { symbol: "QCOM", name: "Qualcomm", basePrice: 165, color: 0x3253dc },
  { symbol: "AMGN", name: "Amgen", basePrice: 280, color: 0x0063c3 },
];

export const DEFAULT_SYMBOLS = NASDAQ_TOP.map((s) => s.symbol);

export function getStockDef(symbol: string): StockDef | undefined {
  return NASDAQ_TOP.find((s) => s.symbol === symbol);
}
