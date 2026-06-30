/**
 * Browser-side canonical app route paths.
 *
 * This file deliberately does NOT import @roam/core/routes: core can't be
 * browser-bundled under Turbopack (Node-ESM .js-suffix resolution breaks), which
 * is why @roam/core is not a dependency of @roam/web and is absent from
 * next.config.ts transpilePackages. The route builders the browser needs are tiny
 * pure string functions, mirrored here locally — the same pattern as
 * urlBase64ToUint8Array in apps/web/src/lib/push.ts.
 *
 * CANONICAL DEFINITION lives in packages/core/src/routes/index.ts. The Node side
 * (push dispatch in packages/api) imports it from there. These local twins MUST
 * stay byte-identical in output to core's. If you change a route in core, change
 * it here too. They are kept in lockstep by contract, not by a shared import.
 */

/** The web deep-link path for a venue's detail page. Matches apps/web/src/app/venue/[id]. */
export function venuePath(venueId: string): string {
  return `/venue/${venueId}`;
}

/**
 * The web path for a user's profile. Prefer the @handle (the canonical, username URL); pass the
 * user id only as a fallback — the /u/[id] route resolves a UUID and 301-redirects it to the
 * handle, so links built from an id still land on the right place.
 */
export function profilePath(handleOrId: string): string {
  return `/u/${handleOrId}`;
}

/**
 * Slugify a place name into its locality key — the browser twin of the API's localitySlug
 * (packages/api/src/town-hall.ts). For realistic place names this produces the same key the API
 * stores, so a hub link built here resolves to the right board. "Stockton-on-Tees" →
 * "stockton-on-tees".
 */
export function townSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A town's Town Hall hub page, e.g. /town-hall/durham. */
export function townHubPath(locality: string): string {
  return `/town-hall/${locality}`;
}

/** A Town Hall topic's canonical URL, e.g. /town-hall/durham/best-sunday-roast. */
export function townHallTopicPath(locality: string, slug: string): string {
  return `/town-hall/${locality}/${slug}`;
}
