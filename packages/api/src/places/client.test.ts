import { describe, it, expect } from "vitest";
import { searchNearby, type FetchImpl } from "./client.js";

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
