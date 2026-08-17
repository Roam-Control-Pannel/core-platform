import { describe, it, expect } from "vitest";
import {
  sanitizeCollectionPatch,
  rowToCollectionSettings,
  computeListingStatus,
  isFoodToGo,
  isVenueInFoodToGoRegion,
  DEFAULT_COLLECTION_SETTINGS,
  PREP_TIME_MAX,
  COLLECTION_INSTRUCTIONS_MAX,
  type ListingChecklist,
  // Delivery (Phase 7)
  sanitizeDeliveryPatch,
  checkDeliverable,
  computeOrderTotals,
  normalizePostcode,
  postcodeOutward,
  postcodeMatches,
  DEFAULT_DELIVERY_SETTINGS,
  DELIVERY_FEE_MAX_PENCE,
  DELIVERY_RADIUS_MAX_M,
  DELIVERY_ETA_MAX,
  type DeliverySettings,
} from "./index.js";

/** Minimal client stub for venues.select("lat, lng").eq("id", …).maybeSingle(). */
function venueClient(row: { lat: number | null; lng: number | null } | null, errorMessage?: string) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: row,
            error: errorMessage ? { message: errorMessage } : null,
          }),
        }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

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

describe("isVenueInFoodToGoRegion", () => {
  it("accepts venues inside Northern Ireland", async () => {
    // Belfast, Derry, Enniskillen — all inside NI_BOUNDS.
    expect(await isVenueInFoodToGoRegion(venueClient({ lat: 54.5973, lng: -5.9301 }), "v")).toBe(true);
    expect(await isVenueInFoodToGoRegion(venueClient({ lat: 54.9966, lng: -7.3086 }), "v")).toBe(true);
    expect(await isVenueInFoodToGoRegion(venueClient({ lat: 54.3446, lng: -7.6316 }), "v")).toBe(true);
  });

  it("rejects venues outside Northern Ireland", async () => {
    // Darlington (the reported case), London, Dublin — all outside the box.
    expect(await isVenueInFoodToGoRegion(venueClient({ lat: 54.5235, lng: -1.5597 }), "v")).toBe(false);
    expect(await isVenueInFoodToGoRegion(venueClient({ lat: 51.5074, lng: -0.1278 }), "v")).toBe(false);
    expect(await isVenueInFoodToGoRegion(venueClient({ lat: 53.3498, lng: -6.2603 }), "v")).toBe(false);
  });

  it("treats a venue with no coordinates as out of region", async () => {
    expect(await isVenueInFoodToGoRegion(venueClient({ lat: null, lng: null }), "v")).toBe(false);
    expect(await isVenueInFoodToGoRegion(venueClient(null), "v")).toBe(false);
  });

  it("surfaces a read error rather than silently passing", async () => {
    await expect(isVenueInFoodToGoRegion(venueClient(null, "boom"), "v")).rejects.toThrow(/region read failed/);
  });
});

// ── Delivery (Phase 7) ────────────────────────────────────────────────────────────────────────

describe("postcode helpers", () => {
  it("normalises to upper-case, whitespace-free tokens", () => {
    expect(normalizePostcode("  bt1 4ab ")).toBe("BT14AB");
    expect(normalizePostcode("bt47")).toBe("BT47");
    expect(normalizePostcode(null)).toBe("");
  });

  it("extracts the outward (district) code", () => {
    expect(postcodeOutward("BT14AB")).toBe("BT1");
    expect(postcodeOutward("BT475CD")).toBe("BT47");
    expect(postcodeOutward("BT1")).toBe("BT1"); // a partial the user typed
  });

  it("matches districts exactly and areas by prefix", () => {
    // District token "BT1" matches BT1 but NOT BT14 (the classic false-positive to avoid).
    expect(postcodeMatches("BT1", "BT1")).toBe(true);
    expect(postcodeMatches("BT1", "BT14")).toBe(false);
    expect(postcodeMatches("BT14", "BT14")).toBe(true);
    // Area token "BT" (alpha only) matches every BT district.
    expect(postcodeMatches("BT", "BT1")).toBe(true);
    expect(postcodeMatches("BT", "BT47")).toBe(true);
    // A full postcode token is reduced to its outward code before comparison.
    expect(postcodeMatches("BT1 4AB", "BT1")).toBe(true);
  });
});

describe("sanitizeDeliveryPatch", () => {
  it("returns only the keys the caller set, snake-cased", () => {
    expect(sanitizeDeliveryPatch({ deliveryEnabled: true })).toEqual({ delivery_enabled: true });
    expect(sanitizeDeliveryPatch({})).toEqual({});
  });
  it("clamps money into [0, max] and throws on non-integers", () => {
    expect(sanitizeDeliveryPatch({ deliveryFeePence: -100 })).toEqual({ delivery_fee_pence: 0 });
    expect(sanitizeDeliveryPatch({ deliveryFeePence: 9_999_999 })).toEqual({ delivery_fee_pence: DELIVERY_FEE_MAX_PENCE });
    expect(sanitizeDeliveryPatch({ minOrderPence: 1500 })).toEqual({ min_order_pence: 1500 });
    expect(() => sanitizeDeliveryPatch({ deliveryFeePence: 2.5 })).toThrow(/integer/);
  });
  it("handles radius: null passes through, numbers clamp, fractions throw", () => {
    expect(sanitizeDeliveryPatch({ radiusM: null })).toEqual({ radius_m: null });
    expect(sanitizeDeliveryPatch({ radiusM: 999_999 })).toEqual({ radius_m: DELIVERY_RADIUS_MAX_M });
    expect(sanitizeDeliveryPatch({ radiusM: 5000 })).toEqual({ radius_m: 5000 });
    expect(() => sanitizeDeliveryPatch({ radiusM: 12.5 })).toThrow(/integer/);
  });
  it("clamps eta and trims notes (empty → null)", () => {
    expect(sanitizeDeliveryPatch({ etaMins: 9999 })).toEqual({ eta_mins: DELIVERY_ETA_MAX });
    expect(sanitizeDeliveryPatch({ deliveryNotes: "  Fri–Sun eves  " })).toEqual({ delivery_notes: "Fri–Sun eves" });
    expect(sanitizeDeliveryPatch({ deliveryNotes: "   " })).toEqual({ delivery_notes: null });
  });
  it("normalises, de-dupes and caps postcode lists", () => {
    expect(sanitizeDeliveryPatch({ postcodeAllow: [" bt1 ", "BT1", "bt2", ""] })).toEqual({
      postcode_allow: ["BT1", "BT2"],
    });
  });
});

describe("checkDeliverable", () => {
  const base: DeliverySettings = {
    ...DEFAULT_DELIVERY_SETTINGS,
    deliveryEnabled: true,
    radiusM: 5000,
  };
  const belfast = { lat: 54.5973, lng: -5.9301 }; // venue centre
  const nearBelfast = { lat: 54.61, lng: -5.93 }; // ~1.4 km north, inside NI + radius
  const farNI = { lat: 54.9966, lng: -7.3086 }; // Derry — in NI but way outside a 5 km radius
  const london = { lat: 51.5074, lng: -0.1278 }; // outside NI

  it("refuses when delivery is off or paused", () => {
    expect(checkDeliverable({ settings: { ...base, deliveryEnabled: false }, venue: belfast, destLat: nearBelfast.lat, destLng: nearBelfast.lng, destPostcode: "BT1 4AB" }).reason).toBe("delivery_unavailable");
    expect(checkDeliverable({ settings: { ...base, paused: true }, venue: belfast, destLat: nearBelfast.lat, destLng: nearBelfast.lng, destPostcode: "BT1 4AB" }).reason).toBe("delivery_unavailable");
  });
  it("delivers within the radius", () => {
    const r = checkDeliverable({ settings: base, venue: belfast, destLat: nearBelfast.lat, destLng: nearBelfast.lng, destPostcode: "BT1 4AB" });
    expect(r.deliverable).toBe(true);
    expect(r.reason).toBe("ok");
    expect(r.distanceM).toBeGreaterThan(0);
  });
  it("refuses outside the radius when not allow-listed", () => {
    const r = checkDeliverable({ settings: base, venue: belfast, destLat: farNI.lat, destLng: farNI.lng, destPostcode: "BT48 6AA" });
    expect(r.deliverable).toBe(false);
    expect(r.reason).toBe("outside_area");
  });
  it("allow-list overrides the radius", () => {
    const r = checkDeliverable({ settings: { ...base, postcodeAllow: ["BT48"] }, venue: belfast, destLat: farNI.lat, destLng: farNI.lng, destPostcode: "BT48 6AA" });
    expect(r.deliverable).toBe(true);
    expect(r.reason).toBe("ok");
  });
  it("block-list wins even inside the radius", () => {
    const r = checkDeliverable({ settings: { ...base, postcodeBlock: ["BT1"] }, venue: belfast, destLat: nearBelfast.lat, destLng: nearBelfast.lng, destPostcode: "BT1 4AB" });
    expect(r.deliverable).toBe(false);
    expect(r.reason).toBe("postcode_blocked");
  });
  it("refuses destinations outside Northern Ireland", () => {
    const r = checkDeliverable({ settings: { ...base, radiusM: 2_000_000 }, venue: belfast, destLat: london.lat, destLng: london.lng, destPostcode: "EC1A 1BB" });
    expect(r.deliverable).toBe(false);
    expect(r.reason).toBe("outside_ni");
  });
  it("requires destination coordinates", () => {
    const r = checkDeliverable({ settings: base, venue: belfast, destLat: null, destLng: null, destPostcode: "BT1 4AB" });
    expect(r.reason).toBe("no_destination");
  });
  it("with no radius and no allow-match, is out of area (postcode-only mode)", () => {
    const r = checkDeliverable({ settings: { ...base, radiusM: null }, venue: belfast, destLat: nearBelfast.lat, destLng: nearBelfast.lng, destPostcode: "BT1 4AB" });
    expect(r.reason).toBe("outside_area");
  });
});

describe("computeOrderTotals", () => {
  it("sums the basket and takes commission on goods only (vendor keeps delivery fee)", () => {
    const t = computeOrderTotals([{ unitPricePence: 500, quantity: 2 }, { unitPricePence: 350, quantity: 1 }], 250, 500);
    expect(t.goodsSubtotalPence).toBe(1350); // 1000 + 350
    expect(t.deliveryFeePence).toBe(250);
    expect(t.applicationFeePence).toBe(68); // 5% of 1350 = 67.5 → 68, NOT of 1600
    expect(t.totalPence).toBe(1600); // goods + delivery
  });
  it("handles a zero delivery fee (collection / free delivery)", () => {
    const t = computeOrderTotals([{ unitPricePence: 800, quantity: 1 }], 0, 500);
    expect(t.deliveryFeePence).toBe(0);
    expect(t.applicationFeePence).toBe(40);
    expect(t.totalPence).toBe(800);
  });
  it("floors negative/fractional inputs", () => {
    const t = computeOrderTotals([{ unitPricePence: 199.9, quantity: 3 }], -50, 500);
    expect(t.goodsSubtotalPence).toBe(600); // round(199.9)=200 × 3
    expect(t.deliveryFeePence).toBe(0);
    expect(t.totalPence).toBe(600);
  });
});
