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
 * THE KEY — auth is SELF-TUNING. Translink's licence dictates whether the key rides as a query
 * param or an HTTP header, and that wasn't unambiguous in the spec, so rather than force a guess
 * we try the configured mode first and, if Translink rejects it with an auth status (401/403/407),
 * automatically retry in the OTHER mode. The mode that works is PINNED for the rest of the
 * process, so it's a one-time cost. Which mode won is logged once, so the deploy logs tell us the
 * answer definitively — then we can set TRANSLINK_AUTH_MODE explicitly to skip the probing.
 *
 * The key itself is read from env at the call boundary (server-only) and passed in via EfaConfig,
 * never read from process.env here, so the module stays drivable with an injected fetch.
 */

/** Injectable fetch, so tests (and the guard) can drive this without a network or a key. */
export type FetchImpl = typeof fetch;

/**
 * How the API key rides on one request. `mode` selects query-param vs header; `name` is the
 * param/header name; `value` is the key. Two of these live on a config (primary + fallback) so
 * the client can auto-detect which Translink accepts.
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
  /** Primary auth injection (the configured mode). Tried first. */
  auth: EfaAuth;
  /** Alternate auth injection (the opposite mode), tried if the primary is auth-rejected. */
  authFallback?: EfaAuth | null;
  /** When true, log the raw (truncated) EFA JSON so a deploy can confirm the real response shape. */
  debug?: boolean;
}

const COORD_ENDPOINT = "XML_COORD_REQUEST";
const DM_ENDPOINT = "XML_DM_REQUEST";

/** EFA's WGS84 decimal-degrees format token, used for both input coords and output. */
const WGS84 = "WGS84[DD.ddddd]";

/** Auth statuses that should trigger the fallback mode (vs a genuine upstream error). */
const AUTH_REJECT_STATUSES = new Set([401, 403, 407]);

/**
 * Fail-fast timeout for an EFA call. Translink's endpoint answers in well under a second when
 * reachable; a longer wait means the connection is being dropped (e.g. our egress IP isn't on
 * Translink's allowlist), which surfaces as UND_ERR_CONNECT_TIMEOUT. Capping it here means the
 * card gives up quickly and self-hides instead of hanging on undici's ~10s default.
 */
const EFA_TIMEOUT_MS = 7_000;

/**
 * Which auth mode Translink has accepted this process. Once set, it's tried first on every
 * subsequent call, so the fallback probe is a one-time cost. Module-level because there is one
 * Translink config per process.
 */
let pinnedMode: "query" | "header" | null = null;

/** Guard so the egress-IP probe logs at most once per process (it's a diagnostic, not per-call). */
let egressLogged = false;

/**
 * Best-effort: log THIS service's public egress IP, so we know exactly what to register on
 * Translink's allowlist. Uses a neutral IP-echo (not allowlisted, so it actually answers, unlike
 * Translink). Debug-gated, once per process, swallows all errors — purely diagnostic.
 */
async function logEgressIp(): Promise<void> {
  if (egressLogged) return;
  egressLogged = true;
  try {
    const res = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { ip?: string };
    if (data.ip) {
      console.log(
        `[transit] this service's public egress IP is ${data.ip} — register THIS IP on ` +
          `Translink's Opendata allowlist (the connect timeout means they're dropping it).`,
      );
    }
  } catch {
    /* diagnostic only — never let it affect the request */
  }
}

/** Join the base (with or without a trailing slash) to an endpoint name. */
function endpointUrl(baseUrl: string, endpoint: string): string {
  return baseUrl.endsWith("/") ? `${baseUrl}${endpoint}` : `${baseUrl}/${endpoint}`;
}

/** The auth attempts to try, in order — pinned mode first (if any), then primary, then fallback. */
function orderedAuths(config: EfaConfig): EfaAuth[] {
  const list: EfaAuth[] = [config.auth];
  if (config.authFallback) list.push(config.authFallback);
  if (pinnedMode) {
    list.sort((a, b) => (a.mode === pinnedMode ? -1 : 0) - (b.mode === pinnedMode ? -1 : 0));
  }
  return list;
}

/**
 * Execute an EFA GET with self-tuning auth. Tries each auth mode until one is accepted; an
 * auth-status rejection (401/403/407) falls through to the next mode, any other non-2xx throws
 * immediately (it's a real upstream error, not a wrong key placement). Returns parsed JSON.
 */
async function efaRequest(
  endpoint: string,
  baseParams: Record<string, string>,
  config: EfaConfig,
  fetchImpl: FetchImpl,
): Promise<unknown> {
  const attempts = orderedAuths(config);
  let lastError: Error | null = null;

  for (const auth of attempts) {
    const params = new URLSearchParams(baseParams);
    const headers: Record<string, string> = { accept: "application/json" };
    if (auth.mode === "query") params.set(auth.name, auth.value);
    else headers[auth.name] = auth.value;

    const url = `${endpointUrl(config.baseUrl, endpoint)}?${params.toString()}`;

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "GET",
        headers,
        // Fail fast on a dropped/blocked connection rather than hanging on the default.
        signal: AbortSignal.timeout(EFA_TIMEOUT_MS),
      });
    } catch (e) {
      // Transport failure (DNS/timeout/egress). Not an auth issue — don't burn the other mode on
      // it. A connect timeout here most often means Translink is dropping our egress IP (their
      // fair-use registration is IP-allowlisted), not a bug in the request.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[transit] EFA ${endpoint} transport error (auth='${auth.mode}'): ${msg}`);
      // On a transport failure in debug mode, surface our egress IP so it can be allowlisted.
      if (config.debug) void logEgressIp();
      throw e instanceof Error ? e : new Error(msg);
    }

    if (res.ok) {
      if (pinnedMode !== auth.mode) {
        pinnedMode = auth.mode;
        console.log(
          `[transit] EFA auth accepted — mode='${auth.mode}' name='${auth.name}'. ` +
            `Set TRANSLINK_AUTH_MODE='${auth.mode}' to pin it and skip probing.`,
        );
      }
      const json: unknown = await res.json();
      if (config.debug) {
        console.log(`[transit] raw ${endpoint} (${auth.mode}):`, JSON.stringify(json).slice(0, 900));
      }
      return json;
    }

    const body = await res.text().catch(() => "");
    if (AUTH_REJECT_STATUSES.has(res.status) && attempts.length > 1) {
      console.warn(
        `[transit] EFA auth rejected mode='${auth.mode}' (${res.status} ${res.statusText}); ` +
          `trying next mode. ${body.slice(0, 160)}`,
      );
      lastError = new Error(`${res.status} ${res.statusText}`);
      continue; // try the next auth mode
    }

    // A non-auth failure (or no fallback left): this is a real upstream error.
    throw new Error(
      `Translink EFA ${endpoint} failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`,
    );
  }

  throw lastError ?? new Error(`Translink EFA ${endpoint} failed: all auth modes exhausted`);
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
  return efaRequest(
    COORD_ENDPOINT,
    {
      outputFormat: "rapidJSON",
      coordOutputFormat: WGS84,
      // EFA expects longitude first in the coord triple.
      coord: `${params.lng}:${params.lat}:${WGS84}`,
      type_1: "STOP",
      radius_1: String(params.radiusMetres),
      inclFilter: "1",
      max: String(params.maxResults),
    },
    config,
    fetchImpl,
  );
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
  return efaRequest(
    DM_ENDPOINT,
    {
      outputFormat: "rapidJSON",
      coordOutputFormat: WGS84,
      mode: "direct",
      type_dm: "stop",
      name_dm: params.stopId,
      useRealtime: "1",
      limit: String(params.limit),
    },
    config,
    fetchImpl,
  );
}
