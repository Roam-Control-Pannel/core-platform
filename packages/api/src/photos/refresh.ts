/**
 * Photo-reference self-heal — pure orchestration.
 *
 * WHY THIS EXISTS: Places (New) photo references EXPIRE. A venue ingested months ago still has
 * its venue_photos rows, but Google now answers the Photo Media call for every one of them with
 *   400 INVALID_ARGUMENT "The photo resource in the request is invalid. Please retrieve it from
 *   Places API endpoints."
 * — and the whole platform's covers fall back to the placeholder at once (Sep 2026). A one-off
 * re-ingest would only reset the clock. So the read path heals itself: when a resolve comes back
 * STALE, refresh that ONE venue's refs with one cheap photo-only Place Details call, replace its
 * rows through the policy RPC (refresh_venue_google_photos, 0147), and serve the fresh photo.
 * Any venue anyone views heals; nothing needs a cron to stop being blank.
 *
 * COST DISCIPLINE (each a hard stop, in order):
 *   - owner library present      → never refreshed (the owner's photos are canonical; also the
 *                                  DB policy — we just save the Details call).
 *   - refreshed within the hour  → not again (google_photos_refreshed_at: restart-safe,
 *                                  multi-replica-safe negative cache; stops loops on a photo
 *                                  Google has genuinely removed).
 *   - details budget exhausted   → stop (claim_places_detail_quota, the shared wallet backstop).
 *   - only STALE responses heal  → 400 INVALID_ARGUMENT / 404. A 403/429/5xx is a key, quota or
 *                                  outage problem: healing would spend budget AND mask the fault.
 * Per-venue in-flight de-duplication lives in the router wiring (ten photos of one venue → one
 * Details call).
 *
 * PURE, like backfillVenuePhotosCore: collaborators are injected (venue facts, quota claim, the
 * photo fetch, the policy RPC, the fresh-row read, the clock), so it unit-tests with fakes.
 */
import { places as corePlaces } from "@roam/core";

/** Don't re-heal a venue refreshed more recently than this. */
export const RECENTLY_REFRESHED_MS = 60 * 60 * 1000;

/**
 * Is this Photo Media response "the REF is bad" (heal) rather than "the CALL is bad" (don't)?
 *   404                       → the photo is gone: heal.
 *   400 + Google's INVALID_ARGUMENT / "photo resource … invalid" body (or no body) → expired ref: heal.
 *   400 with some other body  → our request is malformed; healing can't fix it: don't.
 *   403 / 429 / 5xx / anything else → key, quota or outage: don't (see header).
 */
export function isStalePhotoRefResponse(status: number, body: string | null | undefined): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  const text = (body ?? "").trim();
  if (text === "") return true;
  return /INVALID_ARGUMENT|photo resource|not valid/i.test(text);
}

/** A fresh google_places row after a refresh — what the resolve path needs to serve it. */
export interface FreshPhotoRow {
  id: string;
  position: number;
  places_photo_ref: string;
}

/**
 * After a refresh the OLD photo id no longer exists; pick the fresh row to serve in its place:
 * the one at the same gallery position (so a 10-photo gallery renders 10 distinct photos, not the
 * cover ten times), else the first by position (the cover), else null (Google returned none).
 */
export function pickFreshRow(rows: readonly FreshPhotoRow[], wantedPosition: number): FreshPhotoRow | null {
  if (rows.length === 0) return null;
  const exact = rows.find((r) => r.position === wantedPosition);
  if (exact) return exact;
  return [...rows].sort((a, b) => a.position - b.position)[0] ?? null;
}

/** The venue facts the decision needs. */
export interface RefreshVenueFacts {
  /** The Google place id (venues.source_ref); null → cannot refresh. */
  sourceRef: string | null;
  /** venues.google_photos_refreshed_at as an ISO string; null → never refreshed. */
  refreshedAt: string | null;
  /** Any owner_upload row exists → the owner's library is canonical. */
  hasOwnerUploads: boolean;
}

/** Collaborators, injected so the core has no I/O of its own. */
export interface RefreshVenuePhotosDeps {
  /** Look up the venue; null when it doesn't exist. */
  getVenue: (venueId: string) => Promise<RefreshVenueFacts | null>;
  /** Claim ONE Place Details unit from the shared daily budget; false = exhausted. */
  claimDetailsQuota: () => Promise<boolean>;
  /** The cheap photo-only Details fetch (getPlacePhotos). May throw. */
  getPhotos: (placeId: string) => Promise<corePlaces.PlaceResult>;
  /** The policy RPC (refresh_venue_google_photos): replace the venue's rows; returns rows inserted. */
  refreshRows: (venueId: string, photos: (corePlaces.PlacePhoto & { position: number })[]) => Promise<number>;
  /** The venue's google_places rows AFTER the refresh, for serving. */
  listFreshRows: (venueId: string) => Promise<FreshPhotoRow[]>;
  /** Clock, for the recently-refreshed check. Default Date.now. */
  now?: (() => number) | undefined;
}

export type RefreshSkipReason =
  | "no-venue"
  | "owner-library"
  | "no-source-ref"
  | "recently-refreshed"
  | "budget-exhausted"
  /** The DB policy declined the write (e.g. a claimed venue that had no Google rows). */
  | "policy-declined";

export type RefreshOutcome =
  | { kind: "refreshed"; rows: FreshPhotoRow[]; inserted: number }
  | { kind: "skipped"; reason: RefreshSkipReason }
  | { kind: "failed"; error: string };

/**
 * Refresh one venue's Google photo refs, if policy and budget allow. Never throws — every
 * outcome is a value so the resolve path can decide (serve fresh / fall back to the placeholder)
 * without a try/catch of its own.
 */
export async function refreshVenueGooglePhotosCore(
  venueId: string,
  deps: RefreshVenuePhotosDeps,
): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now;

  const venue = await deps.getVenue(venueId);
  if (!venue) return { kind: "skipped", reason: "no-venue" };
  if (venue.hasOwnerUploads) return { kind: "skipped", reason: "owner-library" };
  if (!venue.sourceRef) return { kind: "skipped", reason: "no-source-ref" };
  if (venue.refreshedAt) {
    const t = Date.parse(venue.refreshedAt);
    if (Number.isFinite(t) && now() - t < RECENTLY_REFRESHED_MS) {
      return { kind: "skipped", reason: "recently-refreshed" };
    }
  }
  if (!(await deps.claimDetailsQuota())) return { kind: "skipped", reason: "budget-exhausted" };

  let place: corePlaces.PlaceResult;
  try {
    place = await deps.getPhotos(venue.sourceRef);
  } catch (e) {
    return { kind: "failed", error: e instanceof Error ? e.message : String(e) };
  }
  const photos = corePlaces.placePhotos(place).map((ph, idx) => ({ ...ph, position: idx }));

  let inserted: number;
  try {
    inserted = await deps.refreshRows(venueId, photos);
  } catch (e) {
    return { kind: "failed", error: e instanceof Error ? e.message : String(e) };
  }
  // Fresh photos were offered but nothing was written → the DB policy declined the venue.
  if (inserted === 0 && photos.length > 0) return { kind: "skipped", reason: "policy-declined" };

  const rows = photos.length === 0 ? [] : await deps.listFreshRows(venueId);
  return { kind: "refreshed", rows, inserted };
}
