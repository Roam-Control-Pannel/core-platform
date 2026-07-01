/**
 * transitRegion — a LOCAL mirror of @roam/core/transit's NI geofence (+ the attribution string).
 *
 * The web app cannot import @roam/core (architecture law), so the tiny pure check that decides
 * whether to even render the "Nearby departures" card lives here, mirroring core's isWithinNI
 * exactly (same coarse bounding box). Keeping it client-side means we never POST /api/transit
 * for a place that obviously isn't in Northern Ireland — the server geofences again as the real
 * gate; this is just the cheap "should we ask?" filter. If core's box ever moves, move it here
 * too (same discipline as lib/openNow.ts mirroring core/hours).
 */

/** Coarse Northern Ireland bounding box — MUST match @roam/core/transit's NI_BOUNDS. */
const NI_BOUNDS = { minLat: 53.95, maxLat: 55.35, minLng: -8.35, maxLng: -5.35 } as const;

/** Is a point inside Translink's NI service territory (coarse box)? Mirrors core.isWithinNI. */
export function isWithinNI(lat: number, lng: number): boolean {
  return (
    lat >= NI_BOUNDS.minLat &&
    lat <= NI_BOUNDS.maxLat &&
    lng >= NI_BOUNDS.minLng &&
    lng <= NI_BOUNDS.maxLng
  );
}

/** Licence-required credit, mirrored from core.TRANSLINK_ATTRIBUTION (the server sends it too). */
export const TRANSLINK_ATTRIBUTION = "Transport Information supplied by Translink Opendata API";
