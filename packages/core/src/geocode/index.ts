/**
 * Geocoding — turn a typed query (a town name or a postcode) into selectable place centres.
 *
 * This module is PURE: it owns the SHAPE of a geocode result and the mapping from a raw
 * provider response into our minimal result, with NO network of its own. The actual HTTP
 * call lives in the api layer (geocode/client.ts), exactly like places searchNearby — so
 * the messy display-name normalization is unit-testable without a network, and swapping the
 * provider later (a paid geocoder, a self-hosted Nominatim) only touches the api client.
 *
 * Provider: OpenStreetMap Nominatim (free, no key) — the same no-cost, no-key posture as the
 * Leaflet/OSM map tiles. Its `jsonv2` result is what parseNominatim consumes.
 */

/** A selectable place centre returned from a geocode lookup. Mirrors the web `Place` shape
 *  (id/name/hint/lat/lng) so a result drops straight into the place switcher. */
export interface GeocodeResult {
  /** Stable id derived from the OSM object (so React keys + de-dup are stable). */
  id: string;
  /** Concise primary label, e.g. "Darlington", "Westminster", "DL1 1AA". */
  name: string;
  /** Region sublabel, e.g. "County Durham" / "Greater London, England". */
  hint?: string;
  lat: number;
  lng: number;
}

/** The Nominatim jsonv2 fields we read. Everything is optional — providers are untrusted. */
export interface NominatimItem {
  place_id?: number | string;
  osm_type?: string;
  osm_id?: number | string;
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  address?: Record<string, string> | undefined;
}

/** Address keys, most-specific → least, that can serve as the primary locality label. */
const PRIMARY_KEYS = [
  "city",
  "town",
  "village",
  "suburb",
  "neighbourhood",
  "hamlet",
  "municipality",
  "county",
] as const;

/** Address keys, broad → broadest, that compose the region hint. */
const REGION_KEYS = ["county", "state_district", "state", "country"] as const;

function clean(s: string | undefined): string {
  return (s ?? "").trim();
}

/**
 * Map a raw Nominatim jsonv2 array into our minimal results: a concise name + a region hint
 * + coordinates, de-duplicated by location and capped. Pure; tolerant of missing fields.
 *
 * Naming: prefer the structured address (so "Westminster, London" reads as name "Westminster"
 * / hint "Greater London, England") and fall back to slicing display_name on commas when no
 * address detail is present. A postcode query yields the postcode as the name.
 */
export function parseNominatim(raw: unknown, limit = 6): GeocodeResult[] {
  if (!Array.isArray(raw)) return [];
  const out: GeocodeResult[] = [];
  const seen = new Set<string>();

  for (const item of raw as NominatimItem[]) {
    const lat = Number.parseFloat(clean(item?.lat));
    const lng = Number.parseFloat(clean(item?.lon));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const addr = item?.address ?? {};
    const display = clean(item?.display_name);
    const displayParts = display ? display.split(",").map((p) => p.trim()).filter(Boolean) : [];

    // Primary label: a structured locality, else the explicit name, else the first
    // display_name segment (which is the postcode for a postcode search).
    let name = "";
    for (const k of PRIMARY_KEYS) {
      if (clean(addr[k])) {
        name = clean(addr[k]);
        break;
      }
    }
    if (!name) name = clean(item?.name) || displayParts[0] || "";
    if (addr["postcode"] && !name) name = clean(addr["postcode"]);
    if (!name) continue;

    // Region hint: broad address parts, minus the primary label, de-duped and joined.
    const regionBits: string[] = [];
    for (const k of REGION_KEYS) {
      const v = clean(addr[k]);
      if (v && v !== name && !regionBits.includes(v)) regionBits.push(v);
    }
    // Fall back to the tail of display_name when there's no structured address.
    if (regionBits.length === 0 && displayParts.length > 1) {
      for (const p of displayParts.slice(1)) {
        if (p && p !== name && !regionBits.includes(p)) regionBits.push(p);
        if (regionBits.length >= 2) break;
      }
    }
    const hint = regionBits.slice(0, 2).join(", ");

    // De-dup by ~100m grid so a town centre and its bounding-box twin don't both show.
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const id =
      item?.osm_type && item?.osm_id != null
        ? `geo:${item.osm_type}${item.osm_id}`
        : `geo:${item?.place_id ?? key}`;

    out.push(hint ? { id, name, hint, lat, lng } : { id, name, lat, lng });
    if (out.length >= limit) break;
  }

  return out;
}
