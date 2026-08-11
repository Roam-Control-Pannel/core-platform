/**
 * Geocoding — turn a typed query (a town name or a postcode) into selectable place centres.
 *
 * This module is PURE: it owns the SHAPE of a geocode result and the mapping from a raw
 * provider response into our minimal result, with NO network of its own. The actual HTTP
 * call lives in the api layer (geocode/client.ts), exactly like places searchNearby — so
 * the messy display normalization is unit-testable without a network, and swapping the
 * provider only touches the api client + the parser here.
 *
 * Provider: Photon (photon.komoot.io) — a free, key-less, OpenStreetMap-based geocoder built
 * for autocomplete. We use it over Nominatim's public instance because that one blocks
 * datacenter IPs (our api runs on one), which is the same no-cost/no-key posture as the
 * Leaflet/OSM map tiles. Photon returns a GeoJSON FeatureCollection; parsePhoton consumes it.
 */

/** A selectable place centre returned from a geocode lookup. Mirrors the web `Place` shape
 *  (id/name/hint/lat/lng) so a result drops straight into the place switcher. */
export interface GeocodeResult {
  /** Stable id derived from the OSM object (so React keys + de-dup are stable). */
  id: string;
  /** Concise primary label, e.g. "Darlington", "Westminster", "DH1 1AA". */
  name: string;
  /** Region sublabel, e.g. "County Durham, England". */
  hint?: string;
  lat: number;
  lng: number;
}

/** The Photon feature fields we read. Everything is optional — providers are untrusted. */
export interface PhotonFeature {
  geometry?: { coordinates?: [number, number] | number[] } | undefined;
  properties?:
    | {
        osm_id?: number | string;
        osm_type?: string;
        /** OSM tag of the matched object, e.g. "place"/"city", "boundary"/"administrative". */
        osm_key?: string;
        osm_value?: string;
        /** Photon's normalized kind: city/town/village/locality/district/street/house/… */
        type?: string;
        name?: string;
        postcode?: string;
        street?: string;
        district?: string;
        city?: string;
        county?: string;
        state?: string;
        country?: string;
      }
    | undefined;
}

/**
 * How suitable a Photon feature is as a BROWSE CENTRE, higher = better. A populated-place NODE
 * (place=city/town/…) is anchored by OSM at the settlement's centre, so it's the best centre. An
 * administrative BOUNDARY resolves to the boundary centroid, which for a city with an asymmetric
 * boundary can sit well off the civic centre (Liverpool's centroid lands ~2 km SE, in Wavertree),
 * so it ranks below the node. Streets/houses/other POIs that merely share the name rank lowest.
 * Signals come from either the OSM tag (osm_key/osm_value) or Photon's normalized `type`. Used
 * ONLY to order candidates — it never changes a result's coordinate.
 */
function placeRank(f: PhotonFeature): number {
  const p = f?.properties ?? {};
  const key = clean(p.osm_key).toLowerCase();
  const value = clean(p.osm_value).toLowerCase();
  const type = clean(p.type).toLowerCase();

  const isPlace = key === "place";
  if (isPlace && (value === "city" || value === "town" || value === "borough")) return 100;
  if (type === "city" || type === "town") return 95;
  if (isPlace && (value === "village" || value === "suburb" || value === "municipality" || value === "township")) return 80;
  if (type === "village" || type === "suburb" || type === "district" || type === "locality") return 75;
  if (isPlace) return 70; // some other place=*
  if (key === "boundary") return 40; // admin boundary centroid — can miss the civic centre
  if (type === "street" || type === "house") return 10;
  return 30; // unknown / other
}

/** Address-ish keys, broad → broadest, that compose the region hint (after the name). */
const REGION_KEYS = ["city", "district", "county", "state", "country"] as const;

function clean(s: string | undefined): string {
  return (s ?? "").trim();
}

/* ── Geographic scoping (per-channel region fences) ─────────────────────────────────────────
 *
 * A channel can be fenced to a region so its place search only returns places INSIDE it — the
 * NI Food to Go storefront (f2g) must never surface Great-Britain or Republic-of-Ireland places.
 * Northern Ireland is the one region we model today; the shape is generic so more can be added.
 */

/** A lat/lng bounding box (inclusive). */
export interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * Northern Ireland's bounding box. Chosen to include every NI settlement (Belfast, the north
 * coast/Rathlin ~55.3°N, the Ards Peninsula ~-5.43°E, Fermanagh ~-8.2°W, Carlingford ~54.05°N)
 * while EXCLUDING Great Britain: the eastern edge (-5.30) sits west of the closest GB points
 * (Portpatrick ~-5.12, the Isle of Man ~-4.5). The box still overlaps the border with the
 * Republic of Ireland, so the box alone is not a sufficient NI test — `isNorthernIreland`
 * combines it with country/postcode signals to exclude ROI towns (Letterkenny, Monaghan…).
 */
export const NI_BOUNDS: GeoBounds = { minLat: 54.0, maxLat: 55.45, minLng: -8.3, maxLng: -5.3 };

/** Whether a coordinate falls inside a bounding box (inclusive). */
export function inBounds(lat: number, lng: number, b: GeoBounds): boolean {
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

/** Country labels Photon returns for the Republic of Ireland — never Northern Ireland. */
const ROI_COUNTRIES = new Set(["ireland", "éire", "eire", "republic of ireland"]);

/**
 * Whether a Photon feature is in Northern Ireland. Layered signals, strongest first:
 *   1. Postcode starts with "BT" — NI's postcode area, definitive and unique to NI.
 *   2. Country is the Republic of Ireland — definitively NOT NI (excludes border towns that
 *      share the bounding box, e.g. Letterkenny/Monaghan/Dundalk).
 *   3. State is "Northern Ireland" — Photon's own admin label for NI.
 *   4. Backstop: a UK (or unlabelled) feature inside NI_BOUNDS. The box excludes Great Britain;
 *      the ROI guard above excludes the Republic — so what remains inside the box is NI.
 */
export function isNorthernIreland(
  p: NonNullable<PhotonFeature["properties"]>,
  lat: number,
  lng: number,
): boolean {
  const postcode = clean(p.postcode).toUpperCase();
  if (postcode.startsWith("BT")) return true;

  const country = clean(p.country).toLowerCase();
  if (ROI_COUNTRIES.has(country)) return false;

  const state = clean(p.state).toLowerCase();
  if (state.includes("northern ireland")) return true;

  const uk = country === "" || country.includes("united kingdom") || country === "uk";
  return uk && inBounds(lat, lng, NI_BOUNDS);
}

/** Region codes a geocode search can be fenced to. */
export type GeoRegion = "ni";

/** Options for parsePhoton. `region` drops any result outside that region. */
export interface ParsePhotonOptions {
  region?: GeoRegion;
}

/**
 * Map a raw Photon GeoJSON FeatureCollection into our minimal results: a concise name + a
 * region hint + coordinates, de-duplicated by location and capped. Pure; tolerant of missing
 * fields. Accepts either the FeatureCollection object or its `features` array directly.
 *
 * Naming: prefer the feature `name` (Photon's primary label), else the postcode, else the
 * city. The hint is the broader place parts (city/county/state/country) minus the name.
 */
export function parsePhoton(raw: unknown, limit = 6, opts: ParsePhotonOptions = {}): GeocodeResult[] {
  const features: unknown =
    Array.isArray(raw) ? raw : (raw as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];

  // Order candidates so the best browse centre leads: a settlement node above an admin-boundary
  // centroid above a name-sharing POI. Stable within a rank (index tiebreak), so Photon's own
  // relevance order is preserved for equally-ranked features and unranked queries are unchanged.
  const ordered = (features as PhotonFeature[])
    .map((f, i) => ({ f, i }))
    .sort((a, b) => placeRank(b.f) - placeRank(a.f) || a.i - b.i)
    .map((x) => x.f);

  const out: GeocodeResult[] = [];
  const seen = new Set<string>();

  for (const f of ordered) {
    const coords = f?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const p = f?.properties ?? {};

    // Region fence: drop anything outside the requested region (e.g. keep only NI places on the
    // Food to Go storefront). Applied before naming so a filtered feature costs nothing further.
    if (opts.region === "ni" && !isNorthernIreland(p, lat, lng)) continue;

    const name = clean(p.name) || clean(p.postcode) || clean(p.city);
    if (!name) continue;

    // Region hint: broader place parts, minus the primary label, de-duped.
    const regionBits: string[] = [];
    for (const k of REGION_KEYS) {
      const v = clean(p[k]);
      if (v && v !== name && !regionBits.includes(v)) regionBits.push(v);
    }
    // If we named by postcode, surface the postcode in the hint too (handled by name); for a
    // POI/street result, prepend the street so the row is distinguishable.
    const hint = regionBits.slice(0, 2).join(", ");

    // De-dup by ~100m grid so a place and its admin twin don't both show.
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const id =
      p.osm_type && p.osm_id != null ? `geo:${p.osm_type}${p.osm_id}` : `geo:${key}`;

    out.push(hint ? { id, name, hint, lat, lng } : { id, name, lat, lng });
    if (out.length >= limit) break;
  }

  return out;
}
