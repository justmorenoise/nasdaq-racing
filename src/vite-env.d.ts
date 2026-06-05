/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Affiliate deep-link template with a `{symbol}` (or `{symbol_lower}`) placeholder. */
  readonly VITE_AFFILIATE_TEMPLATE?: string;
  /** Affiliate "open an account" landing URL (no specific stock). */
  readonly VITE_AFFILIATE_SIGNUP?: string;
  /** Affiliate partner/sub id appended to links for attribution. */
  readonly VITE_AFFILIATE_SUBID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
