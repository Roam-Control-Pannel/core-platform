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

/**
 * Parse a shopkeeper-typed price → integer pence, or null.
 *
 * Accepts BOTH decimal conventions, because the app now DISPLAYS prices in the user's locale
 * ("12,50 £" for de/fr/es/it/pl/ro) and people type prices the way their language writes them:
 *   "12.50" / "£12.50" / "12,50" → 1250;  "12" → 1200;  "1,250" / "1.250" → 125000 (thousands).
 * Rule: with both separators present, the LAST one is the decimal point ("1.250,50" = "1,250.50").
 * With one separator, 1–2 trailing digits once means a decimal ("12,5" / "12.50"); a group of
 * three (or repeated separators) means thousands ("1,250" / "1.250.000"). Without this, a German
 * user typing "12,50" published a £1,250 listing — a silent 100× money bug.
 */
export function parsePriceToPence(input: string): number | null {
  const s = input.trim().replace(/^[£€$]/, "").replace(/\s/g, "");
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimalSep = "";
  if (lastDot !== -1 && lastComma !== -1) {
    decimalSep = lastDot > lastComma ? "." : ",";
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? "." : ",";
    const digitsAfter = s.length - s.lastIndexOf(sep) - 1;
    const appearsOnce = s.indexOf(sep) === s.lastIndexOf(sep);
    if (appearsOnce && digitsAfter >= 1 && digitsAfter <= 2) decimalSep = sep;
  }

  const normalised = decimalSep
    ? s.replace(decimalSep === "." ? /,/g : /\./g, "").replace(decimalSep, ".")
    : s.replace(/[.,]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;
  const [pounds, pennies = ""] = normalised.split(".");
  return Number(pounds) * 100 + Number((pennies + "00").slice(0, 2));
}
