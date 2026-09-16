/**
 * Native venue category groups — the ten top-level pills, plus their display labels
 * and glyphs.
 *
 * CANONICAL DEFINITION lives in packages/core/src/places/index.ts (CATEGORIES), and the
 * API enforces it (venues.inCategoryNear's Zod enum). This is a display-only twin, kept in
 * lockstep BY CONTRACT rather than by a shared import — exactly like apps/web's
 * lib/categories.ts, and for a related reason: @roam/core has no `./places` export, so
 * there is nothing to import even though Metro could bundle it. The pill row also needs
 * these names before any fetch.
 *
 * This list MUST stay identical to core's CATEGORIES in names AND order (order is the pill
 * display order). If you change the groups in core, change them here and in apps/web.
 *
 * i18n: the canonical group VALUES are wire-contract identifiers and are never translated;
 * only the labels below are display text.
 */
import type { IconName } from "../design";

/** The ten canonical groups, in display order — a twin of core's CATEGORIES. */
export const CATEGORY_GROUPS = [
  "Food & Drink",
  "Shopping",
  "Entertainment & Recreation",
  "Stadiums",
  "Automotive & Transport",
  "Finance & Business",
  "Health & Wellness",
  "Lodging",
  "Education & Government",
  "Places of Worship",
] as const;

export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

/**
 * Friendly DISPLAY labels for the pill row. The canonical group name is still what's sent
 * to the API — this map only changes the chip text, so the database-flavoured taxonomy
 * ("Automotive & Transport", "Education & Government") reads like a place people browse.
 */
export const CATEGORY_LABELS: Record<CategoryGroup, string> = {
  "Food & Drink": "Eateries",
  Shopping: "Shopping",
  "Entertainment & Recreation": "Attractions",
  Stadiums: "Stadiums",
  "Automotive & Transport": "Transport",
  "Finance & Business": "Business",
  "Health & Wellness": "Health & Beauty",
  Lodging: "Hotels",
  "Education & Government": "Civic",
  "Places of Worship": "Worship",
};

/**
 * A glyph per category chip — the rail is icon-led. Keyed by the canonical group name,
 * same lockstep-by-contract as the labels; a group with no entry falls back to the pin.
 */
export const CATEGORY_ICONS: Record<CategoryGroup, IconName> = {
  "Food & Drink": "dining",
  Shopping: "bag",
  "Entertainment & Recreation": "star",
  Stadiums: "ticket",
  "Automotive & Transport": "bus",
  "Finance & Business": "briefcase",
  "Health & Wellness": "person",
  Lodging: "hotel",
  "Education & Government": "landmark",
  "Places of Worship": "church",
};

/** The friendly pill label for a canonical group (falls back to the canonical name). */
export function categoryLabel(group: string): string {
  return CATEGORY_LABELS[group as CategoryGroup] ?? group;
}

/** The chip glyph for a canonical group (falls back to the place pin). */
export function categoryIcon(group: string): IconName {
  return CATEGORY_ICONS[group as CategoryGroup] ?? "place";
}

/** A Places leaf type ("fast_food_restaurant") as a readable sub-category label. */
export function leafLabel(type: string): string {
  return type.replace(/_/g, " ");
}
