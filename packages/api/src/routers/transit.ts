/**
 * transit router — the Northern Ireland travel layer (Translink Opendata, Stage 5 · Slice 1).
 *
 * ONE procedure so far: nearbyDepartures({ lat, lng }) → the live departure board for the
 * nearest Translink stop to a point. The flow is cost-first, mirroring places.ingestCategory's
 * "cache before you pay" posture:
 *
 *   geofence (is this even NI?) → board cache → per-client throttle + daily budget → EFA calls.
 *
 * WHY internalProcedure (not public): Translink is a fair-use-limited paid-style API, so — like
 * the Places ingest path — the browser must NOT be able to hit it directly. The web calls its
 * own /api/transit/nearby route, which holds the x-internal-call secret and forwards the client
 * IP (as x-roam-client-ip) so the guard can throttle per client. A direct caller can't reach
 * this surface at all.
 *
 * The PURE logic (geofence, parsers, mode mapping, cache-key snapping, fair-use constants) lives
 * in @roam/core/transit and is unit-tested there. The network I/O is the EFA client. This module
 * is the thin, stateful orchestrator: it owns the single in-memory TransitGuard instance and
 * sequences the two live calls behind the guards. Its live behaviour is verified live.
 *
 * The return is an INLINE structural type (no exported named type leaks into AppRouter) carrying
 * a `status` the web branches on, plus the licence-required attribution string on every response.
 */
import { z } from "zod";
import { transit } from "@roam/core";
import { router, internalProcedure } from "../trpc.js";
import { TransitGuard } from "../transit/guard.js";
import {
  fetchNearestStops as defaultFetchNearestStops,
  fetchDepartures as defaultFetchDepartures,
  fetchStopFinder as defaultFetchStopFinder,
  fetchTrip as defaultFetchTrip,
  type EfaConfig,
  type TripPlace,
} from "../transit/client.js";

/** How many candidate stops to ask CoordInfo for (we use the nearest; a few gives resilience). */
const STOP_CANDIDATES = 5;

/**
 * The board returned to the web. NOT exported — kept local so its name never surfaces in the
 * AppRouter inferred type (same discipline as places' IngestResult). `mode`/`status` are plain
 * strings/literals here rather than core's named unions, so no core type crosses the wire.
 */
type Board = {
  /**
   * ok            — a stop was found and its (possibly empty) board is attached.
   * no-stop       — inside NI, but Translink has no stop near this point.
   * outside-region— the point is outside Northern Ireland; the feature doesn't apply.
   * unconfigured  — TRANSLINK_API_KEY isn't set on the API; the feature is dormant.
   * throttled     — this client asked too often; try again shortly.
   * budget-exhausted — the daily fair-use ceiling is spent; try again later.
   * error         — an upstream/transport failure talking to Translink.
   */
  status:
    | "ok"
    | "no-stop"
    | "outside-region"
    | "unconfigured"
    | "throttled"
    | "budget-exhausted"
    | "error";
  stop: { id: string; name: string; lat: number; lng: number; distanceM: number | null } | null;
  departures: {
    line: string;
    destination: string;
    mode: string;
    plannedTime: string;
    expectedTime: string | null;
    delayMin: number | null;
    realtime: boolean;
  }[];
  /** Service notices / disruptions harvested from the same EFA payload (no extra call). */
  alerts: { title: string; content: string | null; priority: string | null; url: string | null }[];
  /** Licence-required credit; always present so the UI can't forget it. */
  attribution: string;
  /** True when served from the in-memory cache (no budget spent). */
  cached: boolean;
};

/** The single, long-lived guard for the whole service (cache + budget + throttle state). */
const guard = new TransitGuard();

/** Production seams for the EFA calls (swappable in a focused test). */
const fetchNearestStops = defaultFetchNearestStops;
const fetchDepartures = defaultFetchDepartures;
const fetchStopFinder = defaultFetchStopFinder;
const fetchTrip = defaultFetchTrip;

function emptyBoard(status: Board["status"], stop: Board["stop"] = null): Board {
  return { status, stop, departures: [], alerts: [], attribution: transit.TRANSLINK_ATTRIBUTION, cached: false };
}

/**
 * Build the board for a point. Cost-controlled: geofence and cache come before any paid call,
 * and each outbound EFA request claims one unit of the daily budget so a run costs at most two.
 */
async function buildBoard(
  config: EfaConfig | null,
  clientKey: string | null,
  input: { lat: number; lng: number },
): Promise<Board> {
  if (!config) return emptyBoard("unconfigured");
  if (!transit.isWithinNI(input.lat, input.lng)) return emptyBoard("outside-region");

  const key = transit.cacheKeyForPoint(input.lat, input.lng);
  const cached = guard.getCached<Board>(key);
  if (cached) return { ...cached, cached: true };

  const admission = guard.admit(clientKey);
  if (!admission.ok) return emptyBoard(admission.reason);

  const origin = { lat: input.lat, lng: input.lng };

  // (1) Nearest stop — costs one EFA request.
  if (!guard.claimRequest()) return emptyBoard("budget-exhausted");
  let stop: transit.TransitStop | null;
  try {
    const coordJson = await fetchNearestStops(
      { ...origin, radiusMetres: transit.STOP_SEARCH_RADIUS_M, maxResults: STOP_CANDIDATES },
      config,
    );
    stop = transit.nearestStop(transit.parseCoordStops(coordJson, origin));
  } catch (e) {
    console.error("[transit] nearest-stop lookup failed:", e);
    return emptyBoard("error");
  }

  if (!stop) {
    // Negative cache: a stopless area shouldn't be re-hammered every view within the TTL.
    const board = emptyBoard("no-stop");
    guard.setCached(key, board);
    return board;
  }

  // (2) Departure board — costs a second EFA request.
  if (!guard.claimRequest()) return emptyBoard("budget-exhausted", stop);
  let departures: transit.Departure[] = [];
  let alerts: transit.ServiceInfo[] = [];
  try {
    const dmJson = await fetchDepartures({ stopId: stop.id, limit: transit.MAX_DEPARTURES }, config);
    departures = transit.parseDepartures(dmJson);
    // Disruption notices ride in the SAME payload — no extra EFA request.
    alerts = transit.collectServiceInfos(dmJson);
  } catch (e) {
    console.error("[transit] departure-board lookup failed:", e);
    return { ...emptyBoard("error", stop) };
  }

  const board: Board = {
    status: "ok",
    stop,
    departures,
    alerts,
    attribution: transit.TRANSLINK_ATTRIBUTION,
    cached: false,
  };
  guard.setCached(key, board);
  return board;
}

/**
 * Stop-search result for the from/to autocomplete. Local (not exported) so no named type leaks
 * into AppRouter; `kind` is a plain string here rather than core's StopKind union.
 */
type StopList = {
  status: "ok" | "unconfigured" | "throttled" | "budget-exhausted" | "error";
  matches: { id: string; name: string; kind: string; lat: number | null; lng: number | null }[];
  attribution: string;
  cached: boolean;
};

/** A planned set of journeys. Local structural type — no core union crosses the wire. */
type TripPlan = {
  status: "ok" | "no-trips" | "unconfigured" | "throttled" | "budget-exhausted" | "error";
  trips: {
    departPlanned: string | null;
    departEstimated: string | null;
    arrivePlanned: string | null;
    arriveEstimated: string | null;
    durationMin: number | null;
    interchanges: number;
    realtime: boolean;
    legs: {
      kind: string;
      mode: string | null;
      line: string | null;
      headsign: string | null;
      originName: string;
      destName: string;
      departPlanned: string | null;
      departEstimated: string | null;
      arrivePlanned: string | null;
      arriveEstimated: string | null;
      durationMin: number | null;
      realtime: boolean;
    }[];
  }[];
  /** Service notices / disruptions harvested from the same trip payload (no extra call). */
  alerts: { title: string; content: string | null; priority: string | null; url: string | null }[];
  attribution: string;
  cached: boolean;
};

function emptyStops(status: StopList["status"]): StopList {
  return { status, matches: [], attribution: transit.TRANSLINK_ATTRIBUTION, cached: false };
}
function emptyPlan(status: TripPlan["status"]): TripPlan {
  return { status, trips: [], alerts: [], attribution: transit.TRANSLINK_ATTRIBUTION, cached: false };
}

/** Resolve a typed name to stop/address/POI matches. Cost-controlled + cached (names are stable). */
async function buildStopList(
  config: EfaConfig | null,
  clientKey: string | null,
  query: string,
): Promise<StopList> {
  if (!config) return emptyStops("unconfigured");
  const q = query.trim();
  if (q.length < 2) return { ...emptyStops("ok") };

  const key = `sf:${q.toLowerCase()}`;
  const cached = guard.getCached<StopList>(key);
  if (cached) return { ...cached, cached: true };

  const admission = guard.admit(clientKey);
  if (!admission.ok) return emptyStops(admission.reason);
  if (!guard.claimRequest()) return emptyStops("budget-exhausted");

  try {
    const json = await fetchStopFinder({ query: q, limit: transit.MAX_STOP_MATCHES }, config);
    const matches = transit.parseStopFinder(json);
    const result: StopList = {
      status: "ok",
      matches,
      attribution: transit.TRANSLINK_ATTRIBUTION,
      cached: false,
    };
    guard.setCached(key, result, transit.STOP_SEARCH_TTL_MS);
    return result;
  } catch (e) {
    console.error("[transit] stop-finder failed:", e);
    return emptyStops("error");
  }
}

/** Plan journeys between two endpoints. Cost-controlled + briefly cached (time-sensitive). */
/**
 * EFA means-of-transport classes to exclude for the mode-include filters. Rail = intercity/commuter/
 * metro/city-rail (0–3); the "bus" toggle also covers Glider (tram, 4) and coach (7). Ferry (9) is
 * never filtered. An empty result means "include everything" (the param is omitted).
 */
function excludedMeansFor(includeBus: boolean, includeRail: boolean): string | null {
  const classes: number[] = [];
  if (!includeRail) classes.push(0, 1, 2, 3);
  if (!includeBus) classes.push(4, 5, 6, 7);
  return classes.length ? classes.join(",") : null;
}

async function buildTripPlan(
  config: EfaConfig | null,
  clientKey: string | null,
  input: {
    origin: TripPlace;
    destination: TripPlace;
    date?: string | undefined;
    time?: string | undefined;
    arriveBy?: boolean | undefined;
    includeBus?: boolean | undefined;
    includeRail?: boolean | undefined;
  },
): Promise<TripPlan> {
  if (!config) return emptyPlan("unconfigured");

  const includeBus = input.includeBus ?? true;
  const includeRail = input.includeRail ?? true;
  const excludedMeans = excludedMeansFor(includeBus, includeRail);
  const key = `trip:${JSON.stringify([input.origin, input.destination, input.date ?? "", input.time ?? "", input.arriveBy ?? false, excludedMeans ?? ""])}`;
  const cached = guard.getCached<TripPlan>(key);
  if (cached) return { ...cached, cached: true };

  const admission = guard.admit(clientKey);
  if (!admission.ok) return emptyPlan(admission.reason);
  if (!guard.claimRequest()) return emptyPlan("budget-exhausted");

  try {
    const json = await fetchTrip(
      {
        origin: input.origin,
        destination: input.destination,
        date: input.date ?? null,
        time: input.time ?? null,
        arriveBy: input.arriveBy ?? false,
        excludedMeans,
        limit: transit.MAX_TRIP_RESULTS,
      },
      config,
    );
    const trips = transit.parseTrips(json);
    const result: TripPlan = {
      status: trips.length > 0 ? "ok" : "no-trips",
      trips,
      alerts: transit.collectServiceInfos(json),
      attribution: transit.TRANSLINK_ATTRIBUTION,
      cached: false,
    };
    guard.setCached(key, result, transit.TRIP_TTL_MS);
    return result;
  } catch (e) {
    console.error("[transit] trip plan failed:", e);
    return emptyPlan("error");
  }
}

export const transitRouter = router({
  /**
   * Internal: the live departure board for the nearest Translink stop to a point. Anonymous-safe
   * by construction (the web hop forwards no user identity, only the client IP for throttling);
   * never throws — every outcome is a `status` the UI renders.
   */
  nearbyDepartures: internalProcedure
    .input(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      }),
    )
    .query(async ({ ctx, input }): Promise<Board> => {
      const board = await buildBoard(ctx.env.transit.config, ctx.clientKey, input);
      if (ctx.env.transit.config?.debug) {
        console.log(
          `[transit] nearbyDepartures ${input.lat},${input.lng} → status=${board.status} ` +
            `stop=${board.stop ? `"${board.stop.name}"` : "null"} departures=${board.departures.length} cached=${board.cached}`,
        );
      }
      return board;
    }),

  /**
   * Internal: resolve a typed place name to stop/address/POI matches (the from/to autocomplete).
   * Cheap + heavily cached; never throws — every outcome is a `status` the UI renders.
   */
  searchStops: internalProcedure
    .input(z.object({ q: z.string().trim().min(2).max(80) }))
    .query(async ({ ctx, input }): Promise<StopList> => {
      const result = await buildStopList(ctx.env.transit.config, ctx.clientKey, input.q);
      if (ctx.env.transit.config?.debug) {
        console.log(
          `[transit] searchStops "${input.q}" → status=${result.status} matches=${result.matches.length} cached=${result.cached}`,
        );
      }
      return result;
    }),

  /**
   * Internal: plan journeys between two endpoints (each a stop id or a coordinate), optionally at a
   * given local date/time (depart or arrive). Never throws — outcomes are a `status` field.
   */
  planTrip: internalProcedure
    .input(
      z.object({
        origin: z.union([
          z.object({ stopId: z.string().min(1) }),
          z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
        ]),
        destination: z.union([
          z.object({ stopId: z.string().min(1) }),
          z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
        ]),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        arriveBy: z.boolean().optional(),
        includeBus: z.boolean().optional(),
        includeRail: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }): Promise<TripPlan> => {
      const result = await buildTripPlan(ctx.env.transit.config, ctx.clientKey, input);
      if (ctx.env.transit.config?.debug) {
        console.log(
          `[transit] planTrip → status=${result.status} trips=${result.trips.length} cached=${result.cached}`,
        );
      }
      return result;
    }),
});
