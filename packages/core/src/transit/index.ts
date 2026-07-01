/**
 * @roam/core/transit — the Northern Ireland travel layer's PURE domain logic.
 *
 * Roam's transit integration is the Translink Opendata API (an EFA "Intermodal Journey
 * Planner": a LIVE query API, not a GTFS import). The network I/O — the two EFA calls that
 * carry the API key — lives in the api package (packages/api/src/transit/client.ts), the same
 * split as Google Places: transport-carrying code cannot live here by law. This module is the
 * transport-agnostic half: the geofence that decides whether a point is even in Translink's
 * territory, the response PARSERS that turn EFA's rapidJSON into our small board shapes, the
 * product-class → mode mapping, the cache-key snapping, and the fair-use constants.
 *
 * WHY parsers here and not in the client: they are pure functions of JSON in → typed rows out,
 * so they are the part we can unit-test in CI without a network or a key (mirroring how the
 * Places place→row transform lives in @roam/core/places, not in the Places client). The client
 * stays a thin fetch that hands its JSON straight to these.
 *
 * ATTRIBUTION is a licence obligation: any surface showing this data must render
 * TRANSLINK_ATTRIBUTION. It is exported here so the string lives in exactly one place.
 */
import { distanceMetres } from "../geo/index.js";

/**
 * Licence-required attribution. Translink's Open Data fair-use terms require this credit on
 * any surface that displays the data. Rendered by the web "Nearby departures" card's footer.
 */
export const TRANSLINK_ATTRIBUTION = "Transport Information supplied by Translink Opendata API";

/**
 * Daily call budget — a self-imposed ceiling kept below Translink's ~3,000 requests/day
 * fair-use limit so a busy day (or a misbehaving client) can never breach the licence. The
 * budget counts EFA REQUESTS, and one "nearby departures" answer costs up to two (a CoordInfo
 * stop lookup + a Departure-Monitor board), so this leaves comfortable headroom. Enforced by
 * the api's in-memory guard; a cache hit costs nothing against it.
 */
export const TRANSLINK_DAILY_BUDGET = 2_500;

/**
 * How long a departure board stays fresh. Realtime data ages fast, so the cache TTL is short —
 * long enough to absorb a burst of viewers on the same place, short enough that "due in 3 min"
 * stays honest. Cache hits within this window serve without spending budget.
 */
export const DEPARTURES_TTL_MS = 45_000;

/** Radius (m) for the nearest-stop search. Urban walk-to-stop scale. */
export const STOP_SEARCH_RADIUS_M = 800;

/** Max departures returned on a board — a glanceable list, not a full timetable. */
export const MAX_DEPARTURES = 8;

/** Grid precision for the cache key: 3 decimal places ≈ 111 m, so nearby viewers share a board. */
const CACHE_KEY_DP = 3;

/**
 * Coarse Northern Ireland bounding box. Deliberately generous (it laps a little over the land
 * border and out to the coast) because it is only a "should we even ask Translink?" gate — a
 * false include just means an EFA lookup that returns no nearby stop, which the caller handles
 * as "no departures". Getting a real board still requires Translink actually having a stop
 * near the point, so the box being loose costs at most one wasted lookup at the margins.
 */
const NI_BOUNDS = { minLat: 53.95, maxLat: 55.35, minLng: -8.35, maxLng: -5.35 } as const;

/** Is a point inside Translink's Northern Ireland service territory (coarse box)? */
export function isWithinNI(lat: number, lng: number): boolean {
  return (
    lat >= NI_BOUNDS.minLat &&
    lat <= NI_BOUNDS.maxLat &&
    lng >= NI_BOUNDS.minLng &&
    lng <= NI_BOUNDS.maxLng
  );
}

/**
 * A stable cache key for a query point: snap to the grid so two viewers a few dozen metres
 * apart hit the same cached board instead of each paying for a lookup. Fixed precision keeps
 * the key canonical (no floating-point drift in the string).
 */
export function cacheKeyForPoint(lat: number, lng: number): string {
  return `${lat.toFixed(CACHE_KEY_DP)},${lng.toFixed(CACHE_KEY_DP)}`;
}

/** The transit modes we distinguish for iconography/labelling. */
export type TransitMode = "rail" | "bus" | "tram" | "ferry" | "other";

/**
 * Map an EFA product-class code to a Roam mode, per the spec's means-of-transport table
 * (Trip-Request §3.3): 0 Train, 1 Commuter railway, 2 Underground, 3 City rail, 4 Tram,
 * 5 City bus, 6 Regional bus, 7 Coach, 8 Cable car, 9 Boat, 10 Transit on demand, 11 Other,
 * 12 Airplane. Unknown/other codes fall back to "other" so a new class never breaks rendering.
 */
export function modeFromProductClass(cls: number | null | undefined): TransitMode {
  switch (cls) {
    case 0: // Train (Enterprise / intercity)
    case 1: // Commuter railway (NI Railways)
    case 2: // Underground
    case 3: // City rail
      return "rail";
    case 4: // Tram / light rail (Glider BRT)
      return "tram";
    case 5: // City bus (Metro)
    case 6: // Regional bus (Ulsterbus / Goldline)
    case 7: // Coach
      return "bus";
    case 9: // Boat
      return "ferry";
    default: // 8 Cable car, 10 on-demand, 11 Other, 12 Airplane, unknown
      return "other";
  }
}

/** A public-transport stop near the query point. */
export interface TransitStop {
  /** EFA stop id — opaque, passed straight back into the Departure-Monitor request. */
  id: string;
  /** Human-readable stop name (disassembled/short name preferred, full name as fallback). */
  name: string;
  lat: number;
  lng: number;
  /** Metres from the query point, if EFA (or our haversine fallback) could determine it. */
  distanceM: number | null;
}

/** One upcoming departure from a stop. */
export interface Departure {
  /** Public line/route label, e.g. "1A", "Glider G1", "Enterprise". */
  line: string;
  /** Where it's headed (the headsign/destination name). */
  destination: string;
  mode: TransitMode;
  /** Scheduled departure time, ISO 8601. */
  plannedTime: string;
  /** Realtime-adjusted departure time, ISO 8601, or null when no realtime estimate exists. */
  expectedTime: string | null;
  /** Whole-minute delay (estimated − planned); null when there's no realtime estimate. */
  delayMin: number | null;
  /** True iff a realtime estimate was present (drives a "live" indicator in the UI). */
  realtime: boolean;
}

/** Narrowing helper: a plain-object guard that keeps the parsers readable. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Read a WGS84 coordinate out of an EFA location. rapidJSON encodes `coord` as a two-element
 * array; Translink emits it [lat, lng]. Returns null if it isn't a usable pair.
 */
function readCoord(loc: Record<string, unknown>): { lat: number; lng: number } | null {
  const coord = loc.coord;
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const lat = asNumber(coord[0]);
  const lng = asNumber(coord[1]);
  if (lat === null || lng === null) return null;
  return { lat, lng };
}

/**
 * Parse an EFA CoordInfo (XML_COORD_REQUEST) rapidJSON response into our stop rows, nearest
 * first. `origin` is the query point, used to backfill distance when EFA doesn't supply one.
 * Tolerant of missing/mistyped fields: anything unparseable is skipped rather than thrown.
 */
export function parseCoordStops(
  json: unknown,
  origin: { lat: number; lng: number },
): TransitStop[] {
  if (!isRecord(json)) return [];
  const locations = json.locations;
  if (!Array.isArray(locations)) return [];

  const stops: TransitStop[] = [];
  for (const raw of locations) {
    if (!isRecord(raw)) continue;
    const coord = readCoord(raw);
    if (!coord) continue;
    // Per the spec, address a stop by its `id` — but when isGlobalId=true the id to feed back
    // into the Departure-Monitor is `properties.stopID`. Prefer that when present.
    const props = isRecord(raw.properties) ? raw.properties : {};
    const id =
      raw.isGlobalId === true && asString(props.stopID) ? asString(props.stopID) : asString(raw.id);
    if (!id) continue;
    const name =
      asString(raw.disassembledName) ?? asString(raw.name) ?? "Stop";
    // EFA puts distance under `properties.distance` (metres); fall back to haversine.
    const efaDistance = asNumber(props.distance);
    const distanceM =
      efaDistance !== null ? efaDistance : Math.round(distanceMetres(origin, coord));
    stops.push({ id, name, lat: coord.lat, lng: coord.lng, distanceM });
  }
  // Nearest first (stable). EFA usually returns them ordered, but don't rely on it.
  stops.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
  return stops;
}

/** The nearest stop from a parsed set, or null when there are none. */
export function nearestStop(stops: readonly TransitStop[]): TransitStop | null {
  return stops[0] ?? null;
}

/**
 * Pull the destination/headsign out of an EFA `transportation` object. EFA has moved this
 * field around across versions — try the common shapes (`destination.name`, then a couple of
 * flat fallbacks) so we survive a Translink schema tweak without a redeploy.
 */
function readDestination(transportation: Record<string, unknown>): string {
  const dest = transportation.destination;
  if (isRecord(dest)) {
    const n = asString(dest.name);
    if (n) return n;
  }
  return (
    asString(transportation.destinationText) ??
    asString((transportation as { direction?: unknown }).direction) ??
    "—"
  );
}

/**
 * Parse an EFA timestamp to epoch ms. EFA emits UTC ISO 8601 — but if a value ever arrives
 * WITHOUT a timezone designator, we must treat it as UTC (append `Z`) rather than let Date.parse
 * read it as the server's local time. Otherwise every absolute "due in N min" would be off by the
 * viewer's UTC offset (e.g. one hour during BST). Returns NaN for an unparseable value.
 */
export function parseEfaTime(iso: string): number {
  const hasTz = /[zZ]$/.test(iso) || /[+-]\d{2}:?\d{2}$/.test(iso);
  return Date.parse(hasTz ? iso : `${iso}Z`);
}

/** Effective departure epoch ms (realtime estimate if present); NaN times sink to the end. */
function effectiveMs(d: Departure): number {
  const ms = parseEfaTime(d.expectedTime ?? d.plannedTime);
  return Number.isNaN(ms) ? Infinity : ms;
}

/** Whole-minute difference between two ISO timestamps, or null if either is unusable. */
function minutesBetween(planned: string, estimated: string | null): number | null {
  if (!estimated) return null;
  const p = parseEfaTime(planned);
  const e = parseEfaTime(estimated);
  if (Number.isNaN(p) || Number.isNaN(e)) return null;
  return Math.round((e - p) / 60_000);
}

/**
 * Parse an EFA Departure-Monitor (XML_DM_REQUEST) rapidJSON response into our departure rows,
 * in the order EFA returns them (soonest first), capped at MAX_DEPARTURES. Tolerant: a
 * stopEvent missing its planned time is skipped; everything else degrades to a sensible
 * default rather than throwing.
 */
export function parseDepartures(json: unknown): Departure[] {
  if (!isRecord(json)) return [];
  const events = json.stopEvents;
  if (!Array.isArray(events)) return [];

  const out: Departure[] = [];
  for (const raw of events) {
    if (!isRecord(raw)) continue;
    const plannedTime = asString(raw.departureTimePlanned);
    if (!plannedTime) continue; // a departure with no scheduled time is not renderable

    const expectedTime = asString(raw.departureTimeEstimated);
    const transportation = isRecord(raw.transportation) ? raw.transportation : {};
    const product = isRecord(transportation.product) ? transportation.product : {};

    const line =
      asString(transportation.number) ??
      asString(transportation.name) ??
      asString(transportation.disassembledName) ??
      "—";

    out.push({
      line,
      destination: readDestination(transportation),
      mode: modeFromProductClass(asNumber(product.class)),
      plannedTime,
      expectedTime,
      delayMin: minutesBetween(plannedTime, expectedTime),
      realtime: expectedTime !== null,
    });
  }
  // EFA returns these soonest-first, but sort defensively so a mis-ordered response can't render
  // out of sequence — then cap. (We already request only MAX_DEPARTURES via the DM `limit`.)
  out.sort((a, b) => effectiveMs(a) - effectiveMs(b));
  return out.slice(0, MAX_DEPARTURES);
}
