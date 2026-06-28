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

/** Address-ish keys, broad → broadest, that compose the region hint (after the name). */
const REGION_KEYS = ["city", "district", "county", "state", "country"] as const;

function clean(s: string | undefined): string {
  return (s ?? "").trim();
}

/**
 * Map a raw Photon GeoJSON FeatureCollection into our minimal results: a concise name + a
 * region hint + coordinates, de-duplicated by location and capped. Pure; tolerant of missing
 * fields. Accepts either the FeatureCollection object or its `features` array directly.
 *
 * Naming: prefer the feature `name` (Photon's primary label), else the postcode, else the
 * city. The hint is the broader place parts (city/county/state/country) minus the name.
 */
export function parsePhoton(raw: unknown, limit = 6): GeocodeResult[] {
  const features: unknown =
    Array.isArray(raw) ? raw : (raw as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];

  const out: GeocodeResult[] = [];
  const seen = new Set<string>();

  for (const f of features as PhotonFeature[]) {
    const coords = f?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const p = f?.properties ?? {};
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
