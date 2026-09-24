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

  /**
   * The partner organisation's own officers (plan 3.1). Read-only here; appointing and revoking are
   * audited writes in adminActions, mirroring the observe/act split this router already follows.
   */
  officers: adminProcedure
    .input(z.object({ channelKey: z.string().min(1).max(32) }))
    .query(async ({ ctx, input }) => {
      try {
        return await admin.listChannelOfficers(ctx.service, input.channelKey);
      } catch (e) {
        boom(e, "Failed to load channel officers.");
      }
    }),

  /**
   * The cross-partner feature-request queue (plan 3.4). Not scoped to one channel: triage is a
   * Roam-wide job, and seeing every partner's requests together is the point of a queue.
   */
  featureRequests: adminProcedure
    .input(z.object({ status: z.string().max(20).nullish(), limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ ctx, input }) => {
      try {
        return await admin.listFeatureRequestQueue(ctx.service, { status: input.status ?? null, limit: input.limit });
      } catch (e) {
        boom(e, "Failed to load the feature-request queue.");
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

  /**
   * The match-review queue (B4b): unbound members with their ranked candidate venues, the matcher
   * re-run on demand. Staff confirm/dismiss via adminActions. `includeDismissed` revisits dismissed rows.
   */
  reviewQueue: adminProcedure
    .input(
      z.object({
        channelKey: z.string().min(1).max(32),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
        includeDismissed: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await admin.channelReviewQueue(ctx.service, input);
      } catch (e) {
        boom(e, "Failed to load the match-review queue.");
      }
    }),
});
