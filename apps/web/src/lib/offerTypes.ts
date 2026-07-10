/**
 * offerTypes — a LOCAL mirror of @roam/core/offers' theme taxonomy (the web can't import
 * @roam/core, same discipline as lib/transitRegion). Keep this in lockstep with core: same ids,
 * same labels. Powers the offer composer's theme picker and the insights panel's row labels.
 */

import { useTranslations } from "next-intl";

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

const SET: ReadonlySet<string> = new Set(OFFER_TYPES);

/** Coerce any stored value to a canonical theme — unknown/absent → "other". */
export function normaliseOfferType(v: string | null | undefined): OfferType {
  return typeof v === "string" && SET.has(v) ? (v as OfferType) : "other";
}

/** Label for a theme (coercing unknowns). */
export function offerTypeLabel(v: string | null | undefined): string {
  return OFFER_TYPE_LABELS[normaliseOfferType(v)];
}

/**
 * Hook: localized label for a theme (coercing unknowns). The theme IDS are wire-contract
 * values (never translated); OFFER_TYPE_LABELS above stays as the English source the en.json
 * catalogue mirrors, and call sites migrate here cluster by cluster.
 */
export function useOfferTypeLabel(): (v: string | null | undefined) => string {
  const t = useTranslations("offerTypes");
  return (v) => t(normaliseOfferType(v));
}

/** Only percent_off carries a % discount value. */
export function offerTypeUsesPercent(v: string | null | undefined): boolean {
  return normaliseOfferType(v) === "percent_off";
}
