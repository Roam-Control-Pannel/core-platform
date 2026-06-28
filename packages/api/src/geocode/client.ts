/**
 * Photon geocoding client — the outbound fetch for place search.
 *
 * WHERE THIS LIVES (and why not core): like the Places client and push, this is Node/runtime
 * I/O (an https call). @roam/core stays transport-agnostic, so it owns only the PURE parse
 * (geocode.parsePhoton); this module does the call and hands the raw JSON to that parser.
 *
 * PROVIDER: Photon (photon.komoot.io) — free, key-less, OpenStreetMap-based, built for
 * autocomplete. Chosen over Nominatim's public instance because that one blocks datacenter
 * IPs (our api runs on one) — the same no-cost/no-key posture as our OSM map tiles. A paid or
 * self-hosted geocoder later swaps in here without touching core or the web. We still send an
 * identifying User-Agent (good manners) and the router in front caches results.
 */
import { geocode as coreGeocode } from "@roam/core";

const PHOTON_SEARCH_URL = "https://photon.komoot.io/api";

/** Identifies the app to the provider. */
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
    limit: String(SEARCH_LIMIT),
    lang: "en",
  });

  const res = await fetchImpl(`${PHOTON_SEARCH_URL}?${params.toString()}`, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
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
      `Photon search failed: ${res.status} ${res.statusText} — ${detail.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as unknown;
  return coreGeocode.parsePhoton(json, SEARCH_LIMIT);
}
