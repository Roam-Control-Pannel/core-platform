/**
 * channelsAdmin router — Roam HQ reads for the channel + roster console (F2G B4a).
 *
 * Observe side of the Channels view: the channels and their config, a channel's domain map, its
 * `channel_members` roster (filterable, paged), and the onboarding funnel. Staff-only via
 * adminProcedure; reads go through ctx.service (the verified service-role client), the only path to
 * the service-managed roster. The audited WRITES live in adminActions (setChannelConfig, add/remove
 * ChannelDomain), mirroring how the rest of HQ splits observe (here) from act (adminActions).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { admin, channels } from "@roam/core";
import { router, adminProcedure } from "../trpc.js";

const MEMBER_STATUS = z.enum(["imported", "invited", "claimed", "live", "lapsed", "removed"]);

function boom(e: unknown, fallback: string): never {
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e instanceof Error ? e.message : fallback });
}

export const channelsAdminRouter = router({
  /** Every channel with its full config (theme / nav / sections / surface / membership_mode). */
  list: adminProcedure.query(async ({ ctx }) => {
    try {
      return await channels.listChannels(ctx.service);
    } catch (e) {
      boom(e, "Failed to load channels.");
    }
  }),

  /** The hostnames mapped to a channel. */
  domains: adminProcedure
    .input(z.object({ channelKey: z.string().min(1).max(32) }))
    .query(async ({ ctx, input }) => {
      try {
        const all = await channels.listChannelDomains(ctx.service);
        return all.filter((d) => d.channelKey === input.channelKey);
      } catch (e) {
        boom(e, "Failed to load channel domains.");
      }
    }),

  /** A page of a channel's roster, newest first, filterable by status / council / name search. */
  roster: adminProcedure
    .input(
      z.object({
        channelKey: z.string().min(1).max(32),
        status: MEMBER_STATUS.optional(),
        council: z.string().max(120).optional(),
        q: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await admin.channelRoster(ctx.service, input);
      } catch (e) {
        boom(e, "Failed to load roster.");
      }
    }),

  /** Onboarding progress: exact counts by status (the funnel) and by council. */
  onboarding: adminProcedure
    .input(z.object({ channelKey: z.string().min(1).max(32) }))
    .query(async ({ ctx, input }) => {
      try {
        return await admin.channelOnboardingStats(ctx.service, input.channelKey);
      } catch (e) {
        boom(e, "Failed to load onboarding stats.");
      }
    }),
});
