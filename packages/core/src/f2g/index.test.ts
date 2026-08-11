import { describe, it, expect } from "vitest";
import {
  sanitizeCollectionPatch,
  rowToCollectionSettings,
  computeListingStatus,
  isFoodToGo,
  DEFAULT_COLLECTION_SETTINGS,
  PREP_TIME_MAX,
  COLLECTION_INSTRUCTIONS_MAX,
  type ListingChecklist,
} from "./index.js";

describe("isFoodToGo", () => {
  it("accepts grab-and-go leaves (café, coffee, bakery, takeaway, fast food)", () => {
    expect(isFoodToGo(["coffee_shop", "cafe"])).toBe(true);
    expect(isFoodToGo(["bakery"])).toBe(true);
    expect(isFoodToGo(["fast_food_restaurant"])).toBe(true);
    expect(isFoodToGo(["meal_takeaway"])).toBe(true);
    expect(isFoodToGo(["sandwich_shop", "restaurant"])).toBe(true); // any qualifying leaf wins
  });

  it("rejects pubs, bars and sit-down restaurants", () => {
    expect(isFoodToGo(["pub"])).toBe(false);
    expect(isFoodToGo(["bar", "restaurant"])).toBe(false);
    expect(isFoodToGo(["italian_restaurant"])).toBe(false);
    expect(isFoodToGo(["wine_bar"])).toBe(false);
  });

  it("is tolerant of case, whitespace, and empty/absent leaves", () => {
    expect(isFoodToGo([" Coffee_Shop "])).toBe(true);
    expect(isFoodToGo([])).toBe(false);
    expect(isFoodToGo(null)).toBe(false);
    expect(isFoodToGo(undefined)).toBe(false);
  });
});

describe("sanitizeCollectionPatch", () => {
  it("returns only the keys the caller set, snake-cased", () => {
    expect(sanitizeCollectionPatch({ orderAhead: true })).toEqual({ order_ahead: true });
    expect(sanitizeCollectionPatch({})).toEqual({});
  });
  it("clamps prep time into [0, 240]", () => {
    expect(sanitizeCollectionPatch({ prepTimeMins: -5 })).toEqual({ prep_time_mins: 0 });
    expect(sanitizeCollectionPatch({ prepTimeMins: 9999 })).toEqual({ prep_time_mins: PREP_TIME_MAX });
    expect(sanitizeCollectionPatch({ prepTimeMins: 20 })).toEqual({ prep_time_mins: 20 });
  });
  it("throws on a non-integer prep time", () => {
    expect(() => sanitizeCollectionPatch({ prepTimeMins: 12.5 })).toThrow(/integer/);
  });
  it("trims instructions, caps length, and maps empty to null", () => {
    expect(sanitizeCollectionPatch({ collectionInstructions: "  by the till  " })).toEqual({
      collection_instructions: "by the till",
    });
    expect(sanitizeCollectionPatch({ collectionInstructions: "   " })).toEqual({
      collection_instructions: null,
    });
    const long = "x".repeat(600);
    const out = sanitizeCollectionPatch({ collectionInstructions: long }) as {
      collection_instructions: string;
    };
    expect(out.collection_instructions.length).toBe(COLLECTION_INSTRUCTIONS_MAX);
  });
  it("coerces booleans", () => {
    // @ts-expect-error deliberately passing a truthy non-boolean to prove coercion
    expect(sanitizeCollectionPatch({ paused: 1 })).toEqual({ paused: true });
  });
});

describe("rowToCollectionSettings", () => {
  it("maps a row and defaults a missing prep time", () => {
    expect(
      rowToCollectionSettings({
        order_ahead: true,
        paused: false,
        prep_time_mins: 30,
        collection_instructions: "side door",
      }),
    ).toEqual({ orderAhead: true, paused: false, prepTimeMins: 30, collectionInstructions: "side door" });
    expect(rowToCollectionSettings({ order_ahead: false, paused: true }).prepTimeMins).toBe(
      DEFAULT_COLLECTION_SETTINGS.prepTimeMins,
    );
  });
});

describe("computeListingStatus", () => {
  const allTrue: ListingChecklist = {
    claimed: true,
    tagged: true,
    hasActiveProduct: true,
    paymentsEnabled: true,
    collectionConfigured: true,
  };

  it("is ready only when every gate passes", () => {
    const s = computeListingStatus(allTrue);
    expect(s.ready).toBe(true);
    expect(s.missing).toEqual([]);
  });

  it("lists missing gates in fixed order", () => {
    const s = computeListingStatus({
      ...allTrue,
      tagged: false,
      paymentsEnabled: false,
    });
    expect(s.ready).toBe(false);
    expect(s.missing).toEqual(["tagged", "paymentsEnabled"]);
  });

  it("reports all gates missing for a fresh venue", () => {
    const s = computeListingStatus({
      claimed: false,
      tagged: false,
      hasActiveProduct: false,
      paymentsEnabled: false,
      collectionConfigured: false,
    });
    expect(s.ready).toBe(false);
    expect(s.missing).toHaveLength(5);
    expect(s.missing[0]).toBe("claimed");
  });
});
