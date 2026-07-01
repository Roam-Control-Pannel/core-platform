/**
 * offers core — the shared OFFER THEME taxonomy.
 *
 * An offer used to be just a free-text title + details. To measure "which kinds of deal drive
 * engagement" and to power suggestion templates, every offer now carries a `type` from this
 * canonical set. The set lives here (one source of truth) so the API validates against it and the
 * web mirrors it for its picker (the web can't import @roam/core, so it keeps a copy — same
 * discipline as transit/hours; a core test guards the shape).
 *
 * Deliberately a plain string list (not a Postgres enum) so the taxonomy can grow without a
 * migration; the DB stores the string verbatim and treats an unknown/absent value as "other".
 */

/** Canonical offer themes, ordered roughly most→least common for pickers. */
export const OFFER_TYPES = [
  "percent_off",
  "amount_off",
  "two_for_one",
  "bogof",
  "free_item",
  "bundle",
  "happy_hour",
  "loyalty",
  "first_time",
  "seasonal",
  "other",
] as const;

export type OfferType = (typeof OFFER_TYPES)[number];

/** Human labels for each theme (UI + analytics rows). */
export const OFFER_TYPE_LABELS: Record<OfferType, string> = {
  percent_off: "% off",
  amount_off: "Amount off",
  two_for_one: "2-for-1",
  bogof: "Buy one get one free",
  free_item: "Free item",
  bundle: "Bundle deal",
  happy_hour: "Happy hour",
  loyalty: "Loyalty reward",
  first_time: "First-timer offer",
  seasonal: "Seasonal / event",
  other: "Other",
};

const OFFER_TYPE_SET: ReadonlySet<string> = new Set(OFFER_TYPES);

/** Is a string one of the canonical themes? */
export function isOfferType(v: string | null | undefined): v is OfferType {
  return typeof v === "string" && OFFER_TYPE_SET.has(v);
}

/** Coerce any stored/legacy value to a canonical theme — unknown/absent → "other". */
export function normaliseOfferType(v: string | null | undefined): OfferType {
  return isOfferType(v) ? v : "other";
}

/** Label for a theme (coercing unknowns to "Other"). */
export function offerTypeLabel(v: string | null | undefined): string {
  return OFFER_TYPE_LABELS[normaliseOfferType(v)];
}

/** Does this theme carry a percentage discount (so a `discountPct` is meaningful)? */
export function offerTypeUsesPercent(v: string | null | undefined): boolean {
  return normaliseOfferType(v) === "percent_off";
}
