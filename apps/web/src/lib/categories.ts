/**
 * Browser-side canonical venue category groups — the nine top-level pills.
 *
 * This file deliberately does NOT import @roam/core: core can't be browser-bundled
 * under Turbopack (Node-ESM .js-suffix resolution breaks), which is why @roam/core is
 * not a dependency of @roam/web. The pill row needs the group NAMES before any fetch,
 * so they are mirrored here locally — the same lockstep-by-contract pattern as
 * venuePath in lib/routes.ts and urlBase64ToUint8Array in lib/push.ts.
 *
 * CANONICAL DEFINITION lives in packages/core/src/places/index.ts (CATEGORIES). The API
 * imports it from there and enforces it (places.ingestCategory's Zod enum), so this twin
 * is display-only: a tap sends the chosen name to /api/ingest, and the API is the single
 * source of truth that validates membership. This list MUST stay identical (names AND
 * order — order is the pill display order) to core's CATEGORIES. If you change the groups
 * in core, change them here too. Kept in lockstep by contract, not by a shared import.
 */

/** The nine canonical groups, in display order — a twin of core's CATEGORIES. */
export const CATEGORY_GROUPS = [
  "Food & Drink",
  "Shopping",
  "Entertainment & Recreation",
  "Automotive & Transport",
  "Finance & Business",
  "Health & Wellness",
  "Lodging",
  "Education & Government",
  "Places of Worship",
] as const;

export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

/**
 * Friendly DISPLAY labels for the pill row (from the Discovery design: "Eateries",
 * "Hotels", "Attractions"…). The canonical group name is still what's sent to the API —
 * this map only changes the text on the chip, so the long, database-flavoured taxonomy
 * ("Automotive & Transport", "Education & Government") reads like a place people browse,
 * not a schema. Keyed by the canonical value so the mapping can't drift from CATEGORY_GROUPS.
 */
export const CATEGORY_LABELS: Record<CategoryGroup, string> = {
  "Food & Drink": "Eateries",
  Shopping: "Shopping",
  "Entertainment & Recreation": "Attractions",
  "Automotive & Transport": "Transport",
  "Finance & Business": "Business",
  "Health & Wellness": "Health & Beauty",
  Lodging: "Hotels",
  "Education & Government": "Civic",
  "Places of Worship": "Worship",
};

/** The friendly pill label for a canonical group (falls back to the canonical name). */
export function categoryLabel(group: string): string {
  return (CATEGORY_LABELS as Record<string, string>)[group] ?? group;
}
