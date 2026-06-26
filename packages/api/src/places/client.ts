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

/** The Places (New) Place Details endpoint base — GET …/v1/places/{PLACE_ID}. */
const PLACE_DETAILS_BASE = "https://places.googleapis.com/v1/places/";

/**
 * The Place Details field mask for the PHOTO BACKFILL — `id,photos` and nothing else.
 * Details uses BARE field names (no `places.` prefix, unlike searchNearby). This is the
 * cost lever: we ask only for the photo pointers a venue is missing, so a one-time
 * backfill of photoless venues stays as cheap as Places allows.
 */
const DETAILS_PHOTOS_FIELD_MASK = "id,photos";

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

/**
 * Fetch a single place's photos via Place Details (New), by its stored Places id. Used by
 * the one-time photo backfill (scripts/backfill-photos): venues whose category was ingested
 * before photo support existed have a `source_ref` but no photo rows, and the freshness
 * guard makes a normal re-ingest skip them — so we re-pull their photos directly here.
 *
 * Returns the raw PlaceResult (mapped to our rows by core's placePhotos in the caller).
 * Throws on a transport/HTTP failure so the backfill can record and skip that one venue;
 * a place that simply has no photos is NOT an error (its photos[] is absent/empty).
 */
export async function getPlaceDetails(
  placeId: string,
  apiKey: string,
  fetchImpl: FetchImpl = fetch,
): Promise<places.PlaceResult> {
  const res = await fetchImpl(`${PLACE_DETAILS_BASE}${encodeURIComponent(placeId)}`, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": DETAILS_PHOTOS_FIELD_MASK,
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
      `Places getPlaceDetails(${placeId}) failed: ${res.status} ${res.statusText} — ${detail.slice(0, 300)}`,
    );
  }

  // Details returns the place object directly (not wrapped in a `places` array).
  return (await res.json()) as places.PlaceResult;
}
