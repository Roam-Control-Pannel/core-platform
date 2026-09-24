/**
 * association router — the partner organisation's own portal (F2G plan 3.2).
 *
 * Everything here runs behind `associationProcedure`, which resolves the caller's channel from their
 * appointment in `channel_admins` and never from the request. No procedure takes a channel argument:
 * the channel is `ctx.association.channelId` or there is no request, which removes the entire class
 * of bug where a caller names someone else's channel and a handler forgets to check.
 *
 * Reads go through the 0157 RPCs rather than tables, because those re-check `is_channel_admin`
 * inside the database. So the containment holds twice over — at the gate here, and again in SQL for
 * anything that reaches PostgREST directly. `ctx.service` exists on this path (the RPCs read the
 * service-managed roster) and is deliberately used for nothing else.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { association } from "@roam/core";
import { router, associationProcedure } from "../trpc.js";

function boom(e: unknown, fallback: string): never {
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e instanceof Error ? e.message : fallback });
}

/**
 * An optional reporting window. Both ends are optional so "all time" needs no special case, and the
 * upper bound is exclusive in SQL, which is what makes month-on-month figures add up instead of
 * double-counting the boundary.
 */
const period = z.object({
  from: z.string().datetime().nullish(),
  to: z.string().datetime().nullish(),
});

export const associationRouter = router({
  /** Who the caller is and which organisation they are acting for. Cheap, and the portal's guard. */
  me: associationProcedure.query(({ ctx }) => ({
    channelId: ctx.association.channelId,
    channelKey: ctx.association.channelKey,
    channelName: ctx.association.channelName,
    role: ctx.association.role,
  })),

  /** The overview tiles, in one snapshot so no two numbers come from different instants. */
  overview: associationProcedure.query(async ({ ctx }) => {
    try {
      const data = await association.getPortalOverview(ctx.service, ctx.association.channelId);
      // Null means the RPC's own gate refused. Reaching here at all means this gate passed, so the
      // two disagree — surface it rather than rendering an empty dashboard as if it were real.
      if (!data) throw new Error("The portal could not read this organisation's figures.");
      return data;
    } catch (e) {
      boom(e, "Failed to load the overview.");
    }
  }),

  /** Live members grouped by their council of record. */
  membersByCouncil: associationProcedure.query(async ({ ctx }) => {
    try {
      return await association.getMembersByCouncil(ctx.service, ctx.association.channelId);
    } catch (e) {
      boom(e, "Failed to load members by council.");
    }
  }),

  /** Channel order totals for a period (decision 5.3, Option B). */
  orderTotals: associationProcedure.input(period).query(async ({ ctx, input }) => {
    try {
      const data = await association.getOrderTotals(
        ctx.service,
        ctx.association.channelId,
        input.from ?? null,
        input.to ?? null,
      );
      if (!data) throw new Error("The portal could not read this organisation's order totals.");
      return data;
    } catch (e) {
      boom(e, "Failed to load order totals.");
    }
  }),

  /** Per-member-venue order totals — the half of Option B that makes the portal worth opening. */
  orderTotalsByVenue: associationProcedure.input(period).query(async ({ ctx, input }) => {
    try {
      return await association.getOrderTotalsByVenue(
        ctx.service,
        ctx.association.channelId,
        input.from ?? null,
        input.to ?? null,
      );
    } catch (e) {
      boom(e, "Failed to load per-venue order totals.");
    }
  }),
});
