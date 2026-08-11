/**
 * Northern Ireland geography — the fence for the Food to Go Association storefront (f2g channel).
 *
 * The NI Food to Go Association operates ONLY across Northern Ireland, so the storefront must
 * never centre on — or let you search for — a Great-Britain or Republic-of-Ireland place. This
 * module is the browser-safe source of that fence: the bounding box, an in-box test, the curated
 * NI town centres the switcher suggests, and the default centre (Belfast).
 *
 * Why a mirror of the box and not an import from @roam/core: the web app is Node-ESM and does NOT
 * import @roam/core (same reason lib/channel.ts mirrors the Channel shape). The authoritative
 * copy — with the reasoning behind the numbers — lives in packages/core/src/geocode. The two are
 * intentionally identical; keep them in step. The SEARCH fence is enforced server-side by core
 * (BT-postcode / country signals exclude ROI border towns); this box is used client-side for the
 * cheap coordinate checks: validating "Use my location" and clamping a stray stored place.
 */
import type { Place } from "../components/PlaceSwitcher";

/** NI bounding box — includes every NI settlement, excludes Great Britain. See core/geocode. */
export const NI_BOUNDS = { minLat: 54.0, maxLat: 55.45, minLng: -8.3, maxLng: -5.3 } as const;

/** Whether a coordinate sits within Northern Ireland's bounding box. */
export function isInNI(lat: number, lng: number): boolean {
  return (
    lat >= NI_BOUNDS.minLat &&
    lat <= NI_BOUNDS.maxLat &&
    lng >= NI_BOUNDS.minLng &&
    lng <= NI_BOUNDS.maxLng
  );
}

/**
 * Curated NI town centres, the "suggested" places on the storefront switcher — the main towns
 * across the six counties, ordered by size/prominence. Coordinates are the civic centres. When a
 * places table lands these become rows; for now they mirror PlaceSwitcher's PLACES idiom.
 */
export const NI_PLACES: readonly Place[] = [
  { id: "ni-belfast", name: "Belfast", hint: "County Antrim", lat: 54.5973, lng: -5.9301 },
  { id: "ni-derry", name: "Derry/Londonderry", hint: "County Londonderry", lat: 54.9966, lng: -7.3086 },
  { id: "ni-lisburn", name: "Lisburn", hint: "County Antrim", lat: 54.5162, lng: -6.0581 },
  { id: "ni-newry", name: "Newry", hint: "County Down", lat: 54.1751, lng: -6.3402 },
  { id: "ni-bangor", name: "Bangor", hint: "County Down", lat: 54.6538, lng: -5.6683 },
  { id: "ni-ballymena", name: "Ballymena", hint: "County Antrim", lat: 54.8642, lng: -6.2792 },
  { id: "ni-coleraine", name: "Coleraine", hint: "County Londonderry", lat: 55.1333, lng: -6.6681 },
  { id: "ni-armagh", name: "Armagh", hint: "County Armagh", lat: 54.3503, lng: -6.6528 },
  { id: "ni-omagh", name: "Omagh", hint: "County Tyrone", lat: 54.5977, lng: -7.3097 },
  { id: "ni-enniskillen", name: "Enniskillen", hint: "County Fermanagh", lat: 54.3446, lng: -7.6316 },
] as const;

/** The default storefront centre when the visitor hasn't chosen one — Belfast. */
export const NI_DEFAULT_PLACE: Place = NI_PLACES[0]!;

/** The region descriptor handed to PlaceSwitcher to fence search + geolocation to NI. */
export const NI_REGION = {
  code: "ni" as const,
  label: "Northern Ireland",
  contains: isInNI,
};
