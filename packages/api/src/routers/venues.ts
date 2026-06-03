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
 * "Claimed" is not a boolean column — `owner_id` being non-null means claimed. Claiming
 * sets owner_id to the caller; RLS enforces who may claim.
 */
import { z } from "zod";
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
   * Protected: claim an unclaimed venue by setting owner_id to the caller.
   * RLS must enforce that only an unclaimed venue (owner_id is null) can be claimed
   * and that the caller becomes the owner. We pass owner_id explicitly; if RLS also
   * derives it from auth.uid() that's belt-and-braces.
   */
  claim: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), ownerId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from("venues")
        .update({ owner_id: input.ownerId })
        .eq("id", input.venueId)
        .is("owner_id", null)
        .select("id, owner_id")
        .maybeSingle();
      if (error) return { claimed: false as const, error: error.message };
      if (!data) {
        return { claimed: false as const, error: "Venue not found or already claimed." };
      }
      return { claimed: true as const, venueId: data.id };
    }),
});
