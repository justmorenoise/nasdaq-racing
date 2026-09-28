import { createClient } from "jsr:@supabase/supabase-js@2";

// Nasdaq-100 top ~20 (mirror of the frontend list).
const SYMBOLS = [
  "NVDA", "AAPL", "MSFT", "AMZN", "AVGO", "META", "TSLA", "GOOGL", "GOOG",
  "COST", "NFLX", "TMUS", "PLTR", "CSCO", "AMD", "PEP", "INTU", "TXN",
  "QCOM", "AMGN",
];

interface Row {
  symbol: string;
  price: number;
  change_pct: number;
  ts: string;
}

function hash(s: string): number {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Smooth pseudo-random daily % per symbol (used when no Finnhub key is set). */
function simulated(now: string): Row[] {
  const t = Date.now() / 1000;
  return SYMBOLS.map((symbol) => {
    const h = hash(symbol);
    const phase = ((h % 1000) / 1000) * Math.PI * 2;
    const freq = 0.015 + (h % 7) * 0.004;
    const changePct =
      Math.sin(t * freq + phase) * 3 + Math.sin(t * freq * 0.37 + phase) * 1.1;
    const base = 50 + (h % 900);
    return {
      symbol,
      price: base * (1 + changePct / 100),
      change_pct: changePct,
      ts: now,
    };
  });
}

/**
 * Quotes from Finnhub. A symbol whose quote is missing or invalid (rate limit,
 * outage: Finnhub answers with an error object, not a price) is left out, so
 * its last good row stays in the table instead of being zeroed.
 */
async function fromFinnhub(key: string, now: string): Promise<Row[]> {
  const rows = await Promise.all(
    SYMBOLS.map(async (symbol): Promise<Row | null> => {
      try {
        const r = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`,
        );
        if (!r.ok) return null;
        const q = await r.json();
        if (typeof q.c !== "number" || !(q.c > 0)) return null;
        const changePct =
          typeof q.dp === "number"
            ? q.dp
            : typeof q.pc === "number" && q.pc > 0
              ? ((q.c - q.pc) / q.pc) * 100
              : null;
        if (changePct === null || !Number.isFinite(changePct)) return null;
        return { symbol, price: q.c, change_pct: changePct, ts: now };
      } catch (_e) {
        return null;
      }
    }),
  );
  return rows.filter((r): r is Row => r !== null);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const finnhubKey = Deno.env.get("FINNHUB_API_KEY");
  const supabase = createClient(url, serviceKey);

  // Only the scheduler may trigger a refresh: the anon key that passes the JWT
  // check is public, so the job also sends a secret kept in the Vault.
  const candidate = req.headers.get("x-cron-secret") ?? "";
  const { data: allowed, error: authError } = candidate
    ? await supabase.rpc("check_cron_secret", { candidate })
    : { data: false, error: null };
  if (authError) return json({ ok: false, error: "auth check failed" }, 500);
  if (!allowed) return json({ ok: false, error: "unauthorized" }, 401);

  const now = new Date().toISOString();
  const rows = finnhubKey
    ? await fromFinnhub(finnhubKey, now)
    : simulated(now);

  const { error } = rows.length
    ? await supabase.from("prices").upsert(rows)
    : { error: null };
  return json({
    ok: !error,
    count: rows.length,
    skipped: SYMBOLS.length - rows.length,
    mode: finnhubKey ? "finnhub" : "sim",
    error: error?.message ?? null,
  });
});
