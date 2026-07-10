import { describe, it, expect } from "vitest";
import {
  CATEGORIES,
  CATEGORY_PLACES_TYPES,
  CATEGORY_PRECEDENCE,
  categoryToPlacesTypes,
  classifyPlaceTypes,
  placeToVenueRow,
  placeLocality,
  hubCategoryTier,
  weightedVenueRating,
  RATING_PRIOR_MEAN,
  placeOpeningTimes,
  placePhotos,
  placeRichFields,
  snapToIngestGrid,
  INGEST_SNAP_DEGREES,
  type CategoryId,
  type PlaceResult,
} from "./index.js";

describe("taxonomy shape", () => {
  it("has the ten agreed groups", () => {
    expect(CATEGORIES.length).toBe(10);
    expect(CATEGORIES).toContain("Food & Drink");
    expect(CATEGORIES).toContain("Stadiums");
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

  it("classifies a stadium to its own Stadiums group (moved out of Attractions)", () => {
    expect(classifyPlaceTypes(["stadium", "point_of_interest", "establishment"])).toBe("Stadiums");
    expect(classifyPlaceTypes(["arena", "establishment"])).toBe("Stadiums");
    // A leisure centre stays under Entertainment & Recreation (sports_complex did NOT move).
    expect(classifyPlaceTypes(["sports_complex", "establishment"])).toBe("Entertainment & Recreation");
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
    expect(row!.opening_times).toBeNull(); // fixture has no hours -> null round-trips
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

  it("maps the card-enrichment fields (count, price, type label, status)", () => {
    const row = placeToVenueRow(
      {
        ...darlingtonSushi,
        userRatingCount: 1240,
        priceLevel: "PRICE_LEVEL_MODERATE",
        primaryTypeDisplayName: { text: "  Sushi restaurant  " },
      },
      "Food & Drink",
    );
    expect(row!.rating_count).toBe(1240);
    expect(row!.price_level).toBe("PRICE_LEVEL_MODERATE");
    expect(row!.primary_type_label).toBe("Sushi restaurant"); // trimmed
    expect(row!.business_status).toBe("OPERATIONAL");
  });

  it("nulls an unspecified/absent price level and missing count/label", () => {
    const row = placeToVenueRow(
      { ...darlingtonSushi, priceLevel: "PRICE_LEVEL_UNSPECIFIED" },
      "Food & Drink",
    );
    expect(row!.price_level).toBeNull();
    expect(row!.rating_count).toBe(0); // NOT NULL column → 0, not null, when Places gives none
    expect(row!.primary_type_label).toBeNull();
  });

  it("drops a permanently-closed place at the source (no dead venues on the grid)", () => {
    expect(
      placeToVenueRow({ ...darlingtonSushi, businessStatus: "CLOSED_PERMANENTLY" }, "Food & Drink"),
    ).toBeNull();
  });

  it("keeps a temporarily-closed place (it reopens; the card can badge it)", () => {
    const row = placeToVenueRow(
      { ...darlingtonSushi, businessStatus: "CLOSED_TEMPORARILY" },
      "Food & Drink",
    );
    expect(row).not.toBeNull();
    expect(row!.business_status).toBe("CLOSED_TEMPORARILY");
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
      "sports_complex", "fitness_center", "gym", "swimming_pool",
      "park", "dog_park", "botanical_garden", "national_park", "tourist_attraction",
      // Stadiums
      "stadium", "arena",
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

describe("placeOpeningTimes", () => {
  it("maps Places weekdayDescriptions to our OpeningTimes shape", () => {
    const ot = placeOpeningTimes({
      id: "x",
      regularOpeningHours: {
        weekdayDescriptions: [
          "Monday: 9:00 AM – 5:00 PM",
          "Tuesday: 9:00 AM – 5:00 PM",
        ],
      },
    });
    expect(ot).not.toBeNull();
    expect(ot!.source).toBe("google_places");
    expect(ot!.weekdayDescriptions).toEqual([
      "Monday: 9:00 AM – 5:00 PM",
      "Tuesday: 9:00 AM – 5:00 PM",
    ]);
  });

  it("returns null when Places gave no hours (the common case)", () => {
    expect(placeOpeningTimes({ id: "x" })).toBeNull();
    expect(placeOpeningTimes({ id: "x", regularOpeningHours: {} })).toBeNull();
    expect(
      placeOpeningTimes({ id: "x", regularOpeningHours: { weekdayDescriptions: [] } }),
    ).toBeNull();
  });

  it("drops empty/non-string day entries defensively", () => {
    const ot = placeOpeningTimes({
      id: "x",
      regularOpeningHours: {
        weekdayDescriptions: ["Monday: 9–5", "", "Wednesday: 9–5"] as string[],
      },
    });
    expect(ot!.weekdayDescriptions).toEqual(["Monday: 9–5", "Wednesday: 9–5"]);
  });
});

describe("placeToVenueRow opening hours", () => {
  it("carries opening_times through onto the venue row when present", () => {
    const row = placeToVenueRow(
      {
        id: "ChIJ_hours",
        displayName: { text: "Open Cafe" },
        location: { latitude: 54.52, longitude: -1.55 },
        types: ["cafe"],
        regularOpeningHours: { weekdayDescriptions: ["Monday: 8:00 AM – 4:00 PM"] },
      },
      "Food & Drink",
    );
    expect(row!.opening_times).not.toBeNull();
    expect(row!.opening_times!.weekdayDescriptions).toEqual(["Monday: 8:00 AM – 4:00 PM"]);
  });
});

describe("placePhotos", () => {
  it("returns [] when Places returned no photos", () => {
    expect(placePhotos({ id: "x" })).toEqual([]);
    expect(placePhotos({ id: "x", photos: [] })).toEqual([]);
  });

  it("maps a full photo with attribution and dims", () => {
    const result = placePhotos({
      id: "x",
      photos: [
        {
          name: "places/x/photos/abc/media",
          widthPx: 4032,
          heightPx: 3024,
          authorAttributions: [{ displayName: "Jane D", uri: "https://maps.google.com/jane" }],
        },
      ],
    });
    expect(result).toEqual([
      {
        places_photo_ref: "places/x/photos/abc/media",
        attribution: [{ displayName: "Jane D", uri: "https://maps.google.com/jane" }],
        width: 4032,
        height: 3024,
      },
    ]);
  });

  it("drops a photo with no usable ref", () => {
    const result = placePhotos({
      id: "x",
      photos: [{ name: "  " }, { name: "places/x/photos/ok/media" }],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.places_photo_ref).toBe("places/x/photos/ok/media");
  });

  it("null-safe dims when Places omits widthPx/heightPx", () => {
    const result = placePhotos({
      id: "x",
      photos: [{ name: "places/x/photos/ok/media" }],
    });
    expect(result[0]!.width).toBeNull();
    expect(result[0]!.height).toBeNull();
  });

  it("drops attribution entries with an empty display name, keeps valid ones", () => {
    const result = placePhotos({
      id: "x",
      photos: [
        {
          name: "places/x/photos/ok/media",
          authorAttributions: [
            { displayName: "  ", uri: "https://x" },
            { displayName: "Real Name" },
          ],
        },
      ],
    });
    expect(result[0]!.attribution).toEqual([{ displayName: "Real Name", uri: null }]);
  });
});

describe("placeRichFields", () => {
  it("extracts contact, price range and the attribute bag", () => {
    const rich = placeRichFields({
      id: "p1",
      nationalPhoneNumber: " 028 9024 1100 ",
      websiteUri: "https://example.com/",
      priceRange: {
        startPrice: { currencyCode: "GBP", units: "10" },
        endPrice: { currencyCode: "GBP", units: "20" },
      },
      outdoorSeating: true,
      servesVegetarianFood: true,
      liveMusic: false, // false is signal ("no live music"), not absence
      paymentOptions: { acceptsCreditCards: true, acceptsNfc: true, acceptsCashOnly: false },
      accessibilityOptions: { wheelchairAccessibleEntrance: true },
    });
    expect(rich.phone).toBe("028 9024 1100");
    expect(rich.website_url).toBe("https://example.com/");
    expect(rich.price_range).toEqual({ start: 10, end: 20, currency: "GBP" });
    expect(rich.attributes).toEqual({
      outdoorSeating: true,
      servesVegetarianFood: true,
      liveMusic: false,
      paymentOptions: { acceptsCreditCards: true, acceptsNfc: true, acceptsCashOnly: false },
      accessibilityOptions: { wheelchairAccessibleEntrance: true },
    });
  });

  it("returns all-null when Places gives no signal (never writes an empty bag)", () => {
    const rich = placeRichFields({ id: "p2" });
    expect(rich).toEqual({ phone: null, website_url: null, price_range: null, attributes: null });
  });

  it("handles an open-ended price range and unparseable units", () => {
    const rich = placeRichFields({
      id: "p3",
      priceRange: { startPrice: { currencyCode: "GBP", units: "15" } },
    });
    expect(rich.price_range).toEqual({ start: 15, end: null, currency: "GBP" });
    expect(placeRichFields({ id: "p4", priceRange: { startPrice: { units: "abc" } } }).price_range).toBeNull();
  });
});

describe("snapToIngestGrid — spatial cost bound", () => {
  it("snaps to the grid step and is idempotent on an exact grid point", () => {
    const snapped = snapToIngestGrid(54.5253, -1.5849);
    // 54.5253 / 0.005 = 10905.06 -> 10905 -> 54.525 ; -1.5849 / 0.005 = -316.98 -> -317 -> -1.585
    expect(snapped.lat).toBeCloseTo(54.525, 6);
    expect(snapped.lng).toBeCloseTo(-1.585, 6);
    const again = snapToIngestGrid(snapped.lat, snapped.lng);
    expect(again.lat).toBeCloseTo(snapped.lat, 9);
    expect(again.lng).toBeCloseTo(snapped.lng, 9);
  });

  it("collapses two jittered points in the same cell to one key (the dedup win)", () => {
    // Two points a few metres apart (well under the ~555 m cell) must snap identically,
    // so the second request hits the freshness cache instead of paying for a fetch.
    const a = snapToIngestGrid(54.52531, -1.58489);
    const b = snapToIngestGrid(54.52539, -1.58492);
    expect(a).toEqual(b);
  });

  it("keeps points in different cells distinct", () => {
    const a = snapToIngestGrid(54.5253, -1.5849);
    const b = snapToIngestGrid(54.5253 + INGEST_SNAP_DEGREES * 2, -1.5849);
    expect(a.lat).not.toBeCloseTo(b.lat, 6);
  });
});

describe("placeLocality", () => {
  const base: PlaceResult = {
    id: "ChIJ_test",
    displayName: { text: "Test" },
    location: { latitude: 54.6, longitude: -5.93 },
    types: ["restaurant"],
  };

  it("prefers the UK postal_town over locality", () => {
    const loc = placeLocality({
      ...base,
      addressComponents: [
        { longText: "Cathedral Quarter", types: ["locality", "political"] },
        { longText: "Belfast", types: ["postal_town"] },
      ],
    });
    expect(loc).toBe("Belfast");
  });

  it("falls back to locality when there is no postal_town", () => {
    const loc = placeLocality({
      ...base,
      addressComponents: [{ longText: "Darlington", types: ["locality", "political"] }],
    });
    expect(loc).toBe("Darlington");
  });

  it("uses shortText when longText is missing, and null when neither town type exists", () => {
    expect(
      placeLocality({ ...base, addressComponents: [{ shortText: "Harlech", types: ["postal_town"] }] }),
    ).toBe("Harlech");
    expect(
      placeLocality({ ...base, addressComponents: [{ longText: "GB", types: ["country"] }] }),
    ).toBeNull();
    expect(placeLocality(base)).toBeNull();
  });

  it("rides placeToVenueRow into the venue insert row", () => {
    const row = placeToVenueRow(
      {
        ...base,
        addressComponents: [{ longText: "Belfast", types: ["postal_town"] }],
      },
      "Food & Drink",
    );
    expect(row!.locality).toBe("Belfast");
    const bare = placeToVenueRow(base, "Food & Drink");
    expect(bare!.locality).toBeNull();
  });
});

describe("hub venue ranking helpers", () => {
  it("tiers consumer categories as 1 and everything else (incl. null) as 2", () => {
    expect(hubCategoryTier("Food & Drink")).toBe(1);
    expect(hubCategoryTier("Shopping")).toBe(1);
    expect(hubCategoryTier("Entertainment & Recreation")).toBe(1);
    expect(hubCategoryTier("Lodging")).toBe(1);
    expect(hubCategoryTier("Places of Worship")).toBe(2);
    expect(hubCategoryTier("Finance & Business")).toBe(2);
    expect(hubCategoryTier(null)).toBe(2);
    expect(hubCategoryTier("not-a-category")).toBe(2);
  });

  it("weights ratings by review volume: a 4.8×400 beats a 5.0×3", () => {
    const pub = weightedVenueRating(4.8, 400);
    const threeReviewPerfect = weightedVenueRating(5.0, 3);
    expect(pub).toBeGreaterThan(threeReviewPerfect);
  });

  it("scores unrated venues at the prior mean (neutral, not punished)", () => {
    expect(weightedVenueRating(null, 0)).toBe(RATING_PRIOR_MEAN);
    expect(weightedVenueRating(4.9, 0)).toBe(RATING_PRIOR_MEAN);
  });

  it("converges to the true rating as reviews accumulate", () => {
    const few = weightedVenueRating(5.0, 5);
    const many = weightedVenueRating(5.0, 5000);
    expect(many).toBeGreaterThan(few);
    expect(many).toBeCloseTo(5.0, 1);
  });
});
