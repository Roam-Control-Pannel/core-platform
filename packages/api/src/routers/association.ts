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
import { notifyOps } from "../observability/ops.js";

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

  /**
   * The members list (decision 5.2, Option A): business, membership number, venue, council, status,
   * activation date. No contact details — they are not columns of the RPC, so this cannot leak them
   * by adding a field here.
   */
  members: associationProcedure
    .input(
      z.object({
        status: z.enum(["imported", "invited", "claimed", "live", "lapsed", "removed"]).nullish(),
        council: z.string().max(120).nullish(),
        query: z.string().max(200).nullish(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await association.getPortalMembers(ctx.service, ctx.association.channelId, input);
      } catch (e) {
        boom(e, "Failed to load members.");
      }
    }),

  /**
   * The same list as CSV. Built server-side so the escaping — including the leading apostrophe that
   * stops Excel executing a business name as a formula — lives in one tested place rather than being
   * reimplemented in the browser.
   *
   * Capped at 5,000 rows: an association roster is hundreds, so the cap only ever bites on a runaway,
   * and `truncated` tells the UI to say so rather than handing over a silently partial export.
   */
  membersCsv: associationProcedure
    .input(
      z.object({
        status: z.enum(["imported", "invited", "claimed", "live", "lapsed", "removed"]).nullish(),
        council: z.string().max(120).nullish(),
        query: z.string().max(200).nullish(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const CAP = 5000;
      try {
        const page = await association.getPortalMembers(ctx.service, ctx.association.channelId, {
          ...input,
          limit: 500,
          offset: 0,
        });
        const rows = [...page.rows];
        // The RPC caps a page at 500, so walk it rather than asking for a number it will refuse.
        while (rows.length < Math.min(page.total, CAP)) {
          const next = await association.getPortalMembers(ctx.service, ctx.association.channelId, {
            ...input,
            limit: 500,
            offset: rows.length,
          });
          if (next.rows.length === 0) break; // defensive: never spin if the RPC stops yielding
          rows.push(...next.rows);
        }
        return {
          csv: association.membersToCsv(rows.slice(0, CAP)),
          rowCount: Math.min(rows.length, CAP),
          truncated: page.total > CAP,
        };
      } catch (e) {
        boom(e, "Failed to export members.");
      }
    }),

  /**
   * The organisation's requests to Roam, and Roam's replies (plan 3.4).
   *
   * Read through `ctx.db` — the caller's own client — rather than `ctx.service`, so the read runs
   * against the RLS policy instead of relying on this handler to filter correctly.
   */
  featureRequests: associationProcedure.query(async ({ ctx }) => {
    try {
      return await association.listFeatureRequests(ctx.db, ctx.association.channelId);
    } catch (e) {
      boom(e, "Failed to load requests.");
    }
  }),

  /**
   * File a request. Officers only — enforced by the INSERT policy, not by this handler.
   *
   * Written with `ctx.db` deliberately: the service client would bypass the very policy that checks
   * the caller is an officer of this channel and that `created_by` is really them. A viewer's
   * attempt fails in the database, which is where it should fail.
   */
  createFeatureRequest: associationProcedure
    .input(
      z.object({
        title: z.string().trim().min(3).max(140),
        detail: z.string().trim().max(4000).nullish(),
        category: z.enum(association.FEATURE_REQUEST_CATEGORIES).default("other"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let created;
      try {
        const { data: authData } = await ctx.db.auth.getUser();
        const uid = authData?.user?.id;
        if (!uid) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to file a request." });
        created = await association.createFeatureRequest(ctx.db, {
          channelId: ctx.association.channelId,
          createdBy: uid,
          title: input.title,
          detail: input.detail ?? null,
          category: input.category,
        });
      } catch (e) {
        if (e instanceof TRPCError) throw e;
        // The commonest cause is a VIEWER trying to file: the policy refuses and Postgres reports a
        // row-level-security violation. Say what it means rather than surfacing the raw error.
        const msg = e instanceof Error ? e.message : "";
        if (/row-level security|violates/i.test(msg)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only officers can file a request. Ask Roam to change your role if you need to.",
          });
        }
        boom(e, "Failed to file the request.");
      }

      // Tell Roam. Deliberately the ops alert channel rather than a second internal e-mail path:
      // it already exists, dedupes, and never throws. A failure here must not lose the request, so
      // it is fire-and-forget AFTER the row is committed.
      void notifyOps({
        key: `association.request:${created.id}`,
        title: `Feature request from ${ctx.association.channelName ?? ctx.association.channelKey ?? "a partner"}`,
        detail: `${created.title}\ncategory: ${created.category}\n\n${created.detail ?? "(no detail)"}`,
      });

      return created;
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
