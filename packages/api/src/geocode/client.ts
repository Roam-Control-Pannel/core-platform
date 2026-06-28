/**
 * OpenStreetMap Nominatim geocoding client — the outbound fetch for place search.
 *
 * WHERE THIS LIVES (and why not core): like the Places client and push, this is Node/runtime
 * I/O (an https call). @roam/core stays transport-agnostic, so it owns only the PURE parse
 * (geocode.parseNominatim); this module does the call and hands the raw JSON to that parser.
 *
 * PROVIDER POLICY: Nominatim is free and key-less (the same posture as our OSM map tiles),
 * but its usage policy REQUIRES an identifying User-Agent and discourages heavy traffic. So
 * the call is made SERVER-SIDE with a fixed UA (never from the browser, which can't set one),
 * and the router in front caches results — an interactive search box must not hammer it. A
 * paid/self-hosted geocoder later swaps in here without touching core or the web.
 */
import { geocode as coreGeocode } from "@roam/core";

const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";

/** Identifies the app to Nominatim per its usage policy. */
const USER_AGENT = "Roam/0.1 (+https://roam-everywhere.com)";

/** How many results we ask for (and cap to). A short, scannable list. */
const SEARCH_LIMIT = 6;

/** Injectable fetch so the unit test drives this without a network. */
export type FetchImpl = typeof fetch;

/**
 * Geocode a free-text query (town name or postcode) to selectable place centres. Returns the
 * parsed, de-duplicated results (possibly empty). Throws on a transport/HTTP failure so the
 * procedure can surface that the lookup did not run; an empty match set is NOT an error.
 */
export async function geocodeSearch(
  query: string,
  fetchImpl: FetchImpl = fetch,
): Promise<coreGeocode.GeocodeResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    addressdetails: "1",
    limit: String(SEARCH_LIMIT),
  });

  const res = await fetchImpl(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      // Nominatim also accepts Referer for identification; harmless to include.
      Referer: "https://roam-everywhere.com",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      detail = "(no response body)";
    }
    throw new Error(
      `Nominatim search failed: ${res.status} ${res.statusText} — ${detail.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as unknown;
  return coreGeocode.parseNominatim(json, SEARCH_LIMIT);
}
