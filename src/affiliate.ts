/**
 * Broker affiliate deep-links. The only place that knows where the "Invest"
 * CTAs point - so the program/URL can change via env without touching the UI.
 *
 * Defaults to eToro (the planned Phase-2 data provider). With a real affiliate
 * program, set `VITE_AFFILIATE_TEMPLATE` to the tracked deep-link (keeping the
 * `{symbol}` placeholder) and `VITE_AFFILIATE_SUBID` to your partner/sub id;
 * the sub id is appended for attribution. Without any env the CTAs still work,
 * pointing at the public eToro pages (untracked).
 */
import { CONFIG } from "./config";

/** Whether the broker affiliate CTAs / eToro references are shown at all. */
export const affiliateEnabled = CONFIG.affiliateEnabled;

const TEMPLATE =
  import.meta.env.VITE_AFFILIATE_TEMPLATE ?? "https://www.etoro.com/markets/{symbol}";
const SIGNUP = import.meta.env.VITE_AFFILIATE_SIGNUP ?? "https://www.etoro.com/";
const SUBID = import.meta.env.VITE_AFFILIATE_SUBID ?? "";

/**
 * Per-symbol broker slug overrides, for the rare cases where the broker's URL
 * slug differs from our ticker. Empty for now (e.g. add GOOG/GOOGL here if a
 * broker maps them differently).
 */
const SYMBOL_OVERRIDES: Record<string, string> = {};

function withSubId(url: string, symbol: string): string {
  const sep = url.includes("?") ? "&" : "?";
  const parts: string[] = [`utm_content=${encodeURIComponent(symbol)}`];
  if (SUBID) parts.push(`subid=${encodeURIComponent(SUBID)}`);
  return url + sep + parts.join("&");
}

/** Affiliate deep-link for a single stock's CTA. */
export function affiliateUrl(symbol: string): string {
  const slug = SYMBOL_OVERRIDES[symbol] ?? symbol;
  const filled = TEMPLATE.replaceAll("{symbol}", slug).replaceAll(
    "{symbol_lower}",
    slug.toLowerCase(),
  );
  return withSubId(filled, symbol);
}

/** Affiliate link for the global "open an account" CTA (no specific stock). */
export function signupUrl(): string {
  if (!SUBID) return SIGNUP;
  const sep = SIGNUP.includes("?") ? "&" : "?";
  return `${SIGNUP}${sep}subid=${encodeURIComponent(SUBID)}`;
}

/** rel value for all sponsored affiliate anchors (SEO-correct + safe). */
export const AFFILIATE_REL = "sponsored noopener noreferrer";
