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

/** The nine canonical groups — the top-level pill row. Order here is display order. */
export const CATEGORIES = [
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
    "stadium", "sports_complex", "fitness_center", "gym", "swimming_pool",
    "park", "dog_park", "botanical_garden", "national_park", "tourist_attraction",
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
  rating?: number | undefined;
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
  address: string | null;
  source_attribution: string;
  opening_times: OpeningTimes | null;
}

const ATTRIBUTION = "Information from public sources";

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
    rating: typeof place.rating === "number" ? place.rating : null,
    address: place.formattedAddress?.trim() || null,
    source_attribution: ATTRIBUTION,
    opening_times: placeOpeningTimes(place),
  };
}
