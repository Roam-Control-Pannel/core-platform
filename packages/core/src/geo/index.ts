/**
 * Geo / proximity — global by construction. Pure functions.
 *
 * The database does the heavy lifting (PostGIS GiST index for near→far queries),
 * but these helpers exist for client-side distance display, sorting already-fetched
 * results, and the geofence/proximity decisions that are logic rather than queries.
 *
 * No region assumptions anywhere — haversine works identically on every point on
 * Earth, which is the whole point of "global from day one".
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Great-circle distance between two points in metres (haversine).
 * Accurate worldwide; no projection, no datum assumptions.
 *
 * example: same point -> 0
 * example: ~1 degree of latitude -> ~111_000 m
 */
export function distanceMetres(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Human-friendly distance string. Metric; localisation of units is a UI concern. */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/**
 * Sort items near→far from an origin. Stable for equal distances.
 * Generic so it works on venues, plan stops, anything with a coordinate.
 */
export function sortByProximity<T>(
  origin: LatLng,
  items: readonly T[],
  getCoord: (item: T) => LatLng,
): T[] {
  return items
    .map((item, i) => ({ item, i, d: distanceMetres(origin, getCoord(item)) }))
    .sort((x, y) => x.d - y.d || x.i - y.i)
    .map(({ item }) => item);
}

/**
 * Is a point within `radiusMetres` of a centre? The primitive behind
 * "friends nearby" and geofenced proximity — kept coarse and privacy-respecting
 * (callers should never broadcast precise coordinates, only proximity booleans).
 */
export function isWithin(
  centre: LatLng,
  point: LatLng,
  radiusMetres: number,
): boolean {
  return distanceMetres(centre, point) <= radiusMetres;
}
