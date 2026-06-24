/**
 * Venues router.
 *
 * Browse is PUBLIC — unclaimed venues are world-readable by design (the global-launch
 * decision: unclaimed is the median experience and must be excellent).
 *
 * IMPORTANT schema reality (verified against generated types): a venue's location is a
 * PostGIS `geo` column (type `unknown` in the generated types), NOT plain lat/lng. You
 * cannot order by distance client-side from `geo` — that needs a PostGIS query/RPC
 * (ST_Distance against a GiST index). As of migration 0005 that RPC exists
 * (`venues_near`), so `near` now returns a real near→far ordering with a distance.
 * `list` stays as the no-origin fallback (a plain page, no proximity claim) for
 * surfaces that have no caller location yet.
 *
 * "Claimed" is not a boolean column — `owner_id` being non-null means claimed. But
 * claiming is NOT a direct owner_id write: it is a REQUEST. As of migration 0006 a
 * signed-in user calls `request_venue_claim`, which moves the venue
 * unclaimed → pending_claim and records a venue_claims row WITHOUT setting owner_id.
 * Ownership is conferred only by the service-role approval path (verification),
 * never by the user. See `requestClaim` below and 0006_venue_claims.sql.
 *
 * As of migration 0007 that approval path exists: `approve_venue_claim` (service-role
 * only) performs email-domain auto-match and, on a genuine business-domain match,
 * confers ownership (venue → claimed, owner_id set). It NEVER auto-rejects: a non-match
 * leaves the claim pending for human review. The `approveClaim` procedure here is
 * `internalProcedure` (requires x-internal-call; uses the service client) — it is the
 * ONLY caller of that function, and it is unreachable by a user JWT. This is the other
 * half of claim-as-request, and it keeps the dangerous owner_id write off every
 * user-facing path exactly as 0004/0006/ARCHITECTURE.md demand.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { places as corePlaces } from "@roam/core";
import { router, publicProcedure, protectedProcedure, internalProcedure } from "../trpc.js";
import {
  normaliseVenueDescription,
  normaliseVenueLinks,
} from "../venue-details.js";


/**
 * The Places (New) photo-media endpoint, built as a pure function so it is unit-testable
 * without a network. With skipHttpRedirect=true Google returns JSON { photoUri } — a
 * SHORT-LIVED, KEYLESS url the browser can render directly. The API key is used ONLY in
 * this server-side request; it never reaches the browser and the returned photoUri
 * carries no key. maxWidthPx caps the delivered size (cost + bandwidth control).
 */
export function buildPhotoMediaRequestUrl(
  placesPhotoRef: string,
  apiKey: string,
  maxWidthPx: number,
): string {
  // ref is like "places/{id}/photos/{photoRef}"; the media resource appends "/media".
  const base = `https://places.googleapis.com/v1/${placesPhotoRef}/media`;
  const params = new URLSearchParams({
    key: apiKey,
    maxWidthPx: String(maxWidthPx),
    skipHttpRedirect: "true",
  });
  return `${base}?${params.toString()}`;
}

/**
 * Build the public CDN URL for an owner_upload object in the PUBLIC `venue-media`
 * bucket (migration 0021). Public-bucket objects have a stable, keyless, CDN-cacheable
 * URL of the form {SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}.
 *
 * Pure (no I/O): the owner twin of buildPhotoMediaRequestUrl. We persist the object
 * PATH in venue_photos.storage_path (not the resolved URL) so the row survives a
 * project-ref change and the column keeps meaning "where the object lives"; this
 * rebuilds the URL at read time, exactly as buildPhotoMediaRequestUrl does for Places.
 *
 * supabaseUrl is trimmed of a trailing slash; each path segment is encodeURIComponent'd
 * (so spaces/unicode in a filename can't break the URL) while the '/' separators are
 * preserved (we encode segment-wise, never the whole path).
 */
export function buildOwnerPhotoPublicUrl(
  supabaseUrl: string,
  bucket: string,
  storagePath: string,
): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  const encodedPath = storagePath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${base}/storage/v1/object/public/${bucket}/${encodedPath}`;
}

/** The Storage bucket owner uploads land in (migration 0021). */
const VENUE_MEDIA_BUCKET = "venue-media";

/** Max delivered width for venue photos (px). Gallery/hero never need more on web. */
const PHOTO_MAX_WIDTH_PX = 1200;

/** A single venue_photos row as read for the gallery (the display read-model). */
interface VenuePhotoReadRow {
  id: string;
  source: "google_places" | "owner_upload";
  position: number;
  is_cover: boolean;
  places_photo_ref: string | null;
  storage_path: string | null;
  attribution: unknown;
}


/**
 * Shape returned by the `venues_near` RPC (migration 0005). The generated DB types
 * won't include this function until `pnpm db:types` is re-run after the migration is
 * applied, so we type the row explicitly here and read it through `as unknown` at the
 * call site. Keep this in sync with the RPC's `returns table (...)` definition.
 */
interface VenuesNearRow {
  id: string;
  name: string;
  owner_id: string | null;
  status: string;
  category: string | null;
  categories: string[];
  rating: number | null;
  distance_m: number;
}

/**
 * Shape returned by the `venues_in_category_near` RPC (migration 0017) — the tiered,
 * category-filtered, paginated browse read. Same row shape as VenuesNearRow (the two
 * RPCs return identical columns); kept as its own named interface so the sibling
 * procedures read independently and a future shape change to one can't silently drift
 * the other. Not in generated DB types until `pnpm db:types` re-runs; read through the
 * widened .rpc() surface, same idiom as venues_near.
 */
interface VenuesInCategoryNearRow {
  id: string;
  name: string;
  owner_id: string | null;
  status: string;
  category: string | null;
  categories: string[];
  rating: number | null;
  distance_m: number;
}

/**
 * Shape returned by the `request_venue_claim` RPC (migration 0006) — a single
 * venue_claims row. As with venues_near, the function isn't in the generated DB
 * types until `pnpm db:types` is re-run, so we type it explicitly and widen the
 * .rpc() call. Keep in sync with the venue_claims table definition.
 */
interface VenueClaimRow {
  id: string;
  venue_id: string;
  claimant_id: string;
  status: "pending" | "approved" | "rejected";
  note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Shape returned by the `approve_venue_claim` / `reject_venue_claim` functions
 * (migrations 0007 / 0008) — the venue_claim_approval composite, SHARED by both
 * review outcomes. Not in generated types until `pnpm db:types` re-runs; typed
 * explicitly and read through the widened .rpc() surface.
 *
 * `method` is the honest union across BOTH outcomes: approve emits
 * 'email_domain' | 'manual_review_required' | 'not_actionable'; reject emits
 * 'rejected' | 'not_actionable'. The row type is their union.
 */
interface VenueClaimApprovalRow {
  claim_id: string;
  venue_id: string;
  verified: boolean;
  venue_status: string;
  method: "email_domain" | "manual_review_required" | "not_actionable" | "rejected";
}

/** A pending venue_claims row id, as selected by sweepClaims before looping. */
interface PendingClaimIdRow {
  id: string;
}

/**
 * Postgres error codes the request_venue_claim function raises (via `using errcode`),
 * mapped to friendly, typed outcomes. These surface to the client through the RPC
 * error.message / code, so we match on the SQLSTATE we deliberately chose in 0006.
 */
const CLAIM_ERROR_BY_SQLSTATE: Record<string, { code: TRPCError["code"]; message: string }> = {
  "28000": { code: "UNAUTHORIZED", message: "You need to be signed in to claim a venue." },
  P0002: { code: "NOT_FOUND", message: "That venue no longer exists." },
  "22023": {
    code: "CONFLICT",
    message: "This venue can't be claimed right now — it may already be claimed or under review.",
  },
  "23505": {
    code: "CONFLICT",
    message: "You've already submitted a claim for this venue. It's awaiting review.",
  },
};

/**
 * A widened `.rpc()` surface. The 0005/0006/0007/0008 functions aren't in the generated
 * DB types until `pnpm db:types` is re-run, so the typed client's .rpc() overload
 * rejects their names. We widen JUST the rpc call (the rest of the client stays fully
 * typed) — the same idiom proven on `near` and `requestClaim`.
 */
type LooseRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;

export const venuesRouter = router({
  /**
   * Public: list venues with NO proximity ordering. The no-origin fallback — used
   * when the caller has no location yet. For near→far + distance, use `near`.
   */
  list: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from("venues")
        .select("id, name, owner_id, status, category, categories, rating")
        .limit(input.limit);
      if (error) throw new Error(`Failed to load venues: ${error.message}`);
      return (data ?? []).map((v) => ({
        id: v.id,
        name: v.name,
        claimed: v.owner_id !== null,
        status: v.status,
        category: v.category,
        categories: v.categories,
        rating: v.rating,
      }));
    }),

  /**
   * Protected: the venues the CALLER owns. The Business console's root query —
   * a venue owner's overview is "the venues I own", which is owner_id = auth.uid().
   * RLS: venues_read is `using (true)` so the select is permitted; we additionally
   * filter owner_id to the caller (resolved from the validated JWT) so the console
   * only ever shows a user their OWN venues, never the world's. No new policy needed
   * — ownership is venue_status 'claimed' + owner_id set (0006/0007), and this reads
   * exactly that. Returns the fields the Overview cards render.
   */
  myVenues: protectedProcedure.query(async ({ ctx }) => {
    const { data: userData, error: userErr } = await ctx.db.auth.getUser();
    if (userErr || !userData.user) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Could not resolve the signed-in user.",
      });
    }
    const ownerId = userData.user.id;

    const { data, error } = await ctx.db
      .from("venues")
      .select("id, name, status, category, locality, region, rating, rating_count")
      .eq("owner_id", ownerId)
      .order("name", { ascending: true });
    if (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to load your venues: ${error.message}`,
      });
    }
    return (data ?? []).map((v) => ({
      id: v.id,
      name: v.name,
      status: v.status,
      category: v.category,
      locality: v.locality,
      region: v.region,
      rating: v.rating,
      ratingCount: v.rating_count,
    }));
  }),

  /**
   * Public: near→far venue search from a (lat,lng) origin, via the `venues_near`
   * PostGIS RPC (migration 0005). Orders by the GiST-indexed KNN operator and returns
   * a real `distanceM` (metres) for the DistanceChip. RLS still applies — the RPC is
   * SECURITY INVOKER, so anonymous browsing sees the same world-readable venues.
   *
   * `distanceM` is surfaced raw (metres); formatting (formatDistance) is a UI concern.
   */
  near: publicProcedure
    .input(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rpc = ctx.db.rpc.bind(ctx.db) as unknown as LooseRpc;
      const { data, error } = await rpc("venues_near", {
        lat: input.lat,
        lng: input.lng,
        max_results: input.limit,
      });
      if (error) throw new Error(`Failed to load nearby venues: ${error.message}`);
      const rows = (data ?? []) as VenuesNearRow[];
      return rows.map((v) => ({
        id: v.id,
        name: v.name,
        claimed: v.owner_id !== null,
        status: v.status,
        category: v.category,
        categories: v.categories,
        rating: v.rating,
        distanceM: v.distance_m,
      }));
    }),

  /**
   * Public: tiered, category-filtered, paginated browse from a (lat,lng) origin, via
   * the `venues_in_category_near` PostGIS RPC (migration 0017). This is the read the
   * Explore category-pill tap issues AFTER ingestion has filled supply: claimed venues
   * first, then unclaimed, each near→far, filtered to the tapped category group.
   *
   * Sibling to `near` (not an extension of it): `near` stays the pure-distance read
   * that chat.ts also depends on. The RPC returns pageSize+1 rows so we derive
   * `hasMore` from the overflow without a COUNT(*); we slice the overflow row off so
   * the client contract is a clean { venues, hasMore, nextOffset } — the +1 mechanism
   * never leaks past this boundary. SECURITY INVOKER, so venues_read RLS (public)
   * applies and anonymous browsing works, exactly like `near`.
   */
  inCategoryNear: publicProcedure
    .input(
      z.object({
        category: z.enum(corePlaces.CATEGORIES as unknown as [string, ...string[]]),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        pageSize: z.number().int().min(1).max(100).default(10),
        pageOffset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rpc = ctx.db.rpc.bind(ctx.db) as unknown as LooseRpc;
      const { data, error } = await rpc("venues_in_category_near", {
        filter_category: input.category,
        lat: input.lat,
        lng: input.lng,
        page_size: input.pageSize,
        page_offset: input.pageOffset,
      });
      if (error) throw new Error(`Failed to load category venues: ${error.message}`);

      const rows = (data ?? []) as VenuesInCategoryNearRow[];
      // The RPC returns up to pageSize+1; the extra row only tells us another page
      // exists. Slice it off so the client never sees the overflow mechanism.
      const hasMore = rows.length > input.pageSize;
      const page = hasMore ? rows.slice(0, input.pageSize) : rows;
      return {
        venues: page.map((v) => ({
          id: v.id,
          name: v.name,
          claimed: v.owner_id !== null,
          status: v.status,
          category: v.category,
          categories: v.categories,
          rating: v.rating,
          distanceM: v.distance_m,
        })),
        hasMore,
        nextOffset: input.pageOffset + page.length,
      };
    }),

  /** Public: read a single venue (claimed or the graceful unclaimed state). */
  byId: publicProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from("venues")
        .select("*")
        .eq("id", input.venueId)
        .maybeSingle();
      if (error) throw new Error(`Failed to load venue: ${error.message}`);
      return data;
    }),

  /**
   * Public: ordered photo rows for a venue's gallery. RLS venue_photos_select_public
   * is `using (true)`, so the anon ctx.db read is permitted. Ordering (owner-first,
   * then places, each by position) is applied client-side via @roam/core photos
   * selectHero/galleryOrder — this procedure returns the raw ordered-by-position rows.
   */
  photosByVenue: publicProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // venue_photos is newer than the generated DB types (db:types not yet re-run since
      // migration 0019) — widen the read via a loose select typed to our row shape, the
      // same idiom this file uses for venues_near and the pending-claims sweep.
      type LoosePhotoList = {
        from: (table: string) => {
          select: (cols: string) => {
            eq: (
              col: string,
              val: string,
            ) => {
              order: (
                col: string,
                opts: { ascending: boolean },
              ) => Promise<{
                data: VenuePhotoReadRow[] | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
      const db = ctx.db as unknown as LoosePhotoList;
      const { data, error } = await db
        .from("venue_photos")
        .select("id, source, position, is_cover, places_photo_ref, storage_path, attribution")
        .eq("venue_id", input.venueId)
        .order("position", { ascending: true });
      if (error) throw new Error(`Failed to load venue photos: ${error.message}`);
      return (data ?? []).map(
        (p): {
          id: string;
          source: "google_places" | "owner_upload";
          position: number;
          is_cover: boolean;
          places_photo_ref: string | null;
          storage_path: string | null;
          attribution: unknown;
        } => ({
          id: p.id,
          source: p.source,
          position: p.position,
          is_cover: p.is_cover,
          places_photo_ref: p.places_photo_ref,
          storage_path: p.storage_path,
          attribution: p.attribution,
        }),
      );
    }),

  /**
   * Public: resolve ONE photo to a renderable url. The Google API key is used only in
   * this server-side call; the browser receives a short-lived, KEYLESS googleusercontent
   * url (google_places) or the Storage url (owner_upload). The key never leaves the API.
   *
   * google_places: GET Places media with skipHttpRedirect=true -> { photoUri }.
   * owner_upload:   return storage_path directly (owner media; Slice 6 populates these).
   */
  photoMediaUrl: publicProcedure
    .input(z.object({ photoId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // venue_photos newer than generated types — loose widen, typed to the row shape.
      type PhotoResolveRow = {
        id: string;
        source: "google_places" | "owner_upload";
        places_photo_ref: string | null;
        storage_path: string | null;
      };
      type LoosePhotoSingle = {
        from: (table: string) => {
          select: (cols: string) => {
            eq: (
              col: string,
              val: string,
            ) => {
              maybeSingle: () => Promise<{
                data: PhotoResolveRow | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
      const db = ctx.db as unknown as LoosePhotoSingle;
      const { data, error } = await db
        .from("venue_photos")
        .select("id, source, places_photo_ref, storage_path")
        .eq("id", input.photoId)
        .maybeSingle();
      if (error) throw new Error(`Failed to load photo: ${error.message}`);
      if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "Photo not found." });

      const row = data;

      if (row.source === "owner_upload") {
        if (!row.storage_path) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Photo has no storage path." });
        }
        return {
          url: buildOwnerPhotoPublicUrl(
            ctx.env.supabase.url,
            VENUE_MEDIA_BUCKET,
            row.storage_path,
          ),
        };
      }

      // google_places
      if (!row.places_photo_ref) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Photo has no Places reference." });
      }
      const reqUrl = buildPhotoMediaRequestUrl(
        row.places_photo_ref,
        ctx.env.places.apiKey,
        PHOTO_MAX_WIDTH_PX,
      );
      let res: Response;
      try {
        res = await fetch(reqUrl);
      } catch (e) {
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: `Places photo resolve failed: ${e instanceof Error ? e.message : "fetch error"}`,
        });
      }
      if (!res.ok) {
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: `Places photo resolve failed: ${res.status} ${res.statusText}`,
        });
      }
      const json = (await res.json()) as { photoUri?: string };
      if (!json.photoUri) {
        throw new TRPCError({ code: "BAD_GATEWAY", message: "Places returned no photoUri." });
      }
      return { url: json.photoUri };
    }),

  /**
   * Protected: REQUEST to claim an unclaimed venue. This is NOT a direct owner_id
   * write — claiming is a trust event, not a land-grab (see 0006_venue_claims.sql).
   *
   * Calls the `request_venue_claim` SECURITY DEFINER function, which:
   *   - verifies the venue is currently `unclaimed`,
   *   - moves it `unclaimed → pending_claim` (owner_id stays NULL),
   *   - records a `venue_claims` row for the caller (status `pending`).
   *
   * Ownership is conferred only LATER, by the service-role verification/approval
   * path — never here. The function authorises via auth.uid(); a JWT is guaranteed
   * by protectedProcedure, but the function re-checks defensively.
   *
   * Errors raised by the function (chosen SQLSTATEs in 0006) are mapped to typed
   * tRPC errors so the UI can show the right message (already-claimed vs duplicate
   * request vs not-found).
   */
  requestClaim: protectedProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        note: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rpc = ctx.db.rpc.bind(ctx.db) as unknown as LooseRpc;

      const { data, error } = await rpc("request_venue_claim", {
        target_venue_id: input.venueId,
        claim_note: input.note ?? null,
      });

      if (error) {
        const mapped = error.code ? CLAIM_ERROR_BY_SQLSTATE[error.code] : undefined;
        if (mapped) {
          throw new TRPCError({ code: mapped.code, message: mapped.message });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Couldn't submit your claim. Please try again.",
        });
      }

      const claim = data as VenueClaimRow;
      return {
        requested: true as const,
        claimId: claim.id,
        venueId: claim.venue_id,
        status: claim.status,
      };
    }),

  /**
   * Internal: run the verification/approval check on a pending claim. The OTHER HALF
   * of claim-as-request. Requires x-internal-call (internalProcedure) and uses the
   * service client (RLS bypass) — it is unreachable by a user JWT, which is the whole
   * point: conferring ownership must never sit on a user-facing path.
   *
   * Calls `approve_venue_claim` (migration 0007), which auto-approves ONLY on a
   * genuine business email-domain match (venue → claimed, owner_id set) and otherwise
   * leaves the claim pending for human review — it NEVER auto-rejects.
   *
   * Invoked SERVER-SIDE ONLY (never by the browser — INTERNAL_CALL_SECRET is
   * server-only): a manual/curl call today, a cron/Edge sweep over the pending
   * queue later. Until approval runs, VenueDetail shows the true "under review"
   * state; the venue flips to claimed on the next byId read after approval.
   * The DB owns WHAT approval means; this procedure only carries the WHEN.
   */
  approveClaim: internalProcedure
    .input(z.object({ claimId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rpc = ctx.service.rpc.bind(ctx.service) as unknown as LooseRpc;
      const { data, error } = await rpc("approve_venue_claim", {
        target_claim_id: input.claimId,
      });
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Claim approval failed: ${error.message}`,
        });
      }
      const r = data as VenueClaimApprovalRow;
      return {
        claimId: r.claim_id,
        venueId: r.venue_id,
        verified: r.verified,
        venueStatus: r.venue_status,
        method: r.method,
      };
    }),

  /**
   * Internal: reject a pending claim. The counterpart to approveClaim, reaching the
   * `rejected` enum value (0006) via reject_venue_claim (0008). Requires
   * x-internal-call (internalProcedure) and uses the service client — unreachable by
   * a user JWT, same as approveClaim. Returns the shared venue_claim_approval shape
   * (verified always false; method 'rejected' | 'not_actionable').
   *
   * Server-side only (a staff/console review action or a sweep decision); the browser
   * never calls it. The DB owns WHAT rejection means (close the claim; return the venue
   * to the pool iff it was pending on this claim and no other pending claim remains;
   * never un-own a claimed venue); this only carries the WHEN + the reason.
   */
  rejectClaim: internalProcedure
    .input(
      z.object({
        claimId: z.string().uuid(),
        reason: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rpc = ctx.service.rpc.bind(ctx.service) as unknown as LooseRpc;
      const { data, error } = await rpc("reject_venue_claim", {
        target_claim_id: input.claimId,
        reason: input.reason ?? null,
      });
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Claim rejection failed: ${error.message}`,
        });
      }
      const r = data as VenueClaimApprovalRow;
      return {
        claimId: r.claim_id,
        venueId: r.venue_id,
        verified: r.verified,
        venueStatus: r.venue_status,
        method: r.method,
      };
    }),

  /**
   * Internal: sweep the pending-claim queue. Selects every `pending` claim and runs
   * approve_venue_claim per row, so approval happens in a batch instead of one
   * hand-run curl. In prod a scheduler hits venues.sweepClaims over x-internal-call
   * on an interval.
   *
   * Mechanism: a single internalProcedure (the one sanctioned server-to-server path);
   * NOT a new HTTP route or Edge Function (ARCHITECTURE.md mandates one mechanism, and
   * server.ts stays transport-pure).
   *
   * Behaviour: reads pending claims via the service client (RLS bypassed — the review
   * side legitimately sees all claims), then calls approve_venue_claim per claim id.
   * That function is idempotent and guarded (a claim that raced to non-pending, or
   * whose venue is no longer pending_claim, returns not_actionable rather than
   * erroring), so the loop is safe against concurrent requests/approvals. Outcomes are
   * tallied by result so the caller (and prod logs) can see what the sweep did.
   *
   * It does NOT reject anything — a non-match stays pending for human review (the
   * 0007/0008 "never auto-reject" stance). Rejection is the explicit rejectClaim path.
   */
  sweepClaims: internalProcedure
    .input(
      z
        .object({
          /** Safety cap so one sweep can't run unboundedly; defaults to 500. */
          limit: z.number().int().min(1).max(1000).default(500),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const limit = input?.limit ?? 500;

      // `venue_claims` (migration 0006) is not in the generated DB types yet —
      // `pnpm db:types` hasn't been re-run since 0006 — so the typed client's
      // `.from()` overload rejects the table name. Widen JUST this select to a
      // minimal query surface (the rest of the client stays fully typed), the same
      // idiom `near`/`requestClaim`/`approveClaim` use for the un-generated RPCs.
      // Once `pnpm db:types` regenerates, this can revert to a plain typed `.from`.
      type LooseSelect = {
        from: (table: string) => {
          select: (cols: string) => {
            eq: (
              col: string,
              val: string,
            ) => {
              order: (
                col: string,
                opts: { ascending: boolean },
              ) => {
                limit: (n: number) => Promise<{
                  data: PendingClaimIdRow[] | null;
                  error: { message: string } | null;
                }>;
              };
            };
          };
        };
      };
      const svc = ctx.service as unknown as LooseSelect;

      const { data: pendingRows, error: selErr } = await svc
        .from("venue_claims")
        .select("id")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(limit);

      if (selErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Sweep failed to load pending claims: ${selErr.message}`,
        });
      }

      const ids = (pendingRows ?? []).map((r) => r.id);

      const rpc = ctx.service.rpc.bind(ctx.service) as unknown as LooseRpc;
      let approved = 0;
      let stillPending = 0;
      let notActionable = 0;

      // Sequential loop: each approve_venue_claim locks its own rows; running them one
      // at a time keeps lock contention trivial and the tally exact. At launch volumes
      // the pending queue is tiny; if it ever grows, the seam to move this into a single
      // set-based SQL function is here (flagged, not over-built now).
      for (const id of ids) {
        const { data, error } = await rpc("approve_venue_claim", {
          target_claim_id: id,
        });
        if (error) {
          // A single bad row must not abort the whole sweep — count it as still pending
          // (it remains in the queue for the next pass / human review).
          stillPending += 1;
          continue;
        }
        const r = data as VenueClaimApprovalRow;
        if (r.verified && r.method === "email_domain") approved += 1;
        else if (r.method === "manual_review_required") stillPending += 1;
        else notActionable += 1; // raced to non-pending between select and call
      }

      return {
        swept: ids.length,
        approved,
        stillPending,
        notActionable,
      };
    }),

  /**
   * Protected: record an owner_upload photo row AFTER the browser has uploaded the
   * bytes to Storage (SDK upload under the owner's JWT; the 0021 storage RLS gated it).
   * Only writes the metadata row. The INSERT is itself RLS-gated
   * (venue_photos_owner_insert, 0019), so a row can't be written for a venue the caller
   * doesn't own. position defaults 0; is_cover is never set here (setCover owns that).
   * .select()-guarded: zero rows => RLS refused => ok:false.
   */
  addOwnerPhoto: protectedProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        storagePath: z.string().min(1).max(1024),
        altText: z.string().trim().max(500).optional(),
        width: z.number().int().positive().max(100000).optional(),
        height: z.number().int().positive().max(100000).optional(),
        position: z.number().int().min(0).max(10000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Defence in depth: storage path's first segment MUST be this venue id.
      const firstSegment = input.storagePath.split("/")[0];
      if (firstSegment !== input.venueId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "storagePath must be scoped under the venue id (`<venueId>/<file>`).",
        });
      }
      type InsertedRow = { id: string; position: number; is_cover: boolean };
      type LooseInsert = {
        from: (table: string) => {
          insert: (row: Record<string, unknown>) => {
            select: (cols: string) => {
              maybeSingle: () => Promise<{
                data: InsertedRow | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
      const db = ctx.db as unknown as LooseInsert;
      const { data, error } = await db
        .from("venue_photos")
        .insert({
          venue_id: input.venueId,
          source: "owner_upload",
          storage_path: input.storagePath,
          alt_text: input.altText ?? null,
          width: input.width ?? null,
          height: input.height ?? null,
          position: input.position ?? 0,
          is_cover: false,
        })
        .select("id, position, is_cover")
        .maybeSingle();
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to record photo: ${error.message}`,
        });
      }
      if (!data) {
        return { ok: false as const };
      }
      return { ok: true as const, photoId: data.id, position: data.position };
    }),

  /**
   * Protected: reorder an owner's photos. Accepts the full ordered list of photo ids;
   * writes each row's `position` to its index. Only owner_upload rows update (RLS scope).
   * Per-row .select()-guarded; a shortfall in the tally => some update was RLS-refused =>
   * ok:false so the client refetches rather than trust a partial reorder.
   */
  reorderPhotos: protectedProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        orderedPhotoIds: z.array(z.string().uuid()).min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      type UpdatedRow = { id: string };
      type LooseUpdate = {
        from: (table: string) => {
          update: (patch: Record<string, unknown>) => {
            eq: (col: string, val: string) => {
              eq: (col2: string, val2: string) => {
                select: (cols: string) => Promise<{
                  data: UpdatedRow[] | null;
                  error: { message: string } | null;
                }>;
              };
            };
          };
        };
      };
      const db = ctx.db as unknown as LooseUpdate;
      let updated = 0;
      for (let i = 0; i < input.orderedPhotoIds.length; i++) {
        const photoId = input.orderedPhotoIds[i]!;
        const { data, error } = await db
          .from("venue_photos")
          .update({ position: i })
          .eq("id", photoId)
          .eq("venue_id", input.venueId)
          .select("id");
        if (error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Failed to reorder photos: ${error.message}`,
          });
        }
        if (data && data.length > 0) updated += data.length;
      }
      const ok = updated === input.orderedPhotoIds.length;
      return { ok, updated, requested: input.orderedPhotoIds.length };
    }),

  /**
   * Protected: set ONE photo as cover (hero). Clears prior cover, then sets the new one.
   * Order is clear-then-set: setting first could transiently violate the one-cover
   * partial-unique index (0019); clearing first is always safe. Both updates owner-RLS-
   * gated + .select()-guarded. photoId=null is a valid "no cover" (clears any cover).
   */
  setCover: protectedProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        photoId: z.string().uuid().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      type Row = { id: string };
      type LooseCover = {
        from: (table: string) => {
          update: (patch: Record<string, unknown>) => {
            eq: (c1: string, v1: string) => {
              eq: (c2: string, v2: string | boolean) => {
                select: (cols: string) => Promise<{
                  data: Row[] | null;
                  error: { message: string } | null;
                }>;
              };
            };
          };
        };
      };
      const db = ctx.db as unknown as LooseCover;
      const { error: clearErr } = await db
        .from("venue_photos")
        .update({ is_cover: false })
        .eq("venue_id", input.venueId)
        .eq("is_cover", true)
        .select("id");
      if (clearErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to clear current cover: ${clearErr.message}`,
        });
      }
      if (input.photoId === null) {
        return { ok: true as const, cover: null };
      }
      const { data, error: setErr } = await db
        .from("venue_photos")
        .update({ is_cover: true })
        .eq("id", input.photoId)
        .eq("venue_id", input.venueId)
        .select("id");
      if (setErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to set cover: ${setErr.message}`,
        });
      }
      if (!data || data.length === 0) {
        return { ok: false as const, cover: null };
      }
      return { ok: true as const, cover: input.photoId };
    }),

  /**
   * Protected: remove an owner_upload photo — deletes the Storage OBJECT then the ROW.
   * Object first: a failure leaves the row intact (retryable, no orphan). Both deletes
   * owner-authorised (0021 storage RLS + venue_photos_owner_delete 0019). Row delete
   * .select()-guarded. google_places rows are not owner-deletable (FORBIDDEN).
   */
  removeOwnerPhoto: protectedProcedure
    .input(z.object({ photoId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      type ResolveRow = {
        id: string;
        venue_id: string;
        source: "google_places" | "owner_upload";
        storage_path: string | null;
      };
      type LooseResolve = {
        from: (table: string) => {
          select: (cols: string) => {
            eq: (c: string, v: string) => {
              maybeSingle: () => Promise<{
                data: ResolveRow | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
      const dbRead = ctx.db as unknown as LooseResolve;
      const { data: row, error: readErr } = await dbRead
        .from("venue_photos")
        .select("id, venue_id, source, storage_path")
        .eq("id", input.photoId)
        .maybeSingle();
      if (readErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to load photo: ${readErr.message}`,
        });
      }
      if (!row) {
        return { ok: true as const, deleted: false as const };
      }
      if (row.source !== "owner_upload" || !row.storage_path) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only owner-uploaded photos can be removed.",
        });
      }
      const { error: objErr } = await ctx.db.storage
        .from(VENUE_MEDIA_BUCKET)
        .remove([row.storage_path]);
      if (objErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to delete photo object: ${objErr.message}`,
        });
      }
      type DelRow = { id: string };
      type LooseDelete = {
        from: (table: string) => {
          delete: () => {
            eq: (c: string, v: string) => {
              select: (cols: string) => Promise<{
                data: DelRow[] | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
      const dbDel = ctx.db as unknown as LooseDelete;
      const { data: delData, error: delErr } = await dbDel
        .from("venue_photos")
        .delete()
        .eq("id", input.photoId)
        .select("id");
      if (delErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to delete photo row: ${delErr.message}`,
        });
      }
      if (!delData || delData.length === 0) {
        return { ok: false as const, deleted: false as const };
      }
      return { ok: true as const, deleted: true as const };
    }),

  /**
   * Protected: an owner edits their CLAIMED venue's description and links — the owner
   * twin of the Places-sourced facts. Column-scope is enforced HERE, not in RLS: the
   * patch object is built from exactly two validated fields (description, links), so it
   * is structurally impossible for this mutation to write any other venue column
   * (rating, category, geo, place_id, owner_id, status, …). RLS (venues_owner_update,
   * 0004 + explicit with check in 0022) is the row gate: it admits the write only when
   * the caller owns the row AND it is claimed, and the post-image must still satisfy
   * that — so this cannot reassign ownership or change status either.
   *
   * Both fields are nullable: passing null (or an empty/whitespace description, or a
   * links map that normalises to nothing) CLEARS that field, which the reader treats
   * identically to "never set". links is normalised to the flat Record<string,string>
   * VenueDetail's linkEntries expects, with an http(s)-only scheme allow-list.
   *
   * .select()-guarded: zero returned rows => RLS refused (not owner, or not claimed) =>
   * ok:false, so the client refetches rather than trust an unverified write.
   */
  updateVenueDetails: protectedProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        description: z.string().max(20000).nullable(),
        links: z.record(z.unknown()).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Column gate: validate + normalise to exactly what we persist. Throws => 400.
      let description: string | null;
      let links: Record<string, string> | null;
      try {
        description = normaliseVenueDescription(input.description);
        links = normaliseVenueLinks(input.links);
      } catch (e) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: e instanceof Error ? e.message : "Invalid venue details.",
        });
      }

      type UpdatedRow = { id: string };
      type LooseDetailsUpdate = {
        from: (table: string) => {
          update: (patch: Record<string, unknown>) => {
            eq: (col: string, val: string) => {
              select: (cols: string) => Promise<{
                data: UpdatedRow[] | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
      const db = ctx.db as unknown as LooseDetailsUpdate;
      // jsonb `links` column is NOT NULL default '{}' (0001) — clearing writes {} not null.
      const { data, error } = await db
        .from("venues")
        .update({ description, links: links ?? {} })
        .eq("id", input.venueId)
        .select("id");
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to update venue details: ${error.message}`,
        });
      }
      if (!data || data.length === 0) {
        return { ok: false as const };
      }
      return { ok: true as const };
    }),
});
