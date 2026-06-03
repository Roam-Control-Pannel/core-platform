/**
 * Venues router.
 *
 * Browse is PUBLIC — unclaimed venues are world-readable by design (the global-launch
 * decision: unclaimed is the median experience and must be excellent).
 *
 * IMPORTANT schema reality (verified against generated types): a venue's location is a
 * PostGIS `geo` column (type `unknown` in the generated types), NOT plain lat/lng. You
 * cannot order by distance client-side from `geo` — that needs a PostGIS query/RPC
 * (ST_Distance against a GiST index), which is the right place for near→far ordering
 * anyway (it's what core/geo's comment says the DB does). That RPC is not built yet, so
 * `near` currently returns a simple list and documents the gap rather than faking a sort
 * over data it doesn't have. core/geo's pure sort stays available for surfaces that
 * already hold coordinates (e.g. plan stops), just not here.
 *
 * "Claimed" is not a boolean column — `owner_id` being non-null means claimed. Claiming
 * sets owner_id to the caller; RLS enforces who may claim.
 */
import { z } from "zod";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

export const venuesRouter = router({
  /**
   * Public: list venues. Distance ordering is a TODO pending a PostGIS RPC
   * (e.g. an rpc('venues_near', { lat, lng, limit }) ordering by ST_Distance).
   * Until then this returns a plain page of venues — no fake proximity sort.
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
