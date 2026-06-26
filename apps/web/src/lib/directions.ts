/**
 * Directions hand-off — open the device's DEFAULT maps app rather than forcing one
 * provider. The product decision: on a phone, "Get Directions" should use whatever maps app
 * the user has set as default, not always Google.
 *
 *  - iOS      → Apple Maps universal link (the iOS default maps app).
 *  - Android  → `geo:` intent — Android routes it to the user's default maps app (or the
 *               chooser), so a user who prefers Waze/Google/etc. gets their own.
 *  - Desktop / unknown → Google Maps web (no native maps app to defer to).
 *
 * The query is the venue's address TEXT (not lat/lng) so the maps app resolves the named
 * place rather than dropping an unlabelled pin — same rationale as the old NavigateHere.
 *
 * Pure + framework-free (it lives in the web shell because @roam/core can't be browser-
 * bundled under Turbopack — same boundary as lib/openNow.ts and lib/push.ts). The platform
 * detection takes its inputs as args so it's deterministic and trivially testable.
 */

export type MapsPlatform = "ios" | "android" | "web";

/**
 * Classify the runtime from navigator signals. iPadOS reports as "MacIntel" with touch
 * points > 1 (it masquerades as desktop Safari), so we treat that as iOS too.
 */
export function detectMapsPlatform(
  userAgent: string,
  maxTouchPoints = 0,
  platform = "",
): MapsPlatform {
  if (/iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1)) {
    return "ios";
  }
  if (/Android/i.test(userAgent)) return "android";
  return "web";
}

/** Build the directions URL for a platform, querying by the venue's address text. */
export function directionsUrl(address: string, platform: MapsPlatform): string {
  const q = encodeURIComponent(address);
  switch (platform) {
    case "ios":
      return `https://maps.apple.com/?q=${q}`;
    case "android":
      return `geo:0,0?q=${q}`;
    case "web":
    default:
      return `https://www.google.com/maps/search/?api=1&query=${q}`;
  }
}

/**
 * "Open this area in Maps" hand-off — centre the device's default maps app on a place
 * (lat/lng) with a labelled pin. Used by Explore instead of an embedded map provider: the
 * product decision is to defer to the user's own maps app rather than ship a map SDK + key.
 */
export function placeMapsUrl(
  lat: number,
  lng: number,
  label: string,
  platform: MapsPlatform,
): string {
  const ll = `${lat},${lng}`;
  const q = encodeURIComponent(label);
  switch (platform) {
    case "ios":
      return `https://maps.apple.com/?ll=${ll}&q=${q}`;
    case "android":
      return `geo:${ll}?q=${ll}(${q})`;
    case "web":
    default:
      return `https://www.google.com/maps/search/?api=1&query=${ll}`;
  }
}
