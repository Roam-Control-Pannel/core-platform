/**
 * One-time photo backfill — pure orchestration.
 *
 * WHY THIS EXISTS: photo support (migrations 0019/0020 + the `places.photos` field mask)
 * shipped AFTER several categories had already been ingested. Those venues carry a
 * `source_ref` (their Google place id) but no photo rows, and the ingest freshness guard
 * (count_fresh_places_venues, 30-day window) makes a normal category re-tap SKIP the paid
 * fetch — so they can never gain photos through the live path. This backfill re-pulls their
 * photos DIRECTLY by place id (Place Details), once, then upserts them via the same
 * idempotent replace-all RPC the live ingest uses (upsert_venue_photos, 0020).
 *
 * PURE, like ingestCategoryCore: it takes its collaborators (a per-venue Place Details
 * fetcher and a photo-upsert sink) as plain functions — no Supabase client, no fetch, no
 * clock (the inter-call delay is an injected sleep). So it is fully unit-testable with
 * fakes; the thin runner (scripts/backfill-photos.ts) wires the real service client + the
 * real getPlaceDetails and supplies the venue list.
 *
 * COST + SAFETY: one Place Details call per photoless venue (the `id,photos` field mask
 * keeps each call minimal). `limit` caps how many venues are touched in a run; `dryRun`
 * fetches + maps but writes nothing; `delayMs` paces the calls. upsert_venue_photos already
 * skips claimed venues and is replace-all, so re-running is safe and idempotent.
 */
import { places as corePlaces } from "@roam/core";

/** A venue that needs photos: its row id and its Google place id (source_ref). */
export interface PhotolessVenue {
  id: string;
  source_ref: string;
  /** For human-readable progress logging only. */
  name?: string | undefined;
}

/** One element of the upsert_venue_photos payload (photos already mapped + positioned). */
export interface BackfillPhotoEntry {
  venue_id: string;
  photos: (corePlaces.PlacePhoto & { position: number })[];
}

/** Collaborators, injected so the core has no I/O of its own. */
export interface BackfillPhotosDeps {
  /** Fetch one place's photos by its Google place id (Place Details). May throw. */
  getDetails: (placeId: string) => Promise<corePlaces.PlaceResult>;
  /** Persist a batch of mapped photo rows; returns the count inserted. */
  upsertVenuePhotos: (payload: BackfillPhotoEntry[]) => Promise<number>;
  /**
   * Optional: also refresh a venue's card fields (rating/count/price/type label/business
   * status) AND the rich-detail facts (0065: phone/website/price range/attributes) from
   * the same Details call. Absent → photos-only (the original behaviour).
   */
  updateVenueFields?:
    | ((venueId: string, fields: corePlaces.PlaceCardFields, rich: corePlaces.PlaceRichFields) => Promise<void>)
    | undefined;
  /** Optional progress sink. */
  log?: ((msg: string) => void) | undefined;
  /** Optional pacing delay between Place Details calls. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface BackfillPhotosOptions {
  /** Cap venues processed this run (cost guard). Absent = all. */
  limit?: number | undefined;
  /** Milliseconds to wait between Place Details calls. Default 0. */
  delayMs?: number | undefined;
  /** Fetch + map but never write. Default false. */
  dryRun?: boolean | undefined;
  /** Flush the upsert payload once it reaches this many venues. Default 50. */
  batchSize?: number | undefined;
}

export interface BackfillPhotosResult {
  /** Venues actually considered (after `limit`). */
  considered: number;
  /** Place Details calls that succeeded. */
  fetched: number;
  /** Place Details calls that threw (skipped; backfill continues). */
  failed: number;
  /** Venues that turned out to have ≥1 usable photo. */
  venuesWithPhotos: number;
  /** Venues that genuinely returned no photos (keep the default cover). */
  venuesWithoutPhotos: number;
  /** Total photo rows upserted (0 in a dry run). */
  photosUpserted: number;
  /** Venues whose card fields were refreshed (0 when no updateVenueFields dep / dry run). */
  enriched: number;
}

/**
 * Walk the photoless venues, pull each one's photos by place id, and upsert the mapped
 * rows in batches. Per-venue fetch failures are recorded and skipped — one bad place id
 * never aborts the run. Returns a tally.
 */
export async function backfillVenuePhotosCore(
  venues: PhotolessVenue[],
  deps: BackfillPhotosDeps,
  opts: BackfillPhotosOptions = {},
): Promise<BackfillPhotosResult> {
  const limit = opts.limit;
  const delayMs = opts.delayMs ?? 0;
  const dryRun = opts.dryRun ?? false;
  const batchSize = opts.batchSize ?? 50;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? (async () => {});

  const targets = typeof limit === "number" ? venues.slice(0, limit) : venues;

  let fetched = 0;
  let failed = 0;
  let venuesWithPhotos = 0;
  let venuesWithoutPhotos = 0;
  let photosUpserted = 0;
  let enriched = 0;
  let pending: BackfillPhotoEntry[] = [];

  async function flush(): Promise<void> {
    if (dryRun || pending.length === 0) return;
    const batch = pending;
    pending = [];
    photosUpserted += await deps.upsertVenuePhotos(batch);
  }

  for (let i = 0; i < targets.length; i++) {
    const v = targets[i]!;
    const tag = `[${i + 1}/${targets.length}] ${v.name ?? v.id}`;
    if (!v.source_ref) {
      log(`${tag}: no source_ref — skipped`);
      continue;
    }
    try {
      const place = await deps.getDetails(v.source_ref);
      fetched++;
      // Refresh the card fields + rich facts from the same Details call.
      if (deps.updateVenueFields && !dryRun) {
        await deps.updateVenueFields(v.id, corePlaces.placeCardFields(place), corePlaces.placeRichFields(place));
        enriched++;
      }
      const photos = corePlaces
        .placePhotos(place)
        .map((ph, idx) => ({ ...ph, position: idx }));
      if (photos.length > 0) {
        venuesWithPhotos++;
        pending.push({ venue_id: v.id, photos });
        log(`${tag}: ${photos.length} photo(s)`);
      } else {
        venuesWithoutPhotos++;
        log(`${tag}: no photos on Google — keeps default cover`);
      }
    } catch (e) {
      failed++;
      log(`${tag}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
    }

    if (pending.length >= batchSize) await flush();
    if (delayMs > 0 && i < targets.length - 1) await sleep(delayMs);
  }

  await flush();

  return {
    considered: targets.length,
    fetched,
    failed,
    venuesWithPhotos,
    venuesWithoutPhotos,
    photosUpserted,
    enriched,
  };
}
