import { describe, it, expect } from "vitest";
import {
  distanceMetres,
  formatDistance,
  sortByProximity,
  isWithin,
  type LatLng,
} from "./index.js";

describe("distanceMetres", () => {
  it("is zero for identical points", () => {
    const p: LatLng = { lat: 54.97, lng: -1.61 }; // Newcastle-ish
    expect(distanceMetres(p, p)).toBe(0);
  });

  it("approximates ~111km per degree of latitude", () => {
    const d = distanceMetres({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it("works in the southern hemisphere too (global, no region assumptions)", () => {
    const sydney: LatLng = { lat: -33.87, lng: 151.21 };
    const melbourne: LatLng = { lat: -37.81, lng: 144.96 };
    const d = distanceMetres(sydney, melbourne);
    // ~714 km as the crow flies.
    expect(d).toBeGreaterThan(700_000);
    expect(d).toBeLessThan(730_000);
  });
});

describe("formatDistance", () => {
  it("uses metres under 1km", () => {
    expect(formatDistance(450)).toBe("450 m");
  });
  it("uses one decimal km under 10km", () => {
    expect(formatDistance(2500)).toBe("2.5 km");
  });
  it("uses whole km at/over 10km", () => {
    expect(formatDistance(15000)).toBe("15 km");
  });
});

describe("sortByProximity", () => {
  it("orders near to far from the origin", () => {
    const origin: LatLng = { lat: 0, lng: 0 };
    const items = [
      { id: "far", lat: 5, lng: 5 },
      { id: "near", lat: 0.1, lng: 0.1 },
      { id: "mid", lat: 1, lng: 1 },
    ];
    const sorted = sortByProximity(origin, items, (i) => ({
      lat: i.lat,
      lng: i.lng,
    }));
    expect(sorted.map((i) => i.id)).toEqual(["near", "mid", "far"]);
  });
});

describe("isWithin", () => {
  it("true inside the radius, false outside", () => {
    const centre: LatLng = { lat: 0, lng: 0 };
    expect(isWithin(centre, { lat: 0.001, lng: 0 }, 1000)).toBe(true);
    expect(isWithin(centre, { lat: 1, lng: 0 }, 1000)).toBe(false);
  });
});
