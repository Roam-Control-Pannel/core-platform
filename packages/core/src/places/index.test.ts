import { describe, it, expect } from "vitest";
import {
  CATEGORIES,
  CATEGORY_PLACES_TYPES,
  CATEGORY_PRECEDENCE,
  categoryToPlacesTypes,
  classifyPlaceTypes,
  placeToVenueRow,
  type CategoryId,
  type PlaceResult,
} from "./index.js";

describe("taxonomy shape", () => {
  it("has the nine agreed groups", () => {
    expect(CATEGORIES.length).toBe(9);
    expect(CATEGORIES).toContain("Food & Drink");
    expect(CATEGORIES).toContain("Places of Worship");
  });

  it("every group has a non-empty ordered leaf list", () => {
    for (const c of CATEGORIES) {
      expect(CATEGORY_PLACES_TYPES[c].length).toBeGreaterThan(0);
    }
  });

  it("precedence covers exactly the nine groups (no missing, no extras)", () => {
    expect([...CATEGORY_PRECEDENCE].sort()).toEqual([...CATEGORIES].sort());
  });

  it("excludes geographical/administrative types entirely", () => {
    const all = new Set(CATEGORIES.flatMap((c) => [...CATEGORY_PLACES_TYPES[c]]));
    for (const geo of [
      "locality", "sublocality", "postal_code", "country",
      "administrative_area_level_1", "administrative_area_level_2",
    ]) {
      expect(all.has(geo)).toBe(false);
    }
  });
});

describe("categoryToPlacesTypes", () => {
  it("returns the group's included types for searchNearby", () => {
    const t = categoryToPlacesTypes("Food & Drink");
    expect(t).toContain("restaurant");
    expect(t).toContain("pub");
    expect(t).toContain("coffee_shop");
  });

  it("throws on an unknown category (typo cannot silently fetch nothing)", () => {
    expect(() => categoryToPlacesTypes("Nightlife" as CategoryId)).toThrow();
  });
});

describe("classifyPlaceTypes", () => {
  it("classifies a specific restaurant to Food & Drink", () => {
    expect(
      classifyPlaceTypes(["sushi_restaurant", "restaurant", "food", "point_of_interest"]),
    ).toBe("Food & Drink");
  });

  it("uses most-specific-first: book_store wins over a trailing generic store", () => {
    expect(classifyPlaceTypes(["book_store", "store", "establishment"])).toBe("Shopping");
  });

  it("returns null for a purely geographical result (caller skips it)", () => {
    expect(classifyPlaceTypes(["locality", "political"])).toBeNull();
  });

  it("returns null when nothing is recognised", () => {
    expect(classifyPlaceTypes(["point_of_interest", "establishment"])).toBeNull();
  });

  it("resolves a cross-group tie by precedence (wine_bar Food&Drink over Shopping)", () => {
    // wine_bar is Food & Drink; liquor_store is Shopping. A place tagged both, with the
    // bar type first, lands in Food & Drink (higher precedence AND more specific first).
    expect(classifyPlaceTypes(["wine_bar", "liquor_store", "store"])).toBe("Food & Drink");
  });
});

describe("placeToVenueRow", () => {
  const darlingtonSushi: PlaceResult = {
    id: "ChIJ_test_sushi",
    displayName: { text: "  Sakura Darlington  " },
    location: { latitude: 54.5253, longitude: -1.5849 },
    types: ["sushi_restaurant", "restaurant", "food", "point_of_interest"],
    formattedAddress: "1 High Row, Darlington",
    rating: 4.6,
    businessStatus: "OPERATIONAL",
  };

  it("maps a place + group to a venue insert row, pill as canonical category", () => {
    const row = placeToVenueRow(darlingtonSushi, "Food & Drink");
    expect(row).not.toBeNull();
    expect(row!.source).toBe("google_places");
    expect(row!.source_ref).toBe("ChIJ_test_sushi");
    expect(row!.name).toBe("Sakura Darlington"); // trimmed
    expect(row!.lat).toBe(54.5253);
    expect(row!.lng).toBe(-1.5849);
    expect(row!.category).toBe("Food & Drink"); // the pill, not a Places type
    expect(row!.rating).toBe(4.6);
    expect(row!.address).toBe("1 High Row, Darlington");
    expect(row!.source_attribution).toBe("Information from public sources");
  });

  it("keeps only the group's leaf types as sub-categories, in Places order", () => {
    const row = placeToVenueRow(darlingtonSushi, "Food & Drink");
    // food / point_of_interest are not group leaves; sushi_restaurant + restaurant are.
    expect(row!.categories).toEqual(["sushi_restaurant", "restaurant"]);
  });

  it("returns null when the place lacks a usable identity/coordinate", () => {
    expect(placeToVenueRow({ id: "", types: [] }, "Shopping")).toBeNull();
    expect(
      placeToVenueRow({ id: "x", displayName: { text: "No Coords" } }, "Shopping"),
    ).toBeNull();
  });

  it("nulls a missing rating rather than inventing one", () => {
    const row = placeToVenueRow(
      {
        id: "ChIJ_test_shop",
        displayName: { text: "Corner Shop" },
        location: { latitude: 54.52, longitude: -1.55 },
        types: ["convenience_store", "store"],
      },
      "Shopping",
    );
    expect(row!.rating).toBeNull();
    expect(row!.categories).toEqual(["convenience_store", "store"]);
  });
});

/**
 * Google Places (New) Table A validation — cheap insurance against the bug class that
 * bit in Slice 1: a leaf type that LOOKS plausible but is invalid as a searchNearby
 * `includedTypes` value (`steakhouse` vs `steak_house`), or a type that is Table B
 * (response-only, request-forbidden — e.g. `place_of_worship`). Either reaches a live,
 * paid Places call and fails or silently fetches nothing.
 *
 * The check is three layers, deliberately NOT a hand-maintained full mirror of Table A
 * (which Google revises — the live list was last revised 2026-02-12 / 2026-03-31):
 *   1. STRUCTURAL — every type is lowercase snake_case, no duplicates. Kills malformed
 *      strings and accidental whitespace/casing.
 *   2. DENYLIST — none of our types is a known Table B / geographical / generic type.
 *      This denylist is derived from Table B, which (unlike Table A) is structural and
 *      stable, so it rarely needs touching. This is the layer that catches the
 *      `place_of_worship` (Table B) class directly.
 *   3. OVERLAP SNAPSHOT — every type we send IS a real Table A primary type, checked
 *      against a snapshot scoped to EXACTLY the types we use (not all ~400 of Table A).
 *      The snapshot grows only when we add a type to CATEGORY_PLACES_TYPES, in the same
 *      commit, having checked the new type against Table A. It therefore never drifts
 *      against Google adding cuisines we don't list.
 *
 * Source of truth for membership:
 *   developers.google.com/maps/documentation/places/web-service/place-types  (Table A)
 *   Snapshot verified against the list dated 2026-03-31 UTC.
 */
describe("Google Places Table A validity", () => {
  const ALL_USED_TYPES = CATEGORIES.flatMap((c) => [...CATEGORY_PLACES_TYPES[c]]);

  it("every type is lowercase snake_case (no typos of shape, casing, or whitespace)", () => {
    const shape = /^[a-z]+(_[a-z]+)*$/;
    for (const t of ALL_USED_TYPES) {
      expect(t, `"${t}" is not lowercase snake_case`).toMatch(shape);
    }
  });

  it("has no duplicate types within the whole taxonomy", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const t of ALL_USED_TYPES) {
      if (seen.has(t)) dupes.push(t);
      seen.add(t);
    }
    expect(dupes, `duplicate types: ${dupes.join(", ")}`).toEqual([]);
  });

  it("uses no Table B / geographical / generic types (request-forbidden as includedTypes)", () => {
    // Table B + address/geographical types that are RESPONSE-only. Sending any of these
    // as an includedTypes value is the lesson-5 bug (place_of_worship was the real one).
    const TABLE_B_OR_GEOGRAPHICAL = new Set<string>([
      "place_of_worship", "food", "establishment", "point_of_interest", "political",
      "geocode", "premise", "subpremise", "route", "intersection", "landmark",
      "natural_feature", "health", "finance", "general_contractor", "neighborhood",
      "colloquial_area", "plus_code", "town_square", "archipelago", "continent",
      "locality", "sublocality", "postal_code", "postal_town", "country",
      "administrative_area_level_1", "administrative_area_level_2",
      "administrative_area_level_3", "administrative_area_level_4",
      "administrative_area_level_5", "administrative_area_level_6",
      "administrative_area_level_7", "school_district",
    ]);
    const leaked = ALL_USED_TYPES.filter((t) => TABLE_B_OR_GEOGRAPHICAL.has(t));
    expect(leaked, `Table B / geographical types must not be sent: ${leaked.join(", ")}`).toEqual([]);
  });

  it("every sent type is a real Table A primary type (usage-scoped snapshot, dated 2026-03-31)", () => {
    // Snapshot of the Table A primary types Roam actually sends. Each was verified
    // against developers.google.com/.../place-types Table A on 2026-03-31. When a new
    // type is added to CATEGORY_PLACES_TYPES, add it here in the SAME commit after
    // confirming it against Table A. This set must stay a superset of ALL_USED_TYPES.
    const TABLE_A_SNAPSHOT_USED = new Set<string>([
      // Food & Drink
      "restaurant", "cafe", "bar", "bakery", "fast_food_restaurant",
      "american_restaurant", "asian_fusion_restaurant", "brazilian_restaurant",
      "chinese_restaurant", "french_restaurant", "indian_restaurant",
      "italian_restaurant", "japanese_restaurant", "mexican_restaurant",
      "middle_eastern_restaurant", "seafood_restaurant", "spanish_restaurant",
      "steak_house", "sushi_restaurant", "thai_restaurant", "vegan_restaurant",
      "vegetarian_restaurant", "bar_and_grill", "beer_garden", "pub", "wine_bar",
      "coffee_shop", "dessert_shop", "donut_shop", "ice_cream_shop", "juice_shop",
      // Shopping
      "store", "shopping_mall", "supermarket", "grocery_store", "convenience_store",
      "clothing_store", "shoe_store", "department_store", "jewelry_store",
      "electronics_store", "home_goods_store", "furniture_store", "hardware_store",
      "book_store", "florist", "gift_shop", "pet_store", "toy_store",
      "liquor_store", "pharmacy", "wholesaler",
      // Entertainment & Recreation
      "amusement_park", "aquarium", "art_gallery", "museum", "zoo",
      "movie_theater", "performing_arts_theater", "concert_hall", "opera_house",
      "casino", "night_club", "bowling_alley", "video_arcade",
      "stadium", "sports_complex", "fitness_center", "gym", "swimming_pool",
      "park", "dog_park", "botanical_garden", "national_park", "tourist_attraction",
      // Automotive & Transport
      "car_dealer", "car_rental", "car_repair", "car_wash",
      "gas_station", "electric_vehicle_charging_station",
      "parking", "parking_garage", "parking_lot",
      "airport", "bus_station", "subway_station", "train_station",
      "transit_station", "taxi_stand",
      // Finance & Business
      "bank", "atm", "accounting", "insurance_agency",
      "corporate_office", "business_center", "coworking_space",
      // Health & Wellness
      "hospital", "medical_clinic", "dentist", "doctor", "physiotherapist",
      "spa", "massage", "beauty_salon", "hair_salon", "nail_salon", "veterinary_care",
      // Lodging
      "hotel", "motel", "resort_hotel", "bed_and_breakfast", "hostel", "lodging",
      "campground", "rv_park",
      // Education & Government
      "school", "primary_school", "secondary_school", "university", "library",
      "preschool", "city_hall", "courthouse", "embassy", "local_government_office",
      "police", "post_office", "fire_station",
      // Places of Worship
      "church", "mosque", "synagogue", "hindu_temple", "buddhist_temple",
    ]);
    const notInTableA = ALL_USED_TYPES.filter((t) => !TABLE_A_SNAPSHOT_USED.has(t));
    expect(
      notInTableA,
      `types missing from the Table A snapshot (add after verifying against Table A): ${notInTableA.join(", ")}`,
    ).toEqual([]);
  });
});
