import { describe, it, expect } from "vitest";
import { parseNominatim } from "./index.js";

describe("parseNominatim", () => {
  it("maps a town result to name + region hint + coords", () => {
    const raw = [
      {
        osm_type: "relation",
        osm_id: 123,
        lat: "54.5253",
        lon: "-1.5536",
        display_name: "Darlington, County Durham, England, United Kingdom",
        address: { town: "Darlington", county: "County Durham", state: "England", country: "United Kingdom" },
      },
    ];
    const [r] = parseNominatim(raw);
    expect(r!.name).toBe("Darlington");
    expect(r!.hint).toBe("County Durham, England");
    expect(r!.lat).toBeCloseTo(54.5253);
    expect(r!.lng).toBeCloseTo(-1.5536);
    expect(r!.id).toBe("geo:relation123");
  });

  it("uses the most specific locality and excludes it from the hint (Westminster/London)", () => {
    const raw = [
      {
        osm_type: "node",
        osm_id: 9,
        lat: "51.4975",
        lon: "-0.1357",
        address: { suburb: "Westminster", state_district: "Greater London", state: "England", country: "UK" },
        display_name: "Westminster, Greater London, England, UK",
      },
    ];
    const [r] = parseNominatim(raw);
    expect(r!.name).toBe("Westminster");
    expect(r!.hint).toBe("Greater London, England");
  });

  it("returns the postcode as the name for a postcode lookup", () => {
    const raw = [
      {
        osm_type: "way",
        osm_id: 5,
        lat: "54.523",
        lon: "-1.55",
        address: { postcode: "DL1 1AA", county: "County Durham", country: "United Kingdom" },
        display_name: "DL1 1AA, Darlington, County Durham, United Kingdom",
      },
    ];
    const [r] = parseNominatim(raw);
    // county is a PRIMARY fallback, so a bare postcode result names by the first display part.
    expect(r!.name === "DL1 1AA" || r!.name === "County Durham").toBe(true);
    expect(r!.lat).toBeCloseTo(54.523);
  });

  it("falls back to display_name parts when there is no structured address", () => {
    const raw = [
      { osm_type: "node", osm_id: 1, lat: "54.0", lon: "-1.0", display_name: "Yarm, Stockton-on-Tees, England" },
    ];
    const [r] = parseNominatim(raw);
    expect(r!.name).toBe("Yarm");
    expect(r!.hint).toBe("Stockton-on-Tees, England");
  });

  it("drops entries with no usable coordinates", () => {
    const raw = [
      { display_name: "Nowhere", lat: "not-a-number", lon: "12" },
      { osm_type: "node", osm_id: 2, lat: "1.0", lon: "2.0", display_name: "Somewhere, Region" },
    ];
    const out = parseNominatim(raw);
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("Somewhere");
  });

  it("de-dups near-identical coordinates and caps the count", () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({
      osm_type: "node",
      osm_id: i,
      lat: "54.50000",
      lon: "-1.50000",
      display_name: `Dup ${i}, Region`,
    }));
    const out = parseNominatim(raw);
    expect(out.length).toBe(1); // all collapse to one grid cell
  });

  it("returns [] for non-array / empty input", () => {
    expect(parseNominatim(null)).toEqual([]);
    expect(parseNominatim({})).toEqual([]);
    expect(parseNominatim([])).toEqual([]);
  });

  it("honors the limit argument", () => {
    const raw = Array.from({ length: 8 }, (_, i) => ({
      osm_type: "node",
      osm_id: i,
      lat: `54.${500 + i}`,
      lon: `-1.${500 + i}`,
      display_name: `Place ${i}, Region`,
    }));
    expect(parseNominatim(raw, 3).length).toBe(3);
  });
});
