/**
 * SEO discovery intent map — the small set of high-intent town × category landing pages
 * (/discover/<town>/<category>) that Roam publishes for organic search. Each entry pairs a
 * stable URL slug with the canonical core CATEGORY it filters on and the human phrasing used
 * across the page title, H1, metadata, and JSON-LD ("Places to eat & drink in Darlington").
 *
 * Deliberately a curated subset of core's CATEGORIES, not the whole list: these are the five
 * categories real searchers phrase as intent ("things to do in…", "places to stay in…"), so
 * every published URL maps to genuine demand and real venue depth. Adding a category here is a
 * one-line change once the venue data supports it.
 *
 * `category` values are the exact core CATEGORY strings (packages/core places CATEGORIES) —
 * typed as string here rather than importing the union, mirroring how the rest of the web app
 * keeps a local copy instead of a runtime dependency on the Node-ESM core package.
 */
export interface DiscoverCategory {
  /** URL segment, e.g. "food-and-drink". Lowercase, hyphenated, stable. */
  slug: string;
  /** The core CATEGORY this maps to (what venues.byLocalityCategory filters on). */
  category: string;
  /** Noun phrase for headings — "Places to eat & drink in <town>". */
  heading: string;
  /** Search-intent label for the H1 / title — "Best places to eat & drink in <town>". */
  intent: string;
  /** One-line lead used in metadata + the on-page intro. `{town}` is substituted. */
  blurb: string;
}

export const DISCOVER_CATEGORIES: DiscoverCategory[] = [
  {
    slug: "food-and-drink",
    category: "Food & Drink",
    heading: "Places to eat & drink",
    intent: "Best places to eat & drink",
    blurb: "Restaurants, cafés, pubs and bars in {town}, ranked by what locals rate most.",
  },
  {
    slug: "things-to-do",
    category: "Entertainment & Recreation",
    heading: "Things to do",
    intent: "Best things to do",
    blurb: "Attractions, activities and days out in {town}, ranked by what locals rate most.",
  },
  {
    slug: "shopping",
    category: "Shopping",
    heading: "Places to shop",
    intent: "Best places to shop",
    blurb: "Shops, markets and stores in {town}, ranked by what locals rate most.",
  },
  {
    slug: "health-and-wellness",
    category: "Health & Wellness",
    heading: "Health & wellness",
    intent: "Best health & wellness",
    blurb: "Gyms, salons, clinics and spas in {town}, ranked by what locals rate most.",
  },
  {
    slug: "places-to-stay",
    category: "Lodging",
    heading: "Places to stay",
    intent: "Best places to stay",
    blurb: "Hotels, inns and guest houses in {town}, ranked by what locals rate most.",
  },
];

const BY_SLUG = new Map(DISCOVER_CATEGORIES.map((c) => [c.slug, c]));
const BY_CATEGORY = new Map(DISCOVER_CATEGORIES.map((c) => [c.category, c.slug]));

/** Resolve a URL segment to its discovery category, or null if it isn't a published one. */
export function discoverCategoryBySlug(slug: string): DiscoverCategory | null {
  return BY_SLUG.get(slug.toLowerCase()) ?? null;
}

/** The core CATEGORY strings we publish discovery pages for — the sitemap/API filter set. */
export function discoverCategories(): string[] {
  return DISCOVER_CATEGORIES.map((c) => c.category);
}

/** Map a core CATEGORY (e.g. "Food & Drink") to its published discovery slug, or null. */
export function discoverSlugForCategory(category: string): string | null {
  return BY_CATEGORY.get(category) ?? null;
}

/** The chip links a town hub renders — every published discovery category for that town. */
export function discoverCategorySlugs(): string[] {
  return DISCOVER_CATEGORIES.map((c) => c.slug);
}
