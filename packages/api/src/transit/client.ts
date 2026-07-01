/**
 * Translink Opendata (EFA Intermodal Journey Planner) client — the outbound live calls.
 *
 * WHERE THIS LIVES (and why not core): like the Places client, this is runtime I/O carrying a
 * secret API key, so it cannot live in @roam/core (transport-agnostic by law). The PURE parts —
 * the geofence, the rapidJSON parsers, the mode mapping — live in @roam/core/transit and are
 * reused by the caller, not reimplemented here. This module only builds the two EFA requests,
 * performs the fetch, and hands the raw JSON back for the core parsers to interpret.
 *
 * TWO ENDPOINTS back "nearby departures":
 *   1. CoordInfo (XML_COORD_REQUEST) — nearest STOP(s) to a coordinate.
 *   2. Departure-Monitor (XML_DM_REQUEST) — the live board for one stop id.
 * Both return rapidJSON and both carry the key.
 *
 * THE KEY is injected through a single `EfaAuth` value (query-param OR header). Translink's
 * licence email states which form your key takes; that is the ONLY thing that changes between
 * the two, so it is isolated here — flip `mode` and nothing else moves. The key itself is read
 * from env at the call boundary (server-only) and passed in, never read from process.env here,
 * so this module stays a pure function of its arguments and is drivable with an injected fetch.
 */

/** Injectable fetch, so tests (and the guard) can drive this without a network or a key. */
export type FetchImpl = typeof fetch;

/**
 * How the API key rides on each request. `mode` is the swappable piece:
 *   - "query"  → appended to the URL as `?<name>=<value>` (the common EFA/Opendata form).
 *   - "header" → sent as the request header `<name>: <value>`.
 * `name` defaults (in loadEnv) to "key" for query and "Authorization" for header, both overridable.
 */
export interface EfaAuth {
  mode: "query" | "header";
  name: string;
  value: string;
}

/** EFA request configuration resolved from env once at boot. */
export interface EfaConfig {
  /** Base URL including the trailing path segment, e.g. http://opendata.translinkniplanner.co.uk/Ext_API/ */
  baseUrl: string;
  auth: EfaAuth;
}

const COORD_ENDPOINT = "XML_COORD_REQUEST";
const DM_ENDPOINT = "XML_DM_REQUEST";

/** EFA's WGS84 decimal-degrees format token, used for both input coords and output. */
const WGS84 = "WGS84[DD.ddddd]";

/** Join the base (with or without a trailing slash) to an endpoint name. */
function endpointUrl(baseUrl: string, endpoint: string): string {
  return baseUrl.endsWith("/") ? `${baseUrl}${endpoint}` : `${baseUrl}/${endpoint}`;
}

/** Apply the auth to a params/headers pair according to its mode. Returns the header bag. */
function applyAuth(auth: EfaAuth, params: URLSearchParams): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (auth.mode === "query") {
    params.set(auth.name, auth.value);
  } else {
    headers[auth.name] = auth.value;
  }
  return headers;
}

/** Run a GET against an EFA endpoint and return parsed JSON. Throws on transport/HTTP failure. */
async function efaGet(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchImpl,
): Promise<unknown> {
  const res = await fetchImpl(url, { method: "GET", headers });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      detail = "(no response body)";
    }
    throw new Error(
      `Translink EFA request failed: ${res.status} ${res.statusText} — ${detail.slice(0, 300)}`,
    );
  }
  return res.json();
}

/**
 * CoordInfo: find stops near a coordinate. Returns the raw rapidJSON for @roam/core's
 * parseCoordStops to interpret. Note EFA's `coord` is LNG:LAT order (not lat,lng).
 */
export async function fetchNearestStops(
  params: { lat: number; lng: number; radiusMetres: number; maxResults: number },
  config: EfaConfig,
  fetchImpl: FetchImpl = fetch,
): Promise<unknown> {
  const q = new URLSearchParams({
    outputFormat: "rapidJSON",
    coordOutputFormat: WGS84,
    // EFA expects longitude first in the coord triple.
    coord: `${params.lng}:${params.lat}:${WGS84}`,
    type_1: "STOP",
    radius_1: String(params.radiusMetres),
    inclFilter: "1",
    max: String(params.maxResults),
  });
  const headers = applyAuth(config.auth, q);
  return efaGet(`${endpointUrl(config.baseUrl, COORD_ENDPOINT)}?${q.toString()}`, headers, fetchImpl);
}

/**
 * Departure-Monitor: the live board for one stop id. Returns raw rapidJSON for @roam/core's
 * parseDepartures. `useRealtime=1` asks EFA for realtime-adjusted times where available.
 */
export async function fetchDepartures(
  params: { stopId: string; limit: number },
  config: EfaConfig,
  fetchImpl: FetchImpl = fetch,
): Promise<unknown> {
  const q = new URLSearchParams({
    outputFormat: "rapidJSON",
    coordOutputFormat: WGS84,
    mode: "direct",
    type_dm: "stop",
    name_dm: params.stopId,
    useRealtime: "1",
    limit: String(params.limit),
  });
  const headers = applyAuth(config.auth, q);
  return efaGet(`${endpointUrl(config.baseUrl, DM_ENDPOINT)}?${q.toString()}`, headers, fetchImpl);
}
