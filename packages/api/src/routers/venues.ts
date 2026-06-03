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
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

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
      // The `venues_near` function isn't in the generated DB types until
      // `pnpm db:types` is re-run after migration 0005 is applied. Until then the
      // typed client's .rpc() overload rejects the name, so we widen JUST this call
      // through a minimal rpc surface — the rest of ctx.db stays fully typed.
      const rpc = ctx.db.rpc.bind(ctx.db) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
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
      // request_venue_claim isn't in the generated DB types until `pnpm db:types`
      // is re-run after 0006 is applied; widen JUST this call (same idiom as near).
      const rpc = ctx.db.rpc.bind(ctx.db) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{
        data: unknown;
        error: { message: string; code?: string } | null;
      }>;

      const { data, error } = await rpc("request_venue_claim", {
        target_venue_id: input.venueId,
        claim_note: input.note ?? null,
      });

      if (error) {
        const mapped = error.code ? CLAIM_ERROR_BY_SQLSTATE[error.code] : undefined;
        if (mapped) {
          throw new TRPCError({ code: mapped.code, message: mapped.message });
        }
        // Unknown DB error — surface generically, don't leak internals.
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
});
