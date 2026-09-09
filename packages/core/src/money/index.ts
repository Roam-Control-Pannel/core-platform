/**
 * Server-side money formatting. Prices are integer PENCE (minor units) everywhere; this is the
 * one place the api/jobs turn them into a human string (the web has its own locale-aware
 * lib/money.ts). Deterministic on purpose: the recipient's locale is unknown when a webhook or
 * cron job formats an order, and a notification only needs the correct SYMBOL + amount, so we
 * avoid Intl/locale variance and prefix a fixed symbol. Mirrors the symbol set the web falls
 * back to.
 */
const SYMBOLS: Record<string, string> = { gbp: "£", eur: "€", usd: "$" };

/**
 * Format integer pence in the order's currency: 1250,'gbp' → "£12.50"; whole units drop the
 * minor part (2500 → "£25"); 1200,'usd' → "$12". An unknown/empty code falls back to the
 * upper-cased code as a prefix ("CAD 12.00") so output is always truthful, never a wrong symbol.
 */
export function formatPence(pence: number, currency: string | null | undefined = "gbp"): string {
  const code = (currency || "gbp").toLowerCase();
  const digits = pence % 100 === 0 ? 0 : 2;
  const symbol = SYMBOLS[code] ?? `${code.toUpperCase()} `;
  return `${symbol}${(pence / 100).toFixed(digits)}`;
}
