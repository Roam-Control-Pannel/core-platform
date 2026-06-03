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
import { router, publicProcedure, protectedProcedure, internalProcedure } from "../trpc.js";

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
 * Shape returned by the `approve_venue_claim` function (migration 0007) — the
 * venue_claim_approval composite. Not in generated types until `pnpm db:types`
 * re-runs; typed explicitly and read through the widened .rpc() surface.
 */
interface VenueClaimApprovalRow {
  claim_id: string;
  venue_id: string;
  verified: boolean;
  venue_status: string;
  method: "email_domain" | "manual_review_required" | "not_actionable";
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
 * A widened `.rpc()` surface. The 0005/0006/0007 functions aren't in the generated
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
   * Invoked two ways, both running the SAME DB logic:
   *   - inline by the web client as a best-effort follow-up right after requestClaim
   *     (so a verifiable owner gets instant approval), and
   *   - later by a cron/Edge sweep over the pending queue (same endpoint).
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
});
