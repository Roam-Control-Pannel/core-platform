/**
 * Google Places API (New) client — the outbound fetch for on-demand venue supply.
 *
 * WHERE THIS LIVES (and why not core): like push/dispatch, this is Node/runtime I/O
 * (an https call carrying a secret API key), so it cannot live in @roam/core, which is
 * transport-agnostic by law. The PURE parts — the pill→types mapping and the
 * place→venue-row transform — DO live in core (@roam/core/places) and are reused here,
 * not reimplemented. This module adds no taxonomy logic; it is the searchNearby call:
 * build the request (with the cost-controlling field mask), parse the response into
 * core's PlaceResult[], and surface failures honestly.
 *
 * COST: the X-Goog-FieldMask header is the billing lever — Places (New) charges by the
 * field classes requested. We ask for exactly what a venue row needs (id, displayName,
 * location, types, formattedAddress, rating, businessStatus, regularOpeningHours) and nothing else.
 *
 * THE KEY is passed in (read from env at the call boundary, server-only) — never read
 * from process.env in here, so this module stays a pure function of its arguments and
 * is unit-testable with an injected fetch.
 */
import type { places } from "@roam/core";

/** The Places (New) searchNearby endpoint. */
const SEARCH_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";

/**
 * The field mask — the exact fields we read, and the cost lever. Each `places.*` entry
 * maps onto the PlaceResult shape in @roam/core/places. Adding a field here costs money
 * AND requires widening PlaceResult; keep them in lockstep.
 */
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.location",
  "places.types",
  "places.formattedAddress",
  "places.rating",
  "places.businessStatus",
  "places.regularOpeningHours",
  // BILLING: places.photos is a billable Places (New) field class (same caveat as
  // regularOpeningHours). Contained by the existing 2,000/day per-endpoint quota cap.
  "places.photos",
].join(",");

/** Inputs to one searchNearby call. */
export interface SearchNearbyParams {
  lat: number;
  lng: number;
  /** Places (New) included types for the category (from core categoryToPlacesTypes). */
  includedTypes: readonly string[];
  /** Search radius in metres. Places caps this at 50_000. */
  radiusMetres: number;
  /** Max results to return (Places caps at 20 per call). */
  maxResultCount: number;
}

/** Injectable fetch, so the unit test drives this without a network or a key. */
export type FetchImpl = typeof fetch;

/**
 * The raw searchNearby response we care about: a `places` array of PlaceResult-shaped
 * objects. Places returns `{}` (no `places` key) when nothing matches — handled as [].
 */
interface SearchNearbyResponse {
  places?: places.PlaceResult[];
}

/**
 * Call Places (New) searchNearby for a category near a point. Returns the raw
 * PlaceResult[] (classification + row-mapping happen in the caller via core). Throws on
 * a transport/HTTP failure so the procedure can surface that the fetch did not run; an
 * empty match set is NOT an error (returns []).
 */
export async function searchNearby(
  params: SearchNearbyParams,
  apiKey: string,
  fetchImpl: FetchImpl = fetch,
): Promise<places.PlaceResult[]> {
  const body = {
    includedTypes: [...params.includedTypes],
    maxResultCount: params.maxResultCount,
    locationRestriction: {
      circle: {
        center: { latitude: params.lat, longitude: params.lng },
        radius: params.radiusMetres,
      },
    },
  };

  const res = await fetchImpl(SEARCH_NEARBY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // Read the body best-effort for a useful message; never throw inside the catch.
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      detail = "(no response body)";
    }
    throw new Error(
      `Places searchNearby failed: ${res.status} ${res.statusText} — ${detail.slice(0, 300)}`,
    );
  }

  const json = (await res.json()) as SearchNearbyResponse;
  return json.places ?? [];
}
