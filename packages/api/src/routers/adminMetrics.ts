/**
 * adminMetrics router — Roam HQ headline numbers.
 *
 * adminProcedure gates every call: the caller must be Roam HQ staff, and ctx.service is
 * the verified service-role client (RLS bypass) these site-wide aggregates require. The
 * heavy lifting lives in @roam/core/admin; the router is a thin, typed seam.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { admin } from "@roam/core";
import { router, adminProcedure } from "../trpc.js";

export const adminMetricsRouter = router({
  /**
   * The staff gate + identity. Returns the caller's HQ id and role; a non-staff caller
   * never reaches here (adminProcedure throws FORBIDDEN), which the UI reads as
   * "not authorised". Cheap, so the dashboard can gate on it before loading anything.
   */
  me: adminProcedure.query(({ ctx }) => {
    return { id: ctx.admin.id, role: ctx.admin.role };
  }),

  /** The top-strip pulse: signups, venues, recent content. */
  pulse: adminProcedure.query(async ({ ctx }) => {
    try {
      return await admin.getPulse(ctx.service);
    } catch (e) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: e instanceof Error ? e.message : "Failed to load pulse.",
      });
    }
  }),

  /** Daily signup counts for the growth sparkline (zero-filled). */
  signupTrend: adminProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(30) }))
    .query(async ({ ctx, input }) => {
      try {
        return await admin.getSignupTrend(ctx.service, input.days);
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Failed to load signup trend.",
        });
      }
    }),

  /** All-time content & social totals. */
  contentBreakdown: adminProcedure.query(async ({ ctx }) => {
    try {
      return await admin.getContentBreakdown(ctx.service);
    } catch (e) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: e instanceof Error ? e.message : "Failed to load content breakdown.",
      });
    }
  }),

  /** The Overview page's KPI strip + engagement hero, in one call. */
  overview: adminProcedure.query(async ({ ctx }) => {
    try {
      return await admin.getOverview(ctx.service);
    } catch (e) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: e instanceof Error ? e.message : "Failed to load overview.",
      });
    }
  }),

  /** New members per rolling week (the "active users" hero proxy). */
  memberWeekly: adminProcedure
    .input(z.object({ weeks: z.number().int().min(4).max(26).default(14) }))
    .query(async ({ ctx, input }) => {
      try {
        return await admin.getMemberWeekly(ctx.service, input.weeks);
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Failed to load member trend.",
        });
      }
    }),

  /** The "Needs You" counts (open reports, pending claims, flags, wall posts). */
  needsYou: adminProcedure.query(async ({ ctx }) => {
    try {
      return await admin.getNeedsYou(ctx.service);
    } catch (e) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: e instanceof Error ? e.message : "Failed to load Needs You.",
      });
    }
  }),

  /** Top localities by forum activity over a window. */
  topPlaces: adminProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(7), limit: z.number().int().min(1).max(20).default(5) }))
    .query(async ({ ctx, input }) => {
      try {
        return await admin.getTopPlaces(ctx.service, input.days, input.limit);
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Failed to load top places.",
        });
      }
    }),
});
