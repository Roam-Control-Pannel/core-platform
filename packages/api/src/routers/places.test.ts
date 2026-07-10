import { describe, it, expect } from "vitest";
import { ingestCategoryCore, ingestTextSearchCore, enrichVenueCore, type LooseRpc, type SearchNearbyFn, type SearchTextFn, type GetDetailsFn } from "./places.js";
import { places as corePlaces } from "@roam/core";

/**
 * Unit tests for the PURE orchestration ingestCategoryCore: the freshness skip, the
 * classify/drop filtering, and the exact payload handed to upsert_place_venues. Both
 * collaborators are plain function args — a fake rpc with scripted results, and a fake
 * searchNearby returning canned PlaceResults. No tRPC, no middleware, no network, no
 * key — runs in CI. The DB functions themselves are proven live (psql); the real
 * end-to-end fetch is the slice's final live gate.
 */

const API_KEY = "test-places-key";

/** A fake rpc() returning scripted results per function name and recording calls. */
function fakeRpc(
  results: Record<string, { data: unknown; error: { message: string } | null }>,
) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: LooseRpc = async (fn, args) => {
    calls.push({ fn, args });
    // Default: the quota checks ALLOW, so tests not about cost control are unaffected.
    // The dedicated cost-control tests pass their own claim_places_*_quota result.
    if ((fn === "claim_places_fetch_quota" || fn === "claim_places_detail_quota") && !(fn in results)) {
      return { data: [{ allowed: true, reason: "allowed" }], error: null };
    }
    return results[fn] ?? { data: null, error: null };
  };
  return { rpc, calls };
}

const cafePlace: corePlaces.PlaceResult = {
  id: "ChIJ_cafe",
  displayName: { text: "Proof Cafe" },
  location: { latitude: 54.5253, longitude: -1.5849 },
  types: ["cafe", "food", "point_of_interest"],
  formattedAddress: "1 High Row, Darlington",
  rating: 4.4,
};

const cafeWithPhotos: corePlaces.PlaceResult = {
  ...{
    id: "ChIJ_cafe",
    displayName: { text: "Proof Cafe" },
    location: { latitude: 54.5253, longitude: -1.5849 },
    types: ["cafe", "food", "point_of_interest"],
  },
  photos: [
    {
      name: "places/ChIJ_cafe/photos/p1/media",
      widthPx: 4032,
      heightPx: 3024,
      authorAttributions: [{ displayName: "A Photographer", uri: "https://maps.google.com/a" }],
    },
    { name: "places/ChIJ_cafe/photos/p2/media", widthPx: 1024, heightPx: 768 },
  ],
};

const carPlace: corePlaces.PlaceResult = {
  // Tangential result Places sometimes returns — classifies to Automotive, so an
  // ingest for "Food & Drink" must DROP it.
  id: "ChIJ_garage",
  displayName: { text: "Joe's Garage" },
  location: { latitude: 54.52, longitude: -1.58 },
  types: ["car_repair", "point_of_interest"],
};

const baseArgs = {
  lat: 54.5253,
  lng: -1.5849,
  category: "Food & Drink" as corePlaces.CategoryId,
  radiusMetres: 1500,
  clientKey: "203.0.113.9",
};

describe("ingestCategoryCore — freshness skip", () => {
  it("skips the paid fetch when fresh coverage exists", async () => {
    const { rpc, calls } = fakeRpc({
      count_fresh_places_venues: { data: 3, error: null },
    });
    let fetched = false;
    const searchNearby: SearchNearbyFn = async () => {
      fetched = true;
      return [];
    };

    const out = await ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs);

    expect(fetched).toBe(false); // the cost control: no Places call
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe("fresh-coverage");
    expect(out.freshCount).toBe(3);
    expect(calls.some((c) => c.fn === "upsert_place_venues")).toBe(false);
  });
});

describe("ingestCategoryCore — fetch, filter, upsert", () => {
  it("fetches when stale, drops category-mismatches, upserts the matching rows", async () => {
    const { rpc, calls } = fakeRpc({
      count_fresh_places_venues: { data: 0, error: null },
      upsert_place_venues: {
        data: [{ out_id: "id-1", out_source_ref: "ChIJ_cafe", out_was_claimed: false }],
        error: null,
      },
    });
    const searchNearby: SearchNearbyFn = async () => [cafePlace, carPlace];

    const out = await ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs);

    // The upsert payload must contain ONLY the cafe (garage classified to Automotive).
    const upsertCall = calls.find((c) => c.fn === "upsert_place_venues");
    expect(upsertCall).toBeDefined();
    const payload = upsertCall!.args.places as { source_ref: string; category: string }[];
    expect(payload.length).toBe(1);
    expect(payload[0]!.source_ref).toBe("ChIJ_cafe");
    expect(payload[0]!.category).toBe("Food & Drink");

    expect(out.skipped).toBe(false);
    expect(out.reason).toBe("ingested");
    expect(out.fetched).toBe(2);
    expect(out.inserted).toBe(1);
    expect(out.claimedSkipped).toBe(0);
    // cafePlace carries no photos -> empty photo set -> no photo RPC for it.
    expect(out.photosUpserted).toBe(0);
  });

  it("reports claimedSkipped when the upsert leaves a claimed venue untouched", async () => {
    const { rpc } = fakeRpc({
      count_fresh_places_venues: { data: 0, error: null },
      upsert_place_venues: {
        data: [{ out_id: "id-1", out_source_ref: "ChIJ_cafe", out_was_claimed: true }],
        error: null,
      },
    });
    const searchNearby: SearchNearbyFn = async () => [cafePlace];

    const out = await ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs);

    expect(out.claimedSkipped).toBe(1);
    expect(out.inserted).toBe(0);
  });

  it("returns no-matching-places (no upsert) when nothing classifies to the category", async () => {
    const { rpc, calls } = fakeRpc({
      count_fresh_places_venues: { data: 0, error: null },
    });
    const searchNearby: SearchNearbyFn = async () => [carPlace]; // wrong group only

    const out = await ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs);

    expect(out.reason).toBe("no-matching-places");
    expect(out.fetched).toBe(1);
    expect(out.inserted).toBe(0);
    expect(calls.some((c) => c.fn === "upsert_place_venues")).toBe(false);
  });

  it("throws when the freshness rpc errors (procedure maps to a 500)", async () => {
    const rpc: LooseRpc = async () => ({ data: null, error: { message: "boom" } });
    const searchNearby: SearchNearbyFn = async () => [];
    await expect(
      ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs),
    ).rejects.toThrow(/Freshness check failed/);
  });
});


describe("ingestCategoryCore — google_places photos", () => {
  it("writes positioned photos for an unclaimed venue via upsert_venue_photos", async () => {
    const { rpc, calls } = fakeRpc({
      count_fresh_places_venues: { data: 0, error: null },
      upsert_place_venues: {
        data: [{ out_id: "venue-1", out_source_ref: "ChIJ_cafe", out_was_claimed: false }],
        error: null,
      },
      upsert_venue_photos: { data: 2, error: null },
    });
    const searchNearby: SearchNearbyFn = async () => [cafeWithPhotos];

    const out = await ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs);

    const photoCall = calls.find((c) => c.fn === "upsert_venue_photos");
    expect(photoCall).toBeDefined();
    const payload = photoCall!.args.payload as {
      venue_id: string;
      photos: { places_photo_ref: string; position: number }[];
    }[];
    expect(payload.length).toBe(1);
    expect(payload[0]!.venue_id).toBe("venue-1");
    expect(payload[0]!.photos.length).toBe(2);
    // Position stamps Places' array order.
    expect(payload[0]!.photos[0]!.position).toBe(0);
    expect(payload[0]!.photos[1]!.position).toBe(1);
    expect(payload[0]!.photos[0]!.places_photo_ref).toBe("places/ChIJ_cafe/photos/p1/media");
    expect(out.photosUpserted).toBe(2);
  });

  it("excludes a CLAIMED venue's photos from the payload (frozen, parity with hours)", async () => {
    const { rpc, calls } = fakeRpc({
      count_fresh_places_venues: { data: 0, error: null },
      upsert_place_venues: {
        data: [{ out_id: "venue-1", out_source_ref: "ChIJ_cafe", out_was_claimed: true }],
        error: null,
      },
      upsert_venue_photos: { data: 0, error: null },
    });
    const searchNearby: SearchNearbyFn = async () => [cafeWithPhotos];

    const out = await ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs);

    // Claimed -> excluded from photo payload -> no photo RPC at all (payload empty).
    expect(calls.some((c) => c.fn === "upsert_venue_photos")).toBe(false);
    expect(out.photosUpserted).toBe(0);
    expect(out.claimedSkipped).toBe(1);
  });

  it("propagates a photo upsert error as a thrown Error", async () => {
    const { rpc } = fakeRpc({
      count_fresh_places_venues: { data: 0, error: null },
      upsert_place_venues: {
        data: [{ out_id: "venue-1", out_source_ref: "ChIJ_cafe", out_was_claimed: false }],
        error: null,
      },
      upsert_venue_photos: { data: null, error: { message: "photo boom" } },
    });
    const searchNearby: SearchNearbyFn = async () => [cafeWithPhotos];
    await expect(
      ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs),
    ).rejects.toThrow(/Photo upsert failed/);
  });
});

describe("ingestCategoryCore — cost control (budget + per-client limit + snapping)", () => {
  it("snaps the query point before the freshness check AND the fetch", async () => {
    const { rpc, calls } = fakeRpc({
      count_fresh_places_venues: { data: 0, error: null },
    });
    let center: { lat: number; lng: number } | null = null;
    const searchNearby: SearchNearbyFn = async (params) => {
      center = { lat: params.lat, lng: params.lng };
      return [];
    };

    await ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs);

    // 54.5253 -> 54.525, -1.5849 -> -1.585 on the 0.005° grid; both the freshness RPC and
    // the searchNearby centre must use the SNAPPED point (so they share one cache key).
    const fresh = calls.find((c) => c.fn === "count_fresh_places_venues");
    expect(fresh!.args.lat).toBeCloseTo(54.525, 6);
    expect(fresh!.args.lng).toBeCloseTo(-1.585, 6);
    expect(center!.lat).toBeCloseTo(54.525, 6);
    expect(center!.lng).toBeCloseTo(-1.585, 6);
  });

  it("forwards the policy caps + client key to claim_places_fetch_quota", async () => {
    const { rpc, calls } = fakeRpc({
      count_fresh_places_venues: { data: 0, error: null },
    });
    const searchNearby: SearchNearbyFn = async () => [];

    await ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs);

    const quota = calls.find((c) => c.fn === "claim_places_fetch_quota");
    expect(quota).toBeDefined();
    expect(quota!.args.p_client_key).toBe("203.0.113.9");
    expect(quota!.args.p_daily_cap).toBe(corePlaces.PLACES_DAILY_FETCH_BUDGET);
    expect(quota!.args.p_client_cap).toBe(corePlaces.PLACES_CLIENT_FETCH_LIMIT);
    expect(quota!.args.p_client_window_secs).toBe(corePlaces.PLACES_CLIENT_WINDOW_SECS);
  });

  it("skips the paid fetch when the global daily budget is exhausted", async () => {
    const { rpc, calls } = fakeRpc({
      count_fresh_places_venues: { data: 0, error: null },
      claim_places_fetch_quota: { data: [{ allowed: false, reason: "daily-budget" }], error: null },
    });
    let fetched = false;
    const searchNearby: SearchNearbyFn = async () => {
      fetched = true;
      return [];
    };

    const out = await ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs);

    expect(fetched).toBe(false); // the wallet backstop: no Places call
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe("budget-exhausted");
    expect(calls.some((c) => c.fn === "upsert_place_venues")).toBe(false);
  });

  it("skips the paid fetch when the per-client window limit is hit (rate-limited)", async () => {
    const { rpc } = fakeRpc({
      count_fresh_places_venues: { data: 0, error: null },
      claim_places_fetch_quota: { data: [{ allowed: false, reason: "client-rate" }], error: null },
    });
    let fetched = false;
    const searchNearby: SearchNearbyFn = async () => {
      fetched = true;
      return [];
    };

    const out = await ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs);

    expect(fetched).toBe(false);
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe("rate-limited");
  });

  it("does NOT consume quota when fresh coverage already exists (cheap path)", async () => {
    const { rpc, calls } = fakeRpc({
      count_fresh_places_venues: { data: 5, error: null },
    });
    const searchNearby: SearchNearbyFn = async () => [];

    const out = await ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs);

    expect(out.reason).toBe("fresh-coverage");
    // A freshness HIT must never touch the budget — only imminent paid calls claim quota.
    expect(calls.some((c) => c.fn === "claim_places_fetch_quota")).toBe(false);
  });

  it("throws when the quota rpc errors (procedure maps to a 500)", async () => {
    const { rpc } = fakeRpc({
      count_fresh_places_venues: { data: 0, error: null },
      claim_places_fetch_quota: { data: null, error: { message: "quota boom" } },
    });
    const searchNearby: SearchNearbyFn = async () => [];
    await expect(
      ingestCategoryCore(rpc, searchNearby, API_KEY, baseArgs),
    ).rejects.toThrow(/Fetch-quota check failed/);
  });
});

/* ── text search fall-through (ingestTextSearchCore) ──────────────────────────────────────── */

const hotelPlace: corePlaces.PlaceResult = {
  id: "ChIJ_hotel",
  displayName: { text: "Atlantic Tower Hotel Liverpool" },
  location: { latitude: 53.4084, longitude: -2.9916 },
  types: ["lodging", "point_of_interest"],
  formattedAddress: "Chapel St, Liverpool L3 9AG",
  rating: 4.1,
};

const textArgs = { query: "Atlantic Tower Hotel", lat: 53.4084, lng: -2.9916, clientKey: "203.0.113.9" };

describe("ingestTextSearchCore", () => {
  it("claims budget, fetches by text, classifies + upserts the venue", async () => {
    const { rpc, calls } = fakeRpc({
      upsert_place_venues: { data: [{ out_id: "v-hotel", out_source_ref: "ChIJ_hotel", out_was_claimed: false }], error: null },
    });
    const searchText: SearchTextFn = async () => [hotelPlace];
    const out = await ingestTextSearchCore(rpc, searchText, API_KEY, textArgs);

    expect(out.reason).toBe("ingested");
    expect(out.ingested).toBe(1);
    // The paid call was guarded by a budget claim.
    expect(calls.some((c) => c.fn === "claim_places_fetch_quota")).toBe(true);
    const upsert = calls.find((c) => c.fn === "upsert_place_venues");
    expect((upsert!.args.places as unknown[]).length).toBe(1);
  });

  it("does not fetch or upsert when the budget is exhausted", async () => {
    const { rpc, calls } = fakeRpc({
      claim_places_fetch_quota: { data: [{ allowed: false, reason: "budget" }], error: null },
    });
    let fetched = false;
    const searchText: SearchTextFn = async () => { fetched = true; return [hotelPlace]; };
    const out = await ingestTextSearchCore(rpc, searchText, API_KEY, textArgs);

    expect(fetched).toBe(false);
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe("budget-exhausted");
    expect(calls.some((c) => c.fn === "upsert_place_venues")).toBe(false);
  });

  it("returns no-matching-places when the text results classify to nothing", async () => {
    const { rpc } = fakeRpc({});
    const searchText: SearchTextFn = async () => [{ id: "x", displayName: { text: "?" }, types: ["route"] }];
    const out = await ingestTextSearchCore(rpc, searchText, API_KEY, textArgs);
    expect(out.reason).toBe("no-matching-places");
    expect(out.ingested).toBe(0);
  });
});

/* ── on-demand enrichment (enrichVenueCore) ──────────────────────────────────────────────── */

/** A fake Place Details fetcher: records the place ids asked for, returns a canned result. */
function fakeGetDetails(place: corePlaces.PlaceResult) {
  const calls: string[] = [];
  const fn: GetDetailsFn = async (placeId) => {
    calls.push(placeId);
    return place;
  };
  return { fn, calls };
}

const richDetailsPlace: corePlaces.PlaceResult = {
  id: "ChIJ_hotel",
  displayName: { text: "Atlantic Tower Hotel" },
  nationalPhoneNumber: " 0151 227 4444 ",
  websiteUri: "https://atlantictower.example/",
  priceRange: {
    startPrice: { currencyCode: "GBP", units: "80" },
    endPrice: { currencyCode: "GBP", units: "150" },
  },
  outdoorSeating: true,
  goodForChildren: true,
  paymentOptions: { acceptsCreditCards: true },
};

const barePlace: corePlaces.PlaceResult = { id: "ChIJ_bare", displayName: { text: "No Facts" } };

const enrichArgs = {
  venueId: "11111111-1111-1111-1111-111111111111",
  placeId: "ChIJ_hotel",
  clientKey: "203.0.113.9",
};

describe("enrichVenueCore — on-demand venue enrichment", () => {
  it("claims the detail budget, fetches Place Details, and writes the rich facts", async () => {
    const { rpc, calls } = fakeRpc({ apply_venue_details: { data: null, error: null } });
    const { fn: getDetails, calls: detailCalls } = fakeGetDetails(richDetailsPlace);

    const out = await enrichVenueCore(rpc, getDetails, API_KEY, enrichArgs);

    expect(out.enriched).toBe(true);
    expect(out.reason).toBe("enriched");
    // Exactly one paid Details call, for the venue's place id.
    expect(detailCalls).toEqual(["ChIJ_hotel"]);
    // The budget claimed is the SEPARATE detail budget, not the searchNearby one.
    const quota = calls.find((c) => c.fn === "claim_places_detail_quota");
    expect(quota).toBeTruthy();
    expect(quota!.args.p_daily_cap).toBe(corePlaces.PLACES_DETAILS_DAILY_BUDGET);
    expect(quota!.args.p_client_key).toBe("203.0.113.9");
    expect(calls.some((c) => c.fn === "claim_places_fetch_quota")).toBe(false);
    // The rich facts are written to the right venue, normalized by core.
    const write = calls.find((c) => c.fn === "apply_venue_details");
    expect(write!.args.p_venue_id).toBe(enrichArgs.venueId);
    expect(write!.args.p_phone).toBe("0151 227 4444"); // trimmed
    expect(write!.args.p_website).toBe("https://atlantictower.example/");
    expect(write!.args.p_price_range).toEqual({ start: 80, end: 150, currency: "GBP" });
    expect((write!.args.p_attributes as Record<string, unknown>).outdoorSeating).toBe(true);
    // And handed back to the caller for immediate render.
    expect(out.fields?.phone).toBe("0151 227 4444");
  });

  it("does NOT fetch or write when the detail budget is exhausted", async () => {
    const { rpc, calls } = fakeRpc({
      claim_places_detail_quota: { data: [{ allowed: false, reason: "daily-budget" }], error: null },
    });
    const { fn: getDetails, calls: detailCalls } = fakeGetDetails(richDetailsPlace);

    const out = await enrichVenueCore(rpc, getDetails, API_KEY, enrichArgs);

    expect(out).toEqual({ enriched: false, reason: "budget-exhausted", fields: null });
    expect(detailCalls).toEqual([]); // no paid Details call
    expect(calls.some((c) => c.fn === "apply_venue_details")).toBe(false);
  });

  it("maps a per-client-rate denial to rate-limited (no fetch)", async () => {
    const { rpc } = fakeRpc({
      claim_places_detail_quota: { data: [{ allowed: false, reason: "client-rate" }], error: null },
    });
    const { fn: getDetails, calls: detailCalls } = fakeGetDetails(richDetailsPlace);
    const out = await enrichVenueCore(rpc, getDetails, API_KEY, enrichArgs);
    expect(out.reason).toBe("rate-limited");
    expect(detailCalls).toEqual([]);
  });

  it("still writes (stamping details_fetched_at via the RPC) when Places has no rich facts, so we never re-pay", async () => {
    const { rpc, calls } = fakeRpc({ apply_venue_details: { data: null, error: null } });
    const { fn: getDetails } = fakeGetDetails(barePlace);

    const out = await enrichVenueCore(rpc, getDetails, API_KEY, { ...enrichArgs, placeId: "ChIJ_bare" });

    expect(out.enriched).toBe(true);
    const write = calls.find((c) => c.fn === "apply_venue_details");
    expect(write).toBeTruthy(); // the write still happens (its now() stamp is the "don't re-ask" marker)
    expect(write!.args.p_phone).toBeNull();
    expect(write!.args.p_attributes).toBeNull();
    expect(out.fields).toEqual({ phone: null, website_url: null, price_range: null, attributes: null });
  });
});
