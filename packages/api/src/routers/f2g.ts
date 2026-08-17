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
import { router, publicProcedure, protectedProcedure, escalateToService } from "../trpc.js";
import { normaliseStoredImage, venuePrefixOf } from "../images/normalise.js";

const F2G_FLAG = "marketplace.f2g.enabled";

const collectionPatch = {
  orderAhead: z.boolean().optional(),
  paused: z.boolean().optional(),
  prepTimeMins: z.number().int().min(f2g.PREP_TIME_MIN).max(f2g.PREP_TIME_MAX).optional(),
  collectionInstructions: z.string().trim().max(f2g.COLLECTION_INSTRUCTIONS_MAX).nullish(),
};

const deliveryPatch = {
  deliveryEnabled: z.boolean().optional(),
  paused: z.boolean().optional(),
  deliveryFeePence: z.number().int().min(0).max(f2g.DELIVERY_FEE_MAX_PENCE).optional(),
  minOrderPence: z.number().int().min(0).max(f2g.MIN_ORDER_MAX_PENCE).optional(),
  // null clears the radius (postcode-only area); a number is the metre radius.
  radiusM: z.number().int().min(0).max(f2g.DELIVERY_RADIUS_MAX_M).nullish(),
  postcodeAllow: z.array(z.string().trim().max(f2g.POSTCODE_TOKEN_MAX)).max(f2g.POSTCODE_LIST_MAX).optional(),
  postcodeBlock: z.array(z.string().trim().max(f2g.POSTCODE_TOKEN_MAX)).max(f2g.POSTCODE_LIST_MAX).optional(),
  etaMins: z.number().int().min(f2g.DELIVERY_ETA_MIN).max(f2g.DELIVERY_ETA_MAX).optional(),
  deliveryNotes: z.string().trim().max(f2g.DELIVERY_NOTES_MAX).nullish(),
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
      // Food to Go is an NI-only marketplace — never let a venue outside Northern Ireland
      // configure collection, even by calling the API directly (the UI hides the tab too).
      if (!(await f2g.isVenueInFoodToGoRegion(ctx.db, venueId))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Food to Go is only available to venues in Northern Ireland.",
        });
      }
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

  /** A venue's delivery settings (or the defaults — delivery off — if never configured). Public. */
  deliverySettings: publicProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return f2g.getDeliverySettings(ctx.db, input.venueId);
    }),

  /**
   * Owner-writes their venue's delivery settings. RLS on venue_delivery_settings scopes the write
   * to the claimed venue's owner; the NI region gate matches setCollectionSettings (delivery is the
   * same NI-only marketplace, so a business outside Northern Ireland can never enable it).
   */
  setDeliverySettings: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), ...deliveryPatch }))
    .mutation(async ({ ctx, input }) => {
      const { venueId, ...patch } = input;
      if (!(await f2g.isVenueInFoodToGoRegion(ctx.db, venueId))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Food to Go is only available to venues in Northern Ireland.",
        });
      }
      try {
        const settings = await f2g.upsertDeliverySettings(ctx.db, venueId, patch);
        return { ok: true as const, settings };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to save delivery settings.";
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

  /**
   * Normalise a vendor-uploaded image into one canonical WebP rendition (server GUARANTEE on top of
   * the browser's best-effort pipeline). The client uploads the original to venue-media under its
   * venue-id prefix, then calls this with that storage path; we verify the caller owns the claimed
   * venue AND that the path sits under that venue's prefix, then produce + return the canonical URL
   * to persist. Byte I/O runs under the service client, so ownership is checked here, first.
   */
  normaliseImage: protectedProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        storagePath: z.string().trim().min(1).max(300),
        profile: z.enum(["product", "photo"]).default("product"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // The path must live under this venue's own prefix (defence in depth vs the ownership check).
      if (venuePrefixOf(input.storagePath) !== input.venueId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Image path is not under this venue." });
      }
      // Verify the caller owns the claimed venue (the service client below bypasses RLS).
      const { data: auth } = await ctx.db.auth.getUser();
      const uid = auth.user?.id;
      const { data: owned } = await ctx.db
        .from("venues")
        .select("id")
        .eq("id", input.venueId)
        .eq("owner_id", uid ?? "")
        .eq("status", "claimed")
        .maybeSingle();
      if (!owned) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only optimise images for a venue you own and have claimed.",
        });
      }
      try {
        const res = await normaliseStoredImage(
          escalateToService(ctx.env),
          ctx.env.supabase.url,
          input.storagePath,
          input.profile,
        );
        return { ok: true as const, url: res.url, width: res.width, height: res.height };
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Image normalisation failed.",
        });
      }
    }),
});
