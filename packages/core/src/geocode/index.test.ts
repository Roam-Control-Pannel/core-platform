import { describe, it, expect } from "vitest";
import { parsePhoton } from "./index.js";

/** A Photon feature with [lon, lat] geometry + properties. */
function feat(coordinates: [number, number], properties: Record<string, unknown>) {
  return { type: "Feature", geometry: { type: "Point", coordinates }, properties };
}

describe("parsePhoton", () => {
  it("maps a town feature to name + region hint + coords (from a FeatureCollection)", () => {
    const raw = {
      type: "FeatureCollection",
      features: [
        feat([-1.5536, 54.5253], {
          osm_type: "R",
          osm_id: 123,
          name: "Darlington",
          county: "County Durham",
          state: "England",
          country: "United Kingdom",
        }),
      ],
    };
    const [r] = parsePhoton(raw);
    expect(r!.name).toBe("Darlington");
    expect(r!.hint).toBe("County Durham, England");
    expect(r!.lat).toBeCloseTo(54.5253);
    expect(r!.lng).toBeCloseTo(-1.5536);
    expect(r!.id).toBe("geo:R123");
  });

  it("excludes a city that duplicates the name from the hint (Westminster/London)", () => {
    const raw = {
      features: [
        feat([-0.1357, 51.4975], {
          osm_type: "N",
          osm_id: 9,
          name: "Westminster",
          city: "London",
          state: "England",
          country: "United Kingdom",
        }),
      ],
    };
    const [r] = parsePhoton(raw);
    expect(r!.name).toBe("Westminster");
    expect(r!.hint).toBe("London, England");
  });

  it("names a postcode result by its postcode", () => {
    const raw = {
      features: [
        feat([-1.55, 54.523], { osm_type: "W", osm_id: 5, postcode: "DH1 3LE", city: "Durham", county: "County Durham" }),
      ],
    };
    const [r] = parsePhoton(raw);
    expect(r!.name).toBe("DH1 3LE");
    expect(r!.hint).toContain("Durham");
    expect(r!.lat).toBeCloseTo(54.523);
  });

  it("accepts the features array directly (not just the wrapper)", () => {
    const raw = [feat([-1.0, 54.0], { osm_type: "N", osm_id: 1, name: "Yarm", county: "Stockton-on-Tees" })];
    const [r] = parsePhoton(raw);
    expect(r!.name).toBe("Yarm");
    expect(r!.hint).toBe("Stockton-on-Tees");
  });

  it("drops features with no usable coordinates or no label", () => {
    const raw = {
      features: [
        feat([Number.NaN, 12] as [number, number], { name: "Bad coords" }),
        { type: "Feature", geometry: { coordinates: [1, 2] }, properties: {} }, // no name
        feat([2.0, 1.0], { osm_type: "N", osm_id: 2, name: "Good" }),
      ],
    };
    const out = parsePhoton(raw);
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("Good");
  });

  it("de-dups near-identical coordinates and honors the limit", () => {
    const dup = Array.from({ length: 5 }, (_, i) =>
      feat([-1.5, 54.5], { osm_type: "N", osm_id: i, name: `Dup ${i}`, county: "Region" }),
    );
    expect(parsePhoton({ features: dup }).length).toBe(1);

    const many = Array.from({ length: 8 }, (_, i) =>
      feat([-1.5 - i * 0.01, 54.5 + i * 0.01], { osm_type: "N", osm_id: i, name: `P${i}` }),
    );
    expect(parsePhoton({ features: many }, 3).length).toBe(3);
  });

  it("ranks the settlement node above an admin boundary so a city centres correctly (Liverpool)", () => {
    // Photon returns the administrative boundary (centroid ~2km SE, in Wavertree) FIRST, then a
    // name-sharing POI, then the place=city node (the real centre). The node must win.
    const boundary = feat([-2.917, 53.393], {
      osm_type: "R", osm_id: 172987, name: "Liverpool",
      osm_key: "boundary", osm_value: "administrative", county: "Merseyside", state: "England",
    });
    const station = feat([-0.0865, 51.5175], {
      osm_type: "N", osm_id: 999, name: "Liverpool Street", osm_key: "railway", osm_value: "station", city: "London",
    });
    const cityNode = feat([-2.9916, 53.4084], {
      osm_type: "N", osm_id: 12345, name: "Liverpool",
      osm_key: "place", osm_value: "city", county: "Merseyside", state: "England",
    });
    const out = parsePhoton({ features: [boundary, station, cityNode] });
    expect(out[0]!.name).toBe("Liverpool");
    expect(out[0]!.lat).toBeCloseTo(53.4084); // the city node, not the boundary centroid
    expect(out[0]!.lng).toBeCloseTo(-2.9916);
  });

  it("preserves Photon order for equally-ranked (unranked) features", () => {
    // No place/boundary/type signals → all default rank → original order is kept.
    const raw = {
      features: [
        feat([-1.0, 54.0], { osm_type: "N", osm_id: 1, name: "First" }),
        feat([-2.0, 55.0], { osm_type: "N", osm_id: 2, name: "Second" }),
      ],
    };
    const out = parsePhoton(raw);
    expect(out.map((r) => r.name)).toEqual(["First", "Second"]);
  });

  it("returns [] for non-feature input", () => {
    expect(parsePhoton(null)).toEqual([]);
    expect(parsePhoton({})).toEqual([]);
    expect(parsePhoton({ features: "nope" })).toEqual([]);
  });
});
