/**
 * channels router — the Food to Go marketplace's "one platform, two views" surface.
 *
 * A channel is a branded, filtered VIEW over the one core (migration 0116): `roam` shows
 * everything; `f2g` is the Food to Go storefront showing only its tagged venues. All of the
 * decision logic lives in @roam/core/channels (resolution, theme validation) — this router is the
 * thin transport over it. Reads are public (a storefront themes itself before anyone signs in).
 *
 * Resolution split (see ARCHITECTURE.md — Shape-B standalone API keyed by JWT, not host): the web
 * shell resolves the incoming HOSTNAME to a channel and forwards its key as `x-roam-channel`. The
 * API never sees the host. `resolve` exists so that middleware can do the host→channel lookup
 * against the live domain map; `current` reports the channel the header already selected.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { RoamClient } from "@roam/db";
import { channels } from "@roam/core";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

/** Resolve a channel by key or throw a clean NOT_FOUND — used by the self-serve tag paths. */
async function requireChannel(db: RoamClient, key: string) {
  const channel = await channels.getChannelByKey(db, key);
  if (!channel) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Unknown channel '${key}'.` });
  }
  if (channel.isDefault) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The default channel shows every venue; it can't be tagged into.",
    });
  }
  return channel;
}

export const channelsRouter = router({
  /** Every active channel (default first) — for admin pickers and shell bootstrapping. */
  list: publicProcedure.query(async ({ ctx }) => {
    return channels.listChannels(ctx.db);
  }),

  /**
   * Resolve a hostname to its channel against the live domain map, falling back to the default
   * channel when the host is unmapped. The web middleware calls this once per request to decide
   * which channel key to forward and which theme to apply.
   */
  resolve: publicProcedure
    .input(z.object({ host: z.string().max(255) }))
    .query(async ({ ctx, input }) => {
      return channels.resolveChannelByHost(ctx.db, input.host);
    }),

  /**
   * The channel the caller is already on (from the `x-roam-channel` header), with its theme.
   * Falls back to the default channel if the header is missing or names an unknown channel.
   */
  current: publicProcedure.query(async ({ ctx }) => {
    return (
      (await channels.getChannelByKey(ctx.db, ctx.channelKey)) ??
      (await channels.getDefaultChannel(ctx.db))
    );
  }),

  /** A channel by its stable key, or null. */
  get: publicProcedure
    .input(z.object({ key: z.string().min(1).max(32) }))
    .query(async ({ ctx, input }) => {
      return channels.getChannelByKey(ctx.db, input.key);
    }),

  /**
   * The venue ids tagged into a channel — the storefront's supply list. Public: it drives the
   * public F2G storefront filter. Returns [] for the default channel (which is never tagged; it
   * shows everything, so a channel filter is meaningless there).
   */
  venueIds: publicProcedure
    .input(z.object({ key: z.string().min(1).max(32) }))
    .query(async ({ ctx, input }) => {
      const channel = await channels.getChannelByKey(ctx.db, input.key);
      if (!channel || channel.isDefault) return { channelId: channel?.id ?? null, venueIds: [] };
      const venueIds = await channels.taggedVenueIds(ctx.db, channel.id);
      return { channelId: channel.id, venueIds };
    }),

  /** The channel keys a venue is tagged into — drives the vendor console's channel toggles. */
  venueChannels: publicProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return channels.venueChannelKeys(ctx.db, input.venueId);
    }),

  /**
   * Bulk membership: of the given venue ids, which are tagged into the channel. Powers the Roam-side
   * "Order ahead" badge across a discovery grid without downloading the channel's whole id list.
   * Returns [] for the default channel (which shows everything) or an unknown key.
   */
  venuesInChannel: publicProcedure
    .input(
      z.object({
        key: z.string().min(1).max(32),
        venueIds: z.array(z.string().uuid()).max(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.venueIds.length === 0) return { channelId: null, venueIds: [] as string[] };
      const channel = await channels.getChannelByKey(ctx.db, input.key);
      if (!channel || channel.isDefault) return { channelId: channel?.id ?? null, venueIds: [] as string[] };
      const venueIds = await channels.filterVenuesInChannel(ctx.db, channel.id, input.venueIds);
      return { channelId: channel.id, venueIds };
    }),

  /**
   * SELF-SERVE onboarding: a venue owner tags their OWN claimed venue into a channel (e.g. lists it
   * on Food to Go). Authority is RLS: the `venue_channels` owner-write policy only permits the write
   * when the caller owns the claimed venue, so a signed-in user can never tag a venue they don't own.
   * Idempotent. Staff tagging of any venue is a separate, audited path (adminActions.setVenueChannel).
   */
  tagVenue: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), channelKey: z.string().min(1).max(32) }))
    .mutation(async ({ ctx, input }) => {
      const channel = await requireChannel(ctx.db, input.channelKey);
      const { data: me } = await ctx.db.auth.getUser();
      try {
        await channels.tagVenueIntoChannel(ctx.db, channel.id, input.venueId, me.user?.id ?? null);
      } catch (e) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            e instanceof Error && /row-level security/i.test(e.message)
              ? "You can only list a venue you own and have claimed."
              : e instanceof Error
                ? e.message
                : "Failed to list the venue.",
        });
      }
      return { ok: true as const };
    }),

  /** Self-serve: a venue owner removes their own venue from a channel. RLS scopes it to the owner. */
  untagVenue: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), channelKey: z.string().min(1).max(32) }))
    .mutation(async ({ ctx, input }) => {
      const channel = await requireChannel(ctx.db, input.channelKey);
      await channels.untagVenueFromChannel(ctx.db, channel.id, input.venueId);
      return { ok: true as const };
    }),
});
