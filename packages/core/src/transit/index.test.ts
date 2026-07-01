/**
 * transit core — pure geofence, cache-key, mode-mapping and EFA parser tests.
 *
 * These are the CI-verifiable half of the Translink integration: the network calls and the
 * in-memory budget/cache guard are proven live (per the testing standard), but the geofence
 * that gates the whole feature and the parsers that turn EFA's rapidJSON into our board shapes
 * are pure functions and are locked down here. The parser fixtures mirror the shapes the
 * Translink Opendata API documents (rapidJSON CoordInfo + Departure-Monitor).
 */
import { describe, it, expect } from "vitest";
import {
  isWithinNI,
  cacheKeyForPoint,
  modeFromProductClass,
  parseCoordStops,
  parseDepartures,
  nearestStop,
  MAX_DEPARTURES,
} from "./index.js";

describe("isWithinNI", () => {
  it("includes Belfast city centre", () => {
    expect(isWithinNI(54.597, -5.93)).toBe(true);
  });
  it("includes Derry/Londonderry", () => {
    expect(isWithinNI(54.997, -7.309)).toBe(true);
  });
  it("excludes Dublin (Republic of Ireland)", () => {
    expect(isWithinNI(53.349, -6.26)).toBe(false);
  });
  it("excludes London", () => {
    expect(isWithinNI(51.507, -0.127)).toBe(false);
  });
  it("excludes Glasgow (over the water)", () => {
    expect(isWithinNI(55.86, -4.25)).toBe(false);
  });
});

describe("cacheKeyForPoint", () => {
  it("snaps nearby points to the same key (~111 m grid)", () => {
    expect(cacheKeyForPoint(54.5972, -5.9301)).toBe(cacheKeyForPoint(54.5974, -5.9302));
  });
  it("distinguishes points a few hundred metres apart", () => {
    expect(cacheKeyForPoint(54.597, -5.93)).not.toBe(cacheKeyForPoint(54.6, -5.933));
  });
  it("is canonical (fixed precision, no float drift)", () => {
    expect(cacheKeyForPoint(54.6, -5.93)).toBe("54.600,-5.930");
  });
});

describe("modeFromProductClass", () => {
  it("maps rail classes", () => {
    expect(modeFromProductClass(0)).toBe("rail");
    expect(modeFromProductClass(1)).toBe("rail");
  });
  it("maps bus classes", () => {
    expect(modeFromProductClass(5)).toBe("bus");
    expect(modeFromProductClass(6)).toBe("bus");
  });
  it("maps tram/BRT (Glider) and ferry", () => {
    expect(modeFromProductClass(4)).toBe("tram");
    expect(modeFromProductClass(9)).toBe("ferry");
  });
  it("falls back to 'other' for unknown or missing classes", () => {
    expect(modeFromProductClass(99)).toBe("other");
    expect(modeFromProductClass(null)).toBe("other");
    expect(modeFromProductClass(undefined)).toBe("other");
  });
});

describe("parseCoordStops", () => {
  const origin = { lat: 54.597, lng: -5.93 };

  it("parses stops, preferring the short name and using EFA distance", () => {
    const json = {
      locations: [
        {
          id: "stop-1",
          name: "Belfast, Great Victoria Street",
          disassembledName: "Great Victoria Street",
          coord: [54.5945, -5.9335],
          properties: { distance: 320 },
        },
      ],
    };
    const stops = parseCoordStops(json, origin);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      id: "stop-1",
      name: "Great Victoria Street",
      lat: 54.5945,
      lng: -5.9335,
      distanceM: 320,
    });
  });

  it("sorts nearest-first and backfills distance via haversine when EFA omits it", () => {
    const json = {
      locations: [
        { id: "far", name: "Far", coord: [54.62, -5.96] },
        { id: "near", name: "Near", coord: [54.5971, -5.9302] },
      ],
    };
    const stops = parseCoordStops(json, origin);
    expect(stops.map((s) => s.id)).toEqual(["near", "far"]);
    expect(stops[0]?.distanceM).toBeGreaterThanOrEqual(0);
    expect(stops[0]?.distanceM).toBeLessThan(stops[1]?.distanceM ?? Infinity);
  });

  it("skips malformed entries and tolerates a non-object payload", () => {
    const json = {
      locations: [
        { name: "no id", coord: [54.6, -5.9] },
        { id: "no coord" },
        { id: "ok", name: "OK", coord: [54.598, -5.931] },
      ],
    };
    expect(parseCoordStops(json, origin).map((s) => s.id)).toEqual(["ok"]);
    expect(parseCoordStops(null, origin)).toEqual([]);
    expect(parseCoordStops({}, origin)).toEqual([]);
  });

  it("nearestStop returns the closest or null", () => {
    expect(nearestStop([])).toBeNull();
    const stops = parseCoordStops(
      { locations: [{ id: "a", name: "A", coord: [54.598, -5.931] }] },
      origin,
    );
    expect(nearestStop(stops)?.id).toBe("a");
  });
});

describe("parseDepartures", () => {
  it("parses realtime + scheduled fields and derives delay", () => {
    const json = {
      stopEvents: [
        {
          departureTimePlanned: "2026-07-01T09:00:00Z",
          departureTimeEstimated: "2026-07-01T09:03:00Z",
          transportation: {
            number: "1A",
            destination: { name: "City Centre" },
            product: { class: 5, name: "Bus" },
          },
        },
      ],
    };
    const [dep] = parseDepartures(json);
    expect(dep).toMatchObject({
      line: "1A",
      destination: "City Centre",
      mode: "bus",
      plannedTime: "2026-07-01T09:00:00Z",
      expectedTime: "2026-07-01T09:03:00Z",
      delayMin: 3,
      realtime: true,
    });
  });

  it("marks a scheduled-only departure as not realtime with null delay", () => {
    const json = {
      stopEvents: [
        {
          departureTimePlanned: "2026-07-01T09:00:00Z",
          transportation: { number: "Enterprise", product: { class: 0 } },
        },
      ],
    };
    const [dep] = parseDepartures(json);
    expect(dep?.mode).toBe("rail");
    expect(dep?.realtime).toBe(false);
    expect(dep?.delayMin).toBeNull();
    expect(dep?.expectedTime).toBeNull();
    expect(dep?.destination).toBe("—");
  });

  it("skips events with no planned time and caps at MAX_DEPARTURES", () => {
    const events = Array.from({ length: MAX_DEPARTURES + 4 }, (_, i) => ({
      departureTimePlanned: "2026-07-01T09:00:00Z",
      transportation: { number: String(i), product: { class: 5 } },
    }));
    events.splice(1, 0, { transportation: { number: "x" } } as never);
    const deps = parseDepartures({ stopEvents: events });
    expect(deps).toHaveLength(MAX_DEPARTURES);
  });

  it("tolerates a non-object payload", () => {
    expect(parseDepartures(null)).toEqual([]);
    expect(parseDepartures({})).toEqual([]);
  });
});
