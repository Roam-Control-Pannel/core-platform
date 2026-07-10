import { describe, it, expect } from "vitest";
import { searchNearby, searchText, getPlaceDetails, type FetchImpl } from "./client.js";

/** Build a fake fetch that records the call and returns a canned response. */
function fakeFetch(
  response: unknown,
  opts: { ok?: boolean; status?: number; statusText?: string } = {},
): { impl: FetchImpl; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      statusText: opts.statusText ?? "OK",
      json: async () => response,
      text: async () => JSON.stringify(response),
    } as Response;
  }) as unknown as FetchImpl;
  return { impl, calls };
}

const params = {
  lat: 54.5253,
  lng: -1.5849,
  includedTypes: ["cafe", "coffee_shop"] as const,
  radiusMetres: 1500,
  maxResultCount: 20,
};

describe("searchNearby request shape", () => {
  it("POSTs to the Places New searchNearby endpoint with the field mask", async () => {
    const { impl, calls } = fakeFetch({ places: [] });
    await searchNearby(params, "test-key", impl);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://places.googleapis.com/v1/places:searchNearby");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("test-key");
    // Field mask must request exactly the venue-row fields (the cost lever).
    expect(headers["X-Goog-FieldMask"]).toContain("places.id");
    expect(headers["X-Goog-FieldMask"]).toContain("places.location");
    expect(headers["X-Goog-FieldMask"]).toContain("places.displayName");
  });

  it("sends the category types, radius, and a circle restriction in the body", async () => {
    const { impl, calls } = fakeFetch({ places: [] });
    await searchNearby(params, "test-key", impl);

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.includedTypes).toEqual(["cafe", "coffee_shop"]);
    expect(body.maxResultCount).toBe(20);
    expect(body.locationRestriction.circle.center).toEqual({
      latitude: 54.5253,
      longitude: -1.5849,
    });
    expect(body.locationRestriction.circle.radius).toBe(1500);
  });
});

describe("searchNearby response parsing", () => {
  it("returns the places array parsed as PlaceResult[]", async () => {
    const { impl } = fakeFetch({
      places: [
        {
          id: "ChIJ_abc",
          displayName: { text: "Test Cafe" },
          location: { latitude: 54.5, longitude: -1.58 },
          types: ["cafe", "food"],
        },
      ],
    });
    const out = await searchNearby(params, "test-key", impl);
    expect(out.length).toBe(1);
    expect(out[0]!.id).toBe("ChIJ_abc");
    expect(out[0]!.displayName?.text).toBe("Test Cafe");
  });

  it("treats a no-match response (no places key) as an empty array, not an error", async () => {
    const { impl } = fakeFetch({});
    const out = await searchNearby(params, "test-key", impl);
    expect(out).toEqual([]);
  });

  it("throws on a non-ok HTTP response so the caller knows the fetch did not run", async () => {
    const { impl } = fakeFetch(
      { error: { message: "quota" } },
      { ok: false, status: 429, statusText: "Too Many Requests" },
    );
    await expect(searchNearby(params, "test-key", impl)).rejects.toThrow(/429/);
  });
});

const textParams = { textQuery: "Atlantic Tower Hotel", lat: 53.4084, lng: -2.9916, radiusMetres: 25_000, maxResultCount: 20 };

describe("searchText", () => {
  it("POSTs to the Places New Text Search endpoint with the field mask and a location BIAS", async () => {
    const { impl, calls } = fakeFetch({ places: [] });
    await searchText(textParams, "test-key", impl);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://places.googleapis.com/v1/places:searchText");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("test-key");
    expect(headers["X-Goog-FieldMask"]).toContain("places.id");

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.textQuery).toBe("Atlantic Tower Hotel");
    expect(body.maxResultCount).toBe(20);
    // BIAS, not restriction — a slightly-off centre must still find the venue.
    expect(body.locationBias.circle.center).toEqual({ latitude: 53.4084, longitude: -2.9916 });
    expect(body.locationBias.circle.radius).toBe(25_000);
    expect(body.locationRestriction).toBeUndefined();
  });

  it("parses the places array and treats a no-match response as []", async () => {
    const { impl } = fakeFetch({ places: [{ id: "ChIJ_hotel", displayName: { text: "Atlantic Tower" }, types: ["lodging"] }] });
    expect((await searchText(textParams, "test-key", impl))[0]!.id).toBe("ChIJ_hotel");
    const { impl: empty } = fakeFetch({});
    expect(await searchText(textParams, "test-key", empty)).toEqual([]);
  });

  it("throws on a non-ok HTTP response", async () => {
    const { impl } = fakeFetch({ error: { message: "quota" } }, { ok: false, status: 429, statusText: "Too Many Requests" });
    await expect(searchText(textParams, "test-key", impl)).rejects.toThrow(/429/);
  });
});

describe("getPlaceDetails (photo backfill)", () => {
  it("GETs /v1/places/{id} with the backfill field mask and the api key", async () => {
    const { impl, calls } = fakeFetch({ id: "ChIJ_abc", photos: [] });
    await getPlaceDetails("ChIJ_abc", "test-key", impl);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://places.googleapis.com/v1/places/ChIJ_abc");
    expect((calls[0]!.init.method ?? "GET")).toBe("GET");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("test-key");
    // Photos + the card-enrichment facts, all within the SKU tier searchNearby already pays.
    const mask = headers["X-Goog-FieldMask"]!;
    expect(mask).toContain("id");
    expect(mask).toContain("photos");
    expect(mask).toContain("userRatingCount");
    expect(mask).toContain("priceLevel");
    expect(mask).toContain("primaryTypeDisplayName");
    expect(mask).toContain("businessStatus");
    // Atmosphere-tier fields must NOT leak in (they'd bump billing).
    expect(mask).not.toContain("editorialSummary");
  });

  it("url-encodes the place id in the path", async () => {
    const { impl, calls } = fakeFetch({ id: "a/b id", photos: [] });
    await getPlaceDetails("a/b id", "test-key", impl);
    expect(calls[0]!.url).toBe("https://places.googleapis.com/v1/places/a%2Fb%20id");
  });

  it("returns the place object directly (not wrapped in a places array)", async () => {
    const { impl } = fakeFetch({
      id: "ChIJ_abc",
      photos: [{ name: "places/ChIJ_abc/photos/x", widthPx: 4032, heightPx: 3024 }],
    });
    const place = await getPlaceDetails("ChIJ_abc", "test-key", impl);
    expect(place.id).toBe("ChIJ_abc");
    expect(place.photos?.length).toBe(1);
    expect(place.photos?.[0]!.name).toBe("places/ChIJ_abc/photos/x");
  });

  it("throws on a non-ok HTTP response so the backfill can skip that one venue", async () => {
    const { impl } = fakeFetch(
      { error: { message: "not found" } },
      { ok: false, status: 404, statusText: "Not Found" },
    );
    await expect(getPlaceDetails("missing", "test-key", impl)).rejects.toThrow(/404/);
  });
});
