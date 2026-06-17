import { describe, it, expect } from "vitest";
import { ingestCategoryCore, type LooseRpc, type SearchNearbyFn } from "./places.js";
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
function fakeRpc(results: Record<string, { data: unknown; error: null }>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: LooseRpc = async (fn, args) => {
    calls.push({ fn, args });
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
