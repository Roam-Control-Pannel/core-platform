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
