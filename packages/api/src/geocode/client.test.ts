import { describe, it, expect } from "vitest";
import { geocodeSearch, type FetchImpl } from "./client.js";

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

describe("geocodeSearch", () => {
  it("GETs Photon with the query, limit and a User-Agent", async () => {
    const { impl, calls } = fakeFetch({ features: [] });
    await geocodeSearch("Darlington", impl);

    expect(calls.length).toBe(1);
    const { url, init } = calls[0]!;
    expect(url.startsWith("https://photon.komoot.io/api?")).toBe(true);
    expect(url).toContain("q=Darlington");
    expect(url).toContain("limit=10");
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("Roam");
  });

  it("url-encodes a postcode query", async () => {
    const { impl, calls } = fakeFetch({ features: [] });
    await geocodeSearch("DH1 3LE", impl);
    expect(calls[0]!.url).toContain("q=DH1+3LE");
  });

  it("parses the FeatureCollection through core (name + coords)", async () => {
    const { impl } = fakeFetch({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-1.5536, 54.5253] },
          properties: { osm_type: "R", osm_id: 1, name: "Darlington", county: "County Durham" },
        },
      ],
    });
    const out = await geocodeSearch("Darlington", impl);
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("Darlington");
    expect(out[0]!.lat).toBeCloseTo(54.5253);
  });

  it("throws on a non-ok response so the procedure can surface it", async () => {
    const { impl } = fakeFetch("rate limited", { ok: false, status: 429, statusText: "Too Many Requests" });
    await expect(geocodeSearch("x", impl)).rejects.toThrow(/429/);
  });
});
