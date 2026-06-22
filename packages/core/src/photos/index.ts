/**
 * Venue photo display policy — read-model ordering for the venue_photos table.
 *
 * This module is DELIBERATELY separate from places/index.ts. The places module owns
 * one job: turning raw Google Places (New) results into our rows (ingest mapping,
 * coupled to Google's response shape). THIS module owns a different job: deciding the
 * display ORDER and HERO of photo rows already in OUR `venue_photos` table — rows that
 * carry OUR `source` / `position` / `is_cover`, never a Places result. These functions
 * would work identically if every photo were owner-uploaded and Google did not exist.
 *
 * The split keeps each module honest: `places/` = "how Google results become our rows",
 * `photos/` = "how our photo rows are ordered for display". When the owner uploader
 * lands, its logic has an obvious home here, unrelated to Places ingest.
 *
 * Provenance / priority contract (the whole point of the venue_photos design):
 *   owner_upload content always outranks scraped google_places content. An explicit
 *   is_cover flag (one per venue, enforced by a partial-unique index in migration 0019)
 *   pins a chosen hero independent of gallery order.
 *
 * Pure: no I/O, no clock, no transport. Core decides ORDER and HERO only — it never
 * resolves a photo URL. The web shell builds URLs (proxy for places refs, Storage URL
 * for owner uploads); that I/O concern stays out of core by design.
 */

/**
 * The minimal read-model this policy depends on. Rows read back from venue_photos carry
 * more than this (id, alt_text, the resolved URL, attribution); the helpers are generic
 * over `T extends VenuePhotoRow` so they order those richer rows while depending ONLY on
 * the three fields that decide order. Core stays ignorant of how a photo is fetched.
 */
export interface VenuePhotoRow {
  source: "google_places" | "owner_upload";
  position: number;
  is_cover: boolean;
}

/**
 * Sort a COPY of the rows by ascending position. Never mutates the input — the copy is
 * explicit, not incidental on .filter() running first, so a future edit can't regress it.
 */
function byPosition<T extends VenuePhotoRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.position - b.position);
}

/**
 * Pick the hero (cover) photo for a venue, or null when there are no photos (caller
 * keeps its gradient placeholder). Priority:
 *   1. an explicit is_cover row (owner's pinned choice), else
 *   2. the first owner_upload by position (owner content outranks scraped), else
 *   3. the first google_places by position (scraped fallback), else
 *   4. null.
 *
 * example: [places@0, owner@0]            -> owner@0   (owner outranks places)
 * example: [places@0, owner@1{cover}]     -> owner@1   (explicit cover wins)
 * example: [places@1, places@0]           -> places@0  (position-ordered fallback)
 * example: []                             -> null
 */
export function selectHero<T extends VenuePhotoRow>(photos: readonly T[]): T | null {
  if (photos.length === 0) return null;

  const cover = photos.find((p) => p.is_cover);
  if (cover) return cover;

  const owner = byPosition(photos.filter((p) => p.source === "owner_upload"));
  if (owner.length > 0) return owner[0]!;

  const places = byPosition(photos.filter((p) => p.source === "google_places"));
  return places[0] ?? null;
}

/**
 * Order all photos for the gallery: owner_upload block first (position-sorted), then
 * google_places block (position-sorted). Owner content leads; scraped content trails.
 * Stable and deterministic so it can be asserted exactly.
 *
 * Note: the hero from selectHero may also appear in this list — the gallery renders the
 * full set; the caller decides whether to visually dedupe the hero from the strip.
 *
 * example: [places@0, owner@1, owner@0, places@1]
 *       -> [owner@0, owner@1, places@0, places@1]
 */
export function galleryOrder<T extends VenuePhotoRow>(photos: readonly T[]): T[] {
  const owner = byPosition(photos.filter((p) => p.source === "owner_upload"));
  const places = byPosition(photos.filter((p) => p.source === "google_places"));
  return [...owner, ...places];
}
