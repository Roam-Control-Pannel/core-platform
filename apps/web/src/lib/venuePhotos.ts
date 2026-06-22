/**
 * Browser-side venue photo read-model policy — hero selection and gallery ordering.
 *
 * This file deliberately does NOT import @roam/core: core can't be browser-bundled
 * under Turbopack (Node-ESM .js-suffix resolution breaks), which is why @roam/core is
 * not a dependency of @roam/web. VenueDetail needs to pick a hero and order the gallery
 * from the photo rows it fetches, so that pure policy is mirrored here locally — the
 * same lockstep-by-contract pattern as CATEGORY_GROUPS in lib/categories.ts, venuePath
 * in lib/routes.ts and urlBase64ToUint8Array in lib/push.ts.
 *
 * CANONICAL DEFINITION lives in packages/core/src/photos/index.ts (selectHero,
 * galleryOrder). The API owns the rows (venue_photos) and their provenance; this twin is
 * display-only ordering over rows the client already received. The two functions are
 * pure and tiny; keep them identical to core's. If you change the hero/gallery policy in
 * core, change it here too. Kept in lockstep by contract, not by a shared import.
 */

/** Minimal shape the web read-model needs — a twin of core's VenuePhotoRow (read side). */
export interface PhotoRow {
  id: string;
  source: "google_places" | "owner_upload";
  position: number;
  is_cover: boolean;
  attribution: unknown;
}

/**
 * Pick the hero photo: explicit cover first, then the best owner upload, then the best
 * places photo, else null. Owner content outranks scraped. Mirrors core selectHero.
 */
export function selectHero<T extends PhotoRow>(rows: readonly T[]): T | null {
  if (rows.length === 0) return null;
  const cover = rows.find((r) => r.is_cover);
  if (cover) return cover;
  const owner = rows
    .filter((r) => r.source === "owner_upload")
    .sort((a, b) => a.position - b.position);
  if (owner[0]) return owner[0];
  const places = rows
    .filter((r) => r.source === "google_places")
    .sort((a, b) => a.position - b.position);
  return places[0] ?? null;
}

/**
 * Order photos for the gallery: owner uploads first (by position), then places photos
 * (by position). Returns a new array; never mutates input. Mirrors core galleryOrder.
 */
export function galleryOrder<T extends PhotoRow>(rows: readonly T[]): T[] {
  const owner = rows
    .filter((r) => r.source === "owner_upload")
    .sort((a, b) => a.position - b.position);
  const places = rows
    .filter((r) => r.source === "google_places")
    .sort((a, b) => a.position - b.position);
  return [...owner, ...places];
}
