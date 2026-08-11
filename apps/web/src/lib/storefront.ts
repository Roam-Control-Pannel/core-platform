/**
 * Storefront co-brand tokens + helpers for the NI Food to Go Association surface.
 *
 * The storefront wears the Association's identity (navy + yellow, their logo) with "Powered by
 * Roam" underneath. These are the Association's fixed brand values — used directly by the
 * storefront components so the look is deterministic regardless of the channel theme row (which
 * still carries the same values for the CSS-var layer / any leaked Roam chrome).
 */

export const STOREFRONT = {
  /** Deep navy — headers, hero, card category tags. */
  navy: "#17233C",
  navyDeep: "#101A2E",
  navyLine: "rgba(255,255,255,.14)",
  /** Association yellow — the ready pill, primary CTAs, accents. */
  yellow: "#F3D24B",
  yellowInk: "#2f2707",
  /** On-navy text. */
  onNavy: "#ffffff",
  onNavyMuted: "rgba(255,255,255,.72)",
} as const;

/** The Association logo, served from apps/web/public. */
export const F2G_LOGO_SRC = "/f2g-logo.avif";

/** Metres → miles, NI-style ("0.3 mi" / "4 mi"). Null when distance is unknown. */
export function milesFromMetres(m?: number | null): string | null {
  if (m == null) return null;
  const mi = m / 1609.344;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

/** Storefront category chips (display order). "all" is the default, no filter. */
export const STOREFRONT_CATEGORIES = [
  "all",
  "coffee",
  "bakery",
  "hot_food",
  "breakfast",
  "forecourt",
] as const;
export type StorefrontCategory = (typeof STOREFRONT_CATEGORIES)[number];

/** How results are ordered on the storefront. */
export const STOREFRONT_SORTS = ["fastest", "nearest", "top_rated"] as const;
export type StorefrontSort = (typeof STOREFRONT_SORTS)[number];
