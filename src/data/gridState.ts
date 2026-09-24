import { DEFAULT_SYMBOLS } from "./nasdaq100";

/**
 * Persistence for the user's chosen grid (which stocks race). Survives reloads
 * and is shareable: the selection lives both in `localStorage` and the `?symbols=`
 * URL param (comma-separated), so copying the address bar reproduces the setup.
 * The URL wins over localStorage when present (a shared link should show its grid).
 */
const STORAGE_KEY = "ngp.grid";
const KNOWN = new Set(DEFAULT_SYMBOLS);

/** Keep only known tickers, de-duplicated and in the canonical default order. */
function sanitize(symbols: string[]): string[] {
  const wanted = new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => KNOWN.has(s)));
  return DEFAULT_SYMBOLS.filter((s) => wanted.has(s));
}

/**
 * Resolve the starting grid: `?symbols=` first, then localStorage, then `null`
 * (meaning "use the default top 20"). Returns null rather than the default list
 * so the caller can tell "no saved grid" from "saved grid that equals default".
 */
export function loadGridSelection(params: URLSearchParams): string[] | null {
  const fromUrl = params.get("symbols");
  if (fromUrl) {
    const list = sanitize(fromUrl.split(","));
    if (list.length) return list;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const list = sanitize(JSON.parse(raw));
      if (list.length) return list;
    }
  } catch {
    /* private mode / corrupt value - fall through to default */
  }
  return null;
}

/**
 * Persist the grid to localStorage and reflect it in the URL without reloading
 * (history.replaceState keeps `?track=` etc. intact). A full grid (== default)
 * drops the param to keep the shared URL clean.
 */
export function saveGridSelection(symbols: string[]): void {
  const list = sanitize(symbols);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore storage failures (private mode) */
  }
  const url = new URL(location.href);
  if (list.length && list.length < DEFAULT_SYMBOLS.length) {
    url.searchParams.set("symbols", list.join(","));
  } else {
    url.searchParams.delete("symbols");
  }
  history.replaceState(null, "", url);
}
