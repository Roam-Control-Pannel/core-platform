/**
 * Money display helpers. Prices live as integer PENCE everywhere (the API and DB never
 * hold a float near money); these are the ONLY place pence become a human string.
 *
 * Formatting goes through Intl.NumberFormat with the active locale (lib/i18n/runtime), so a
 * user reading Roam in another language sees their separators and symbol placement ("12,50 £")
 * while the currency itself stays whatever the listing says (GBP today). English output is
 * unchanged: "£12.50", whole pounds "£25".
 */
import { getFormatLocale } from "./i18n/runtime";

const SYMBOLS: Record<string, string> = { gbp: "£", eur: "€", usd: "$" };

/** 1250 → "£12.50"; whole pounds drop the pennies (2500 → "£25"). */
export function formatPence(pence: number, currency = "gbp"): string {
  const digits = pence % 100 === 0 ? 0 : 2;
  try {
    return new Intl.NumberFormat(getFormatLocale(), {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(pence / 100);
  } catch {
    // Unknown/invalid currency code — fall back to the plain symbol-prefix rendering.
    const symbol = SYMBOLS[currency.toLowerCase()] ?? `${currency.toUpperCase()} `;
    return `${symbol}${(pence / 100).toFixed(digits)}`;
  }
}

/** Parse a shopkeeper-typed price ("12.50", "£12.50", "12") → integer pence, or null. */
export function parsePriceToPence(input: string): number | null {
  const cleaned = input.trim().replace(/^[£€$]/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [pounds, pennies = ""] = cleaned.split(".");
  return Number(pounds) * 100 + Number((pennies + "00").slice(0, 2));
}
