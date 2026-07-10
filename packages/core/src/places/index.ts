/**
 * Places taxonomy — the two-level venue category model, defined once.
 *
 * Roam browses venues by a small set of broad GROUPS (the scrollable pill row), each
 * owning an ordered list of Google Places (New) leaf TYPES (the sub-category row). This
 * one module is the single source of truth for:
 *   - what `includedTypes` a category-pill tap sends to Places `searchNearby` (the fetch), and
 *   - how a returned place is classified back to exactly ONE canonical group (the write).
 *
 * Why both live here: the fetch payload and the classification rule must never drift —
 * if a leaf type is fetchable under a group it must also classify INTO that group. Keeping
 * them as one data structure makes drift impossible by construction.
 *
 * Storage mapping (matches venues schema as built):
 *   - `category`   (text)   = the GROUP (e.g. "Food & Drink") — the canonical pill value.
 *   - `categories` (text[]) = the matched leaf TYPES (e.g. ["sushi_restaurant","restaurant"])
 *                              — powers the sub-category row and fine filtering.
 *
 * Geographical/administrative Places types (locality, postal_code, country,
 * administrative_area_level_*) are DELIBERATELY EXCLUDED here — they are not venues; they
 * belong to locality/postcode anchoring (a later slice), not venue ingestion.
 *
 * Framework- and DB-agnostic, no I/O, no clock. `placeToVenueRow` returns a plain
 * coordinate; the DB/upsert layer builds the PostGIS point (same split as venues_near).
 */

import type { DayPeriods } from "../hours/index.js";

/** The ten canonical groups — the top-level pill row. Order here is display order. */
export const CATEGORIES = [
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

export type CategoryId = (typeof CATEGORIES)[number];

/**
 * Each group → its ordered Google Places (New) included types (the sub-categories).
 * This list is BOTH the searchNearby request payload for the group AND the membership
 * set used to classify a returned place. Geographical/admin types excluded by design.
 */
export const CATEGORY_PLACES_TYPES: Record<CategoryId, readonly string[]> = {
  "Food & Drink": [
    "restaurant", "cafe", "bar", "bakery", "fast_food_restaurant",
    "american_restaurant", "asian_fusion_restaurant", "brazilian_restaurant",
    "chinese_restaurant", "french_restaurant", "indian_restaurant",
    "italian_restaurant", "japanese_restaurant", "mexican_restaurant",
    "middle_eastern_restaurant", "seafood_restaurant", "spanish_restaurant",
    "steak_house", "sushi_restaurant", "thai_restaurant", "vegan_restaurant",
    "vegetarian_restaurant",
    "bar_and_grill", "beer_garden", "pub", "wine_bar",
    "coffee_shop", "dessert_shop", "donut_shop", "ice_cream_shop", "juice_shop",
  ],
  "Shopping": [
    "store", "shopping_mall", "supermarket", "grocery_store", "convenience_store",
    "clothing_store", "shoe_store", "department_store", "jewelry_store",
    "electronics_store", "home_goods_store", "furniture_store", "hardware_store",
    "book_store", "florist", "gift_shop", "pet_store", "toy_store",
    "liquor_store", "pharmacy", "wholesaler",
  ],
  "Entertainment & Recreation": [
    "amusement_park", "aquarium", "art_gallery", "museum", "zoo",
    "movie_theater", "performing_arts_theater", "concert_hall", "opera_house",
    "casino", "night_club", "bowling_alley", "video_arcade",
    "sports_complex", "fitness_center", "gym", "swimming_pool",
    "park", "dog_park", "botanical_garden", "national_park", "tourist_attraction",
  ],
  // Stadiums & arenas get their own top-level pill — the local football ground / big event
  // venue is a landmark people browse for by itself, so `stadium` moves here out of
  // Entertainment (a venue has exactly one category). `sports_complex` (leisure centres,
  // sports parks) stays under Entertainment — it's a sports centre, not a stadium.
  "Stadiums": [
    "stadium", "arena",
  ],
  "Automotive & Transport": [
    "car_dealer", "car_rental", "car_repair", "car_wash",
    "gas_station", "electric_vehicle_charging_station",
    "parking", "parking_garage", "parking_lot",
    "airport", "bus_station", "subway_station", "train_station",
    "transit_station", "taxi_stand",
  ],
  "Finance & Business": [
    "bank", "atm", "accounting", "insurance_agency",
    "corporate_office", "business_center", "coworking_space",
  ],
  "Health & Wellness": [
    "hospital", "medical_clinic", "dentist", "doctor", "physiotherapist",
    "spa", "massage", "beauty_salon", "hair_salon", "nail_salon",
    "veterinary_care",
  ],
  "Lodging": [
    "hotel", "motel", "resort_hotel", "bed_and_breakfast", "hostel", "lodging",
    "campground", "rv_park",
  ],
  "Education & Government": [
    "school", "primary_school", "secondary_school", "university", "library",
    "preschool",
    "city_hall", "courthouse", "embassy", "local_government_office", "police",
    "post_office", "fire_station",
  ],
  "Places of Worship": [
    "church", "mosque", "synagogue", "hindu_temple", "buddhist_temple",
  ],
};

/**
 * Tie-break order for classification. A Places result can carry types spanning more than
 * one group (e.g. a wine_bar that is also a liquor_store); precedence makes the landing
 * group deterministic. Consumer-facing high-street groups rank highest; generic
 * catch-alls (Finance, with bank/atm) lowest so they never swallow a more specific match.
 * This is the agreed order — changing it changes classification, so the test pins it.
 */
export const CATEGORY_PRECEDENCE: readonly CategoryId[] = [
  "Food & Drink",
  "Health & Wellness",
  "Lodging",
  "Stadiums",
  "Entertainment & Recreation",
  "Shopping",
  "Automotive & Transport",
  "Education & Government",
  "Places of Worship",
  "Finance & Business",
];

/** Fast membership lookup: leaf type -> set of groups that own it. */
const TYPE_TO_CATEGORIES: ReadonlyMap<string, readonly CategoryId[]> = (() => {
  const m = new Map<string, CategoryId[]>();
  for (const cat of CATEGORIES) {
    for (const t of CATEGORY_PLACES_TYPES[cat]) {
      const arr = m.get(t) ?? [];
      arr.push(cat);
      m.set(t, arr);
    }
  }
  return m;
})();

/**
 * A group pill -> the Places (New) `includedTypes` for its searchNearby request.
 * Throws on an unknown id so a typo can't silently fetch nothing.
 *
 * example: "Food & Drink" -> ["restaurant","cafe","bar",...]
 */
export function categoryToPlacesTypes(category: CategoryId): readonly string[] {
  const types = CATEGORY_PLACES_TYPES[category];
  if (!types) throw new Error(`Unknown category: ${String(category)}`);
  return types;
}

/**
 * Classify a Places result's `types[]` to exactly one canonical group, or null if none
 * match (e.g. a purely geographical/admin result we don't categorise — caller skips it).
 *
 * Rule: Places lists types most-specific-first. We walk the place's types in order and,
 * for the first type that belongs to any group, return the highest-precedence owning
 * group. Most-specific-first means `book_store` wins over a trailing generic `store`.
 *
 * example: ["sushi_restaurant","restaurant","food","point_of_interest"] -> "Food & Drink"
 * example: ["book_store","store","establishment"]                       -> "Shopping"
 * example: ["locality","political"]                                     -> null
 */
export function classifyPlaceTypes(types: readonly string[]): CategoryId | null {
  for (const t of types) {
    const owners = TYPE_TO_CATEGORIES.get(t);
    if (!owners) continue;
    if (owners.length === 1) return owners[0]!;
    // Multi-owner leaf: resolve by precedence.
    for (const cat of CATEGORY_PRECEDENCE) {
      if (owners.includes(cat)) return cat;
    }
  }
  return null;
}

/**
 * The stored photo shape — our own minimal contract, NOT the raw Places photo object.
 * We keep only: a reference (resolved later through our server-side proxy, never the raw
 * billable Places endpoint on render), the ToS-required attribution, and the pixel dims
 * (so the gallery reserves aspect ratio without layout shift). We deliberately do NOT
 * copy photo bytes — storing scraped image bytes would breach Places caching terms; we
 * store a POINTER + provenance, exactly as opening hours stores a marker not raw periods.
 */
export interface PlacePhoto {
  /** Places (New) photo resource `name` — the handle our proxy resolves. */
  places_photo_ref: string;
  /** authorAttributions from Places — required to be shown wherever the photo renders. */
  attribution: PhotoAttribution[];
  width: number | null;
  height: number | null;
}

/** A single required photo attribution (author display name + optional profile uri). */
export interface PhotoAttribution {
  displayName: string;
  uri: string | null;
}

/**
 * The stored opening-hours shape — our own minimal contract, NOT the raw Places
 * object. We keep only the 7 human-readable day strings (what a "plannable" page
 * renders) plus a provenance marker. Deliberately NO structured periods[]: live
 * "open now" needs timezone + clock math and is a separate slice; storing periods
 * now would be unused weight. Widen here (and the field mask) when that slice lands.
 */
export interface OpeningTimes {
  weekdayDescriptions: string[];
  /** Owner-authored structured hours (Slice 8). Absent on Places-sourced venues,
   *  which carry only the free-text weekdayDescriptions above. Present => "open now"
   *  is computable via @roam/core/hours isOpenNow. */
  periods?: DayPeriods[];
  /** IANA timezone for the structured periods (owner-authored). Required for a
   *  correct "open now" evaluation; absent on Places-sourced venues. */
  timezone?: string;
  source: "google_places" | "owner";
}

/**
 * Pull our OpeningTimes from a Places result, or null when Places returned no hours
 * (the common case for many venues). Pure: no clock, no I/O. Null must round-trip
 * cleanly all the way to the DB column (which is nullable by design).
 */
export function placeOpeningTimes(place: PlaceResult): OpeningTimes | null {
  const days = place.regularOpeningHours?.weekdayDescriptions;
  if (!Array.isArray(days) || days.length === 0) return null;
  const clean = days.filter((d): d is string => typeof d === "string" && d.length > 0);
  if (clean.length === 0) return null;
  return { weekdayDescriptions: clean, source: "google_places" };
}

/**
 * Map a Places result's photos[] to our minimal PlacePhoto rows. Returns [] when Places
 * returned no photos (common) — an empty list round-trips cleanly to "no photo rows
 * written". Pure: no I/O, no clock. A photo with no usable ref is dropped (unusable).
 * Attribution entries with an empty display name are dropped (cannot be shown to ToS).
 *
 * NB: this returns photo rows SEPARATELY from placeToVenueRow — photos are rows in the
 * venue_photos table, not columns on venues. The ingest layer writes each to its own
 * table. That keeps the venues/venue_photos boundary the 0019 design depends on.
 */
export function placePhotos(place: PlaceResult): PlacePhoto[] {
  const photos = place.photos;
  if (!Array.isArray(photos) || photos.length === 0) return [];
  const out: PlacePhoto[] = [];
  for (const p of photos) {
    const ref = p?.name?.trim();
    if (!ref) continue;
    const attribution = (p.authorAttributions ?? [])
      .map((a: { displayName?: string; uri?: string }) => ({
        displayName: a?.displayName?.trim() ?? "",
        uri: a?.uri?.trim() || null,
      }))
      .filter((a: { displayName: string; uri: string | null }) => a.displayName.length > 0);
    out.push({
      places_photo_ref: ref,
      attribution,
      width: typeof p.widthPx === "number" ? p.widthPx : null,
      height: typeof p.heightPx === "number" ? p.heightPx : null,
    });
  }
  return out;
}

/** A coordinate. Mirrors geo's LatLng; the DB builds the PostGIS point from it. */
export interface LatLng {
  lat: number;
  lng: number;
}

// ============================================================================
// On-demand ingestion cost policy — the tunable knobs, defined once.
//
// The api's ingestCategory makes a PAID Places searchNearby call only when there is no
// fresh local coverage. Three independent bounds keep that cost finite; the two numeric
// caps + the snap grid live here (pure, testable) and are passed into the api/DB layers:
//   • TEMPORAL  — 30-day freshness window (in SQL: count_fresh_places_venues).
//   • SPATIAL   — snapToIngestGrid below: collapse near-identical points to one cache key
//                 so the freshness skip actually catches coordinate enumeration.
//   • VOLUME    — PLACES_DAILY_FETCH_BUDGET (global/day) + the per-client window limit
//                 (enforced atomically in SQL: claim_places_fetch_quota, migration 0024).
// ============================================================================

/**
 * Grid size (degrees) the ingest query point is snapped to. ~0.005° ≈ 555 m. Chosen below
 * the default 1500 m search radius so snapping never opens a coverage hole (the snapped
 * centre is within ~390 m of the true point, well inside the radius), while collapsing
 * jittered/enumerated coordinates in the same neighbourhood into a single freshness key.
 * Tunable: larger = more dedup (cheaper) but a coarser search centre.
 */
export const INGEST_SNAP_DEGREES = 0.005;

/** Hard ceiling on paid searchNearby calls per day, across ALL callers. The wallet backstop. */
export const PLACES_DAILY_FETCH_BUDGET = 2000;

/**
 * Hard ceiling on paid Place DETAILS calls per day, across ALL callers — the on-demand venue
 * enrichment budget (0080). Kept SEPARATE from PLACES_DAILY_FETCH_BUDGET (its own DB bucket) so
 * Details spend — the pricier Atmosphere SKU — can never starve area discovery, and vice-versa.
 * Enrichment is one Details call per venue LIFETIME (the details_fetched_at marker), so demand
 * naturally decays; this is the wallet backstop against a surge. Tunable without a migration.
 */
export const PLACES_DETAILS_DAILY_BUDGET = 1000;

/** Max paid searchNearby calls a single client (by IP) may trigger per window. Fairness. */
export const PLACES_CLIENT_FETCH_LIMIT = 60;

/** The per-client fixed window, in seconds (1 hour). */
export const PLACES_CLIENT_WINDOW_SECS = 3600;

/**
 * Snap a coordinate to the ingest grid. Pure. Two requests in the same cell produce the
 * same point, so the second hits the freshness cache instead of paying for a fetch — this
 * is what turns "infinite distinct points" into "finite grid cells" for cost purposes.
 * Used for BOTH the freshness check and the searchNearby centre so they stay consistent.
 */
export function snapToIngestGrid(lat: number, lng: number): LatLng {
  const step = INGEST_SNAP_DEGREES;
  return {
    lat: Math.round(lat / step) * step,
    lng: Math.round(lng / step) * step,
  };
}

/**
 * The subset of a Places (New) result we read (matches the field mask). Minimal by
 * design — we request only these fields, so we type only these.
 */
export interface PlaceResult {
  id: string;
  displayName?: { text?: string } | undefined;
  location?: { latitude?: number; longitude?: number } | undefined;
  types?: readonly string[] | undefined;
  formattedAddress?: string | undefined;
  /**
   * Places (New) address components — we read only the town: `postal_town` (the UK's
   * postal town, usually the name locals use) with `locality` as the fallback.
   */
  addressComponents?:
    | readonly { longText?: string; shortText?: string; types?: readonly string[] }[]
    | undefined;
  rating?: number | undefined;
  /** Total number of user ratings behind `rating` (credibility on the card). */
  userRatingCount?: number | undefined;
  /** Places' clean localized type label, e.g. "Coffee shop", "Italian restaurant". */
  primaryTypeDisplayName?: { text?: string } | undefined;
  /** Places (New) price level enum, e.g. "PRICE_LEVEL_MODERATE". UNSPECIFIED → no signal. */
  priceLevel?: string | undefined;
  businessStatus?: string | undefined;
  /** Places (New) regular hours. We read only the human display strings. */
  regularOpeningHours?: { weekdayDescriptions?: string[] } | undefined;
  /**
   * Places (New) photos. Each carries a resource `name` (our ref), pixel dims, and
   * authorAttributions. We map to our minimal PlacePhoto via placePhotos(); we never
   * persist the bytes.
   */
  photos?:
    | readonly {
        name?: string;
        widthPx?: number;
        heightPx?: number;
        authorAttributions?: readonly { displayName?: string; uri?: string }[];
      }[]
    | undefined;

  /* ── Details-only enrichment fields (rich venue facts; requested ONLY on the Place
     Details path — never on searchNearby, whose field mask stays lean for cost). ─────── */

  /** Local-format phone number, e.g. "028 9024 1100". */
  nationalPhoneNumber?: string | undefined;
  /** The business's own website. */
  websiteUri?: string | undefined;
  /** Places (New) price range: start/end money amounts. `units` is a decimal string. */
  priceRange?:
    | {
        startPrice?: { currencyCode?: string; units?: string } | undefined;
        endPrice?: { currencyCode?: string; units?: string } | undefined;
      }
    | undefined;
  paymentOptions?: Record<string, boolean | undefined> | undefined;
  parkingOptions?: Record<string, boolean | undefined> | undefined;
  accessibilityOptions?: Record<string, boolean | undefined> | undefined;
  // Service options
  takeout?: boolean | undefined;
  delivery?: boolean | undefined;
  dineIn?: boolean | undefined;
  curbsidePickup?: boolean | undefined;
  reservable?: boolean | undefined;
  // Dining
  servesBreakfast?: boolean | undefined;
  servesBrunch?: boolean | undefined;
  servesLunch?: boolean | undefined;
  servesDinner?: boolean | undefined;
  servesBeer?: boolean | undefined;
  servesWine?: boolean | undefined;
  servesCocktails?: boolean | undefined;
  servesCoffee?: boolean | undefined;
  servesDessert?: boolean | undefined;
  servesVegetarianFood?: boolean | undefined;
  // Amenities & vibe
  outdoorSeating?: boolean | undefined;
  liveMusic?: boolean | undefined;
  menuForChildren?: boolean | undefined;
  goodForChildren?: boolean | undefined;
  goodForGroups?: boolean | undefined;
  goodForWatchingSports?: boolean | undefined;
  allowsDogs?: boolean | undefined;
  restroom?: boolean | undefined;
}

/** The boolean attribute keys we lift verbatim from a Places Details result into the
 *  venues.attributes jsonb bag. One list so the field mask, the extractor and the tests
 *  can never drift. */
export const PLACE_ATTRIBUTE_KEYS = [
  "takeout",
  "delivery",
  "dineIn",
  "curbsidePickup",
  "reservable",
  "servesBreakfast",
  "servesBrunch",
  "servesLunch",
  "servesDinner",
  "servesBeer",
  "servesWine",
  "servesCocktails",
  "servesCoffee",
  "servesDessert",
  "servesVegetarianFood",
  "outdoorSeating",
  "liveMusic",
  "menuForChildren",
  "goodForChildren",
  "goodForGroups",
  "goodForWatchingSports",
  "allowsDogs",
  "restroom",
] as const;

/** The Places option-group keys stored as sub-objects inside venues.attributes. */
export const PLACE_OPTION_GROUP_KEYS = ["paymentOptions", "parkingOptions", "accessibilityOptions"] as const;

/** Normalized rich-detail facts for a venue row (0065): phone, website, price range, and
 *  the attributes jsonb bag. Everything null when Places gave no signal. */
export interface PlaceRichFields {
  phone: string | null;
  website_url: string | null;
  /** {start, end, currency} in whole currency units, or null when Places has no range. */
  price_range: { start: number | null; end: number | null; currency: string | null } | null;
  /** Boolean facts + option-group sub-objects; ONLY keys Places actually returned. Null
   *  when it returned none, so enrichment never overwrites data with an empty bag. */
  attributes: Record<string, boolean | Record<string, boolean>> | null;
}

/** Parse a Places money `units` decimal string to a number, or null. */
function moneyUnits(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract the rich-detail facts from a Places Details result. Pure; null-safe. Booleans
 * are copied ONLY when present (true or false both carry signal: "no outdoor seating" is
 * a fact); absent keys stay absent so the UI can distinguish "no" from "unknown".
 */
export function placeRichFields(place: PlaceResult): PlaceRichFields {
  const attributes: Record<string, boolean | Record<string, boolean>> = {};
  for (const key of PLACE_ATTRIBUTE_KEYS) {
    const v = place[key];
    if (typeof v === "boolean") attributes[key] = v;
  }
  for (const group of PLACE_OPTION_GROUP_KEYS) {
    const raw = place[group];
    if (!raw) continue;
    const cleaned: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "boolean") cleaned[k] = v;
    }
    if (Object.keys(cleaned).length > 0) attributes[group] = cleaned;
  }

  const start = moneyUnits(place.priceRange?.startPrice?.units);
  const end = moneyUnits(place.priceRange?.endPrice?.units);
  const currency = place.priceRange?.startPrice?.currencyCode ?? place.priceRange?.endPrice?.currencyCode ?? null;

  return {
    phone: place.nationalPhoneNumber?.trim() || null,
    website_url: place.websiteUri?.trim() || null,
    price_range: start !== null || end !== null ? { start, end, currency } : null,
    attributes: Object.keys(attributes).length > 0 ? attributes : null,
  };
}

/**
 * A venue insert row sourced from Places. The pure transform at the heart of the upsert.
 * - `source`/`source_ref` carry the dedup identity (unique(source, source_ref) in DB).
 * - `category` = the group (the originating pill, source-of-truth for our taxonomy).
 * - `categories` = the place's matched leaf types (sub-category granularity).
 * - coordinate returned as plain lat/lng; the DB layer makes the geography point.
 * No clock, no id-gen: deterministic so it can be asserted exactly. `fetched_at` and the
 * PostGIS point are applied by the writer.
 */
export interface VenueRowFromPlace {
  source: "google_places";
  source_ref: string;
  name: string;
  lat: number;
  lng: number;
  category: CategoryId;
  categories: string[];
  rating: number | null;
  /** Number of ratings behind `rating`; 0 when Places gives none (column is NOT NULL). */
  rating_count: number;
  /** Normalized price level ("PRICE_LEVEL_*"), or null when unspecified/absent. */
  price_level: string | null;
  /** Places' clean type label for the card subtitle, or null. */
  primary_type_label: string | null;
  /**
   * Places businessStatus, but only the values we keep: "OPERATIONAL" or
   * "CLOSED_TEMPORARILY" (permanently-closed places are dropped above), else null. Lets
   * the card badge a temporarily-closed venue instead of silently showing it as normal.
   */
  business_status: string | null;
  address: string | null;
  /**
   * The town the venue belongs to (Places' postal_town, falling back to locality), or
   * null when Places gives neither. Powers every by-town read: the Town Hall hub's
   * Places strip, the Market's town feed, hub indexability and the sitemap's venue towns.
   */
  locality: string | null;
  source_attribution: string;
  opening_times: OpeningTimes | null;
}

const ATTRIBUTION = "Information from public sources";

/**
 * The venue's town from Places address components. UK addressing quirk: the name locals
 * (and the old town pages) use is usually the POSTAL TOWN ("Belfast", "Darlington"), while
 * `locality` is often a smaller district or missing — so prefer postal_town, fall back to
 * locality, else null. Pure; tolerant of partial components.
 */
export function placeLocality(place: PlaceResult): string | null {
  const components = place.addressComponents ?? [];
  const byType = (t: string): string | null => {
    for (const c of components) {
      if (c.types?.includes(t)) {
        const name = c.longText?.trim() || c.shortText?.trim();
        if (name) return name;
      }
    }
    return null;
  };
  return byType("postal_town") ?? byType("locality");
}

/**
 * Normalize a Places (New) priceLevel to our stored value: the enum string as-is, except
 * the "unspecified" / empty / unknown cases collapse to null (no signal → no card chip).
 */
export function normalizePriceLevel(raw: string | undefined): string | null {
  if (!raw || raw === "PRICE_LEVEL_UNSPECIFIED") return null;
  return raw;
}

/* ── Town-hub venue ranking (which venues represent a town) ─────────────────────────────── */

/**
 * The consumer categories a town's discovery surfaces lead with — eateries, shops, hotels
 * and things to do. Everything else (transport, business services, health, civic, worship)
 * is genuine coverage but a poor first impression, so it only fills in when tier-1 runs dry.
 */
export const HUB_TIER_1_CATEGORIES: readonly CategoryId[] = [
  "Food & Drink",
  "Shopping",
  "Entertainment & Recreation",
  "Lodging",
];

const HUB_TIER_1 = new Set<string>(HUB_TIER_1_CATEGORIES);

/** 1 = lead category (consumer/discovery), 2 = fill-in. Unknown/null categories are tier 2. */
export function hubCategoryTier(category: string | null): 1 | 2 {
  return category !== null && HUB_TIER_1.has(category) ? 1 : 2;
}

/**
 * Bayesian-shrunk rating: pull a venue's rating toward the site-wide prior until enough
 * reviews back it up, so a 4.8 with 400 ratings outranks a 5.0 with 3. Standard weighted
 * mean — score = (n·R + m·C) / (n + m) with prior weight m and prior mean C. No ratings at
 * all scores the prior mean exactly (neutral, not punished).
 */
export const RATING_PRIOR_WEIGHT = 25;
export const RATING_PRIOR_MEAN = 4.2;

export function weightedVenueRating(rating: number | null, ratingCount: number): number {
  const n = Math.max(0, ratingCount);
  if (rating === null || n === 0) return RATING_PRIOR_MEAN;
  return (n * rating + RATING_PRIOR_WEIGHT * RATING_PRIOR_MEAN) / (n + RATING_PRIOR_WEIGHT);
}

/** The card-enrichment facts pulled from a Places result, shared by the ingest row mapper
 *  and the enrichment backfill so the mapping lives in exactly one place. */
export interface PlaceCardFields {
  rating: number | null;
  /** NOT nullable: venues.rating_count is `integer not null default 0` (0001); 0 = no
   *  ratings, and the card only shows the count when > 0. */
  rating_count: number;
  price_level: string | null;
  primary_type_label: string | null;
  business_status: string | null;
}

/** Extract the card-enrichment facts from a Places result. Pure; null-safe throughout. */
export function placeCardFields(place: PlaceResult): PlaceCardFields {
  return {
    rating: typeof place.rating === "number" ? place.rating : null,
    // 0 (not null) when Places gives no count — matches venues.rating_count's NOT NULL
    // default-0 contract, so both the live upsert and the backfill update stay valid.
    rating_count: typeof place.userRatingCount === "number" ? place.userRatingCount : 0,
    price_level: normalizePriceLevel(place.priceLevel),
    primary_type_label: place.primaryTypeDisplayName?.text?.trim() || null,
    business_status: place.businessStatus?.trim() || null,
  };
}

/**
 * Map a Places result + the originating group pill to a venue insert row.
 * The pill is the source of truth for `category`; the place's own matched leaf types
 * (those that belong to the pill's group) become `categories`. A place missing an id,
 * name, or coordinate is not a usable venue — the caller must skip nulls.
 *
 * example: (sushi place, "Food & Drink") ->
 *   { source:"google_places", category:"Food & Drink",
 *     categories:["sushi_restaurant","restaurant"], ... }
 */
export function placeToVenueRow(
  place: PlaceResult,
  category: CategoryId,
): VenueRowFromPlace | null {
  const name = place.displayName?.text?.trim();
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  if (!place.id || !name || typeof lat !== "number" || typeof lng !== "number") {
    return null;
  }

  // Drop permanently-closed places at the source: a dead venue is worse than no venue on a
  // discovery grid. (Temporarily-closed venues are kept — they reopen; the card can badge
  // them.) businessStatus rides the field mask we already request.
  if (place.businessStatus === "CLOSED_PERMANENTLY") return null;

  // Keep only the place's types that belong to the chosen group, preserving Places'
  // most-specific-first order. This is the sub-category set for this venue.
  const groupTypes = new Set(CATEGORY_PLACES_TYPES[category]);
  const leaves = (place.types ?? []).filter((t) => groupTypes.has(t));

  return {
    source: "google_places",
    source_ref: place.id,
    name,
    lat,
    lng,
    category,
    categories: leaves,
    ...placeCardFields(place),
    address: place.formattedAddress?.trim() || null,
    locality: placeLocality(place),
    source_attribution: ATTRIBUTION,
    opening_times: placeOpeningTimes(place),
  };
}
