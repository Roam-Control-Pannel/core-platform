/**
 * adminSearch router — Roam HQ user & venue lookup (search + drill-in detail).
 *
 * Gated by adminProcedure (staff-only; ctx.service is the verified service-role client).
 * Detail views favour aggregates over raw PII — sensitive personal data (user_private)
 * is deliberately not surfaced here.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { admin } from "@roam/core";
import { router, adminProcedure } from "../trpc.js";

const term = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(50).default(20),
});

export const adminSearchRouter = router({
  users: adminProcedure.input(term).query(async ({ ctx, input }) => {
    try {
      return await admin.searchUsers(ctx.service, input.q, input.limit);
    } catch (e) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: e instanceof Error ? e.message : "User search failed.",
      });
    }
  }),

  venues: adminProcedure.input(term).query(async ({ ctx, input }) => {
    try {
      return await admin.searchVenues(ctx.service, input.q, input.limit);
    } catch (e) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: e instanceof Error ? e.message : "Venue search failed.",
      });
    }
  }),

  userDetail: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      try {
        const detail = await admin.getUserDetail(ctx.service, input.id);
        if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "No such user." });
        return detail;
      } catch (e) {
        if (e instanceof TRPCError) throw e;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Failed to load user.",
        });
      }
    }),

  venueDetail: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      try {
        const detail = await admin.getVenueDetail(ctx.service, input.id);
        if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "No such venue." });
        return detail;
      } catch (e) {
        if (e instanceof TRPCError) throw e;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Failed to load venue.",
        });
      }
    }),
});
