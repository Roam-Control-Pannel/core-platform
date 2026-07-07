/**
 * Money display helpers. Prices live as integer PENCE everywhere (the API and DB never
 * hold a float near money); these are the ONLY place pence become a human string.
 */

const SYMBOLS: Record<string, string> = { gbp: "£", eur: "€", usd: "$" };

/** 1250 → "£12.50"; whole pounds drop the pennies (2500 → "£25"). */
export function formatPence(pence: number, currency = "gbp"): string {
  const symbol = SYMBOLS[currency.toLowerCase()] ?? `${currency.toUpperCase()} `;
  const pounds = pence / 100;
  const whole = pence % 100 === 0;
  return `${symbol}${pounds.toFixed(whole ? 0 : 2)}`;
}

/** Parse a shopkeeper-typed price ("12.50", "£12.50", "12") → integer pence, or null. */
export function parsePriceToPence(input: string): number | null {
  const cleaned = input.trim().replace(/^[£€$]/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [pounds, pennies = ""] = cleaned.split(".");
  return Number(pounds) * 100 + Number((pennies + "00").slice(0, 2));
}
