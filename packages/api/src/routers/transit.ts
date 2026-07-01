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
  type EfaConfig,
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
  /** Licence-required credit; always present so the UI can't forget it. */
  attribution: string;
  /** True when served from the in-memory cache (no budget spent). */
  cached: boolean;
};

/** The single, long-lived guard for the whole service (cache + budget + throttle state). */
const guard = new TransitGuard<Board>();

/** Production seams for the two EFA calls (swappable in a focused test). */
const fetchNearestStops = defaultFetchNearestStops;
const fetchDepartures = defaultFetchDepartures;

function emptyBoard(status: Board["status"], stop: Board["stop"] = null): Board {
  return { status, stop, departures: [], attribution: transit.TRANSLINK_ATTRIBUTION, cached: false };
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
  const cached = guard.getCached(key);
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
  try {
    const dmJson = await fetchDepartures({ stopId: stop.id, limit: transit.MAX_DEPARTURES }, config);
    departures = transit.parseDepartures(dmJson);
  } catch (e) {
    console.error("[transit] departure-board lookup failed:", e);
    return { ...emptyBoard("error", stop) };
  }

  const board: Board = {
    status: "ok",
    stop,
    departures,
    attribution: transit.TRANSLINK_ATTRIBUTION,
    cached: false,
  };
  guard.setCached(key, board);
  return board;
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
      return buildBoard(ctx.env.transit.config, ctx.clientKey, input);
    }),
});
