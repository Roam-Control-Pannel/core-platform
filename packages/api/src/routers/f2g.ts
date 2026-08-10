/**
 * f2g router — the Food to Go marketplace's SUPPLY-side surface (Phase 1).
 *
 * Thin transport over @roam/core/f2g. Three concerns:
 *   - config: is the F2G feature switched on (feature_flags.marketplace.f2g.enabled)? The dashboard
 *     hides the whole F2G surface until this is true, so the seam stays dormant until launch.
 *   - collection settings: read (public — the storefront shows prep time) + owner write (RLS-gated).
 *   - listing status: the "ready to go live" checklist an owner sees while onboarding.
 *
 * Tagging a venue INTO the f2g channel is the existing channels.tagVenue/untagVenue (owner
 * self-serve, RLS-scoped) — not duplicated here.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { f2g } from "@roam/core";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

const F2G_FLAG = "marketplace.f2g.enabled";

const collectionPatch = {
  orderAhead: z.boolean().optional(),
  paused: z.boolean().optional(),
  prepTimeMins: z.number().int().min(f2g.PREP_TIME_MIN).max(f2g.PREP_TIME_MAX).optional(),
  collectionInstructions: z.string().trim().max(f2g.COLLECTION_INSTRUCTIONS_MAX).nullish(),
};

export const f2gRouter = router({
  /** Whether the Food to Go feature is live. Public: the shell reads it to show/hide the surface. */
  config: publicProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.db
      .from("feature_flags")
      .select("enabled")
      .eq("key", F2G_FLAG)
      .maybeSingle();
    if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
    return { enabled: !!data?.enabled };
  }),

  /** A venue's order-ahead & collect settings (or the defaults if never configured). Public. */
  collectionSettings: publicProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return f2g.getCollectionSettings(ctx.db, input.venueId);
    }),

  /**
   * Owner-writes their venue's collection settings. RLS on venue_collection_settings scopes the
   * write to the claimed venue's owner, so a signed-in user can never edit a venue they don't own.
   */
  setCollectionSettings: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), ...collectionPatch }))
    .mutation(async ({ ctx, input }) => {
      const { venueId, ...patch } = input;
      try {
        const settings = await f2g.upsertCollectionSettings(ctx.db, venueId, patch);
        return { ok: true as const, settings };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to save collection settings.";
        throw new TRPCError({
          code: /row-level security/i.test(msg) ? "FORBIDDEN" : "BAD_REQUEST",
          message: /row-level security/i.test(msg)
            ? "You can only edit a venue you own and have claimed."
            : msg,
        });
      }
    }),

  /**
   * The "ready to go live on Food to Go" checklist for the owner's venue: claimed, tagged, has a
   * live menu item, taking payments, collection switched on. Owner-scoped (payment visibility is
   * owner-only by RLS).
   */
  listingStatus: protectedProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return f2g.getListingStatus(ctx.db, input.venueId);
    }),
});
