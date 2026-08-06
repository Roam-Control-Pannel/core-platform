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
  isWithinIreland,
  cacheKeyForPoint,
  modeFromProductClass,
  parseCoordStops,
  parseDepartures,
  parseStopFinder,
  parseTrips,
  collectServiceInfos,
  nearestStop,
  parseEfaTime,
  MAX_DEPARTURES,
  MAX_STOP_MATCHES,
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

describe("isWithinIreland", () => {
  it("includes Belfast (NI) and Dublin, Cork, Galway (Republic)", () => {
    expect(isWithinIreland(54.597, -5.93)).toBe(true); // Belfast
    expect(isWithinIreland(53.349, -6.26)).toBe(true); // Dublin
    expect(isWithinIreland(51.897, -8.47)).toBe(true); // Cork
    expect(isWithinIreland(53.27, -9.06)).toBe(true); // Galway
  });
  it("is a superset of NI", () => {
    expect(isWithinIreland(54.997, -7.309)).toBe(true); // Derry
  });
  it("excludes Great Britain and the Isle of Man", () => {
    expect(isWithinIreland(55.86, -4.25)).toBe(false); // Glasgow
    expect(isWithinIreland(51.48, -3.18)).toBe(false); // Cardiff
    expect(isWithinIreland(54.15, -4.48)).toBe(false); // Isle of Man
    expect(isWithinIreland(51.507, -0.127)).toBe(false); // London
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

  it("prefers properties.stopID when isGlobalId is true (else falls back to id)", () => {
    const json = {
      locations: [
        {
          id: "internal-1",
          isGlobalId: true,
          name: "Great Victoria St",
          coord: [54.594, -5.933],
          properties: { stopID: "10000013", distance: 120 },
        },
        {
          id: "10000099",
          name: "No global id",
          coord: [54.595, -5.934],
          properties: { distance: 200 },
        },
      ],
    };
    const stops = parseCoordStops(json, origin);
    expect(stops.map((s) => s.id)).toEqual(["10000013", "10000099"]);
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

  it("sorts departures soonest-first even if EFA returns them out of order", () => {
    const json = {
      stopEvents: [
        { departureTimePlanned: "2026-07-01T09:10:00Z", transportation: { number: "B", product: { class: 5 } } },
        { departureTimePlanned: "2026-07-01T09:00:00Z", transportation: { number: "A", product: { class: 5 } } },
        {
          departureTimePlanned: "2026-07-01T09:20:00Z",
          departureTimeEstimated: "2026-07-01T09:02:00Z", // realtime pulls it earliest
          transportation: { number: "C", product: { class: 5 } },
        },
      ],
    };
    expect(parseDepartures(json).map((d) => d.line)).toEqual(["A", "C", "B"]);
  });
});

describe("parseEfaTime (UTC handling)", () => {
  it("parses a Z-terminated timestamp as UTC", () => {
    expect(parseEfaTime("2026-07-01T09:00:00Z")).toBe(Date.UTC(2026, 6, 1, 9, 0, 0));
  });
  it("treats a timezone-less timestamp as UTC (not local)", () => {
    expect(parseEfaTime("2026-07-01T09:00:00")).toBe(Date.UTC(2026, 6, 1, 9, 0, 0));
  });
  it("honours an explicit offset", () => {
    expect(parseEfaTime("2026-07-01T10:00:00+01:00")).toBe(Date.UTC(2026, 6, 1, 9, 0, 0));
  });
});

describe("parseStopFinder", () => {
  const json = {
    locations: [
      { id: "poi:1", name: "Bangor Marina", type: "poi", coord: [54.66, -5.66], matchQuality: 700 },
      {
        id: "raw-id",
        isGlobalId: true,
        name: "Bangor, Rail Station",
        type: "stop",
        coord: [54.66, -5.67],
        matchQuality: 990,
        properties: { stopId: "GLOBAL123" },
      },
      { id: "addr:9", name: "Main St, Bangor", type: "street", coord: [54.65, -5.67], matchQuality: 990 },
    ],
  };

  it("returns matches best-quality first, stops winning ties", () => {
    const matches = parseStopFinder(json);
    expect(matches.length).toBe(3);
    // Two 990s: the stop must rank above the street on the tie-break.
    expect(matches[0]!.name).toBe("Bangor, Rail Station");
    expect(matches[1]!.name).toBe("Main St, Bangor");
    expect(matches[2]!.name).toBe("Bangor Marina");
  });

  it("uses the global stop id when isGlobalId is set", () => {
    const [top] = parseStopFinder(json);
    expect(top!.id).toBe("GLOBAL123");
    expect(top!.kind).toBe("stop");
    expect(top!.lat).toBeCloseTo(54.66);
  });

  it("maps EFA types to coarse kinds and caps the list", () => {
    const many = { locations: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, name: `Stop ${i}`, type: "stop", coord: [54, -6], matchQuality: 100 - i })) };
    expect(parseStopFinder(many).length).toBe(MAX_STOP_MATCHES);
  });

  it("tolerates junk", () => {
    expect(parseStopFinder(null)).toEqual([]);
    expect(parseStopFinder({})).toEqual([]);
    expect(parseStopFinder({ locations: [{ name: "no id" }] })).toEqual([]);
  });
});

describe("parseTrips", () => {
  const json = {
    journeys: [
      {
        legs: [
          {
            duration: 300,
            origin: { name: "Start", departureTimePlanned: "2026-08-06T10:00:00Z" },
            destination: { name: "Stop A", arrivalTimePlanned: "2026-08-06T10:05:00Z" },
          },
          {
            origin: { name: "Stop A", departureTimePlanned: "2026-08-06T10:08:00Z", departureTimeEstimated: "2026-08-06T10:10:00Z" },
            destination: { name: "Stop B", arrivalTimePlanned: "2026-08-06T10:40:00Z" },
            transportation: { number: "7", destination: { name: "City Hall" }, product: { class: 5 } },
          },
        ],
      },
    ],
  };

  it("parses a walk + bus journey with legs, times and interchanges", () => {
    const trips = parseTrips(json);
    expect(trips.length).toBe(1);
    const trip = trips[0]!;
    expect(trip.legs.length).toBe(2);

    const [walk, bus] = trip.legs;
    expect(walk!.kind).toBe("walk");
    expect(walk!.mode).toBeNull();
    expect(walk!.line).toBeNull();
    expect(walk!.durationMin).toBe(5);

    expect(bus!.kind).toBe("transit");
    expect(bus!.mode).toBe("bus");
    expect(bus!.line).toBe("7");
    expect(bus!.headsign).toBe("City Hall");
    expect(bus!.realtime).toBe(true);

    expect(trip.interchanges).toBe(0); // one transit leg → no changes
    expect(trip.durationMin).toBe(40); // 10:00 → 10:40
    expect(trip.realtime).toBe(true);
    expect(trip.departPlanned).toBe("2026-08-06T10:00:00Z");
    expect(trip.arrivePlanned).toBe("2026-08-06T10:40:00Z");
  });

  it("counts interchanges as transit legs minus one", () => {
    const twoBuses = {
      journeys: [
        {
          legs: [
            { origin: { name: "A", departureTimePlanned: "2026-08-06T10:00:00Z" }, destination: { name: "B", arrivalTimePlanned: "2026-08-06T10:20:00Z" }, transportation: { number: "1", product: { class: 5 } } },
            { origin: { name: "B", departureTimePlanned: "2026-08-06T10:25:00Z" }, destination: { name: "C", arrivalTimePlanned: "2026-08-06T10:45:00Z" }, transportation: { number: "2", product: { class: 5 } } },
          ],
        },
      ],
    };
    expect(parseTrips(twoBuses)[0]!.interchanges).toBe(1);
  });

  it("tolerates junk and the `trips` alias", () => {
    expect(parseTrips(null)).toEqual([]);
    expect(parseTrips({})).toEqual([]);
    expect(parseTrips({ journeys: [{ legs: [] }] })).toEqual([]);
    expect(parseTrips({ trips: json.journeys }).length).toBe(1);
  });
});

describe("collectServiceInfos", () => {
  it("harvests nested infos from a DM-shaped payload, deduped", () => {
    const json = {
      stopEvents: [
        { transportation: { infos: [{ priority: "high", title: "Diversion", content: "Route 7 is on diversion.", url: "http://x" }] } },
        { transportation: { infos: [{ title: "Diversion", content: "Route 7 is on diversion." }] } }, // dup
      ],
    };
    const infos = collectServiceInfos(json);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ title: "Diversion", content: "Route 7 is on diversion.", priority: "high", url: "http://x" });
  });

  it("strips HTML and drops content that only repeats the title", () => {
    const json = { infos: [{ title: "Delay", content: "<p>Delay</p>" }, { hints: [] }] };
    const infos = collectServiceInfos(json);
    expect(infos).toHaveLength(1);
    expect(infos[0]!.title).toBe("Delay");
    expect(infos[0]!.content).toBeNull();
  });

  it("caps output and tolerates junk", () => {
    const many = { infos: Array.from({ length: 30 }, (_, i) => ({ title: `Notice ${i}` })) };
    expect(collectServiceInfos(many, 5)).toHaveLength(5);
    expect(collectServiceInfos(null)).toEqual([]);
    expect(collectServiceInfos({ infos: [{ noText: true }] })).toEqual([]);
  });
})
