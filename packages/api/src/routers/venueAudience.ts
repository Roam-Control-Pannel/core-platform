/**
 * venueAudience router — aggregate follower analytics for a business dashboard.
 *
 * stats(venueId) returns COUNTS only (followers, new, engaged, push reach, birthdays this month,
 * age bands) — never an individual. The venue_audience_stats RPC (0052) does the owner check + the
 * k-anonymity floors (demographics withheld for small followings); a non-owner → 42501 → FORBIDDEN.
 * Inline structural return (no AppRouter leak).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";

type LooseDb = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }> };

export const venueAudienceRouter = router({
  /** Owner: aggregate audience stats for a venue you own (k-anonymised; counts only). */
  stats: protectedProcedure.input(z.object({ venueId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = await db.rpc("venue_audience_stats", { p_venue: input.venueId });
    if (error) {
      if (error.code === "42501") throw new TRPCError({ code: "FORBIDDEN", message: "Only the venue owner can view audience insights." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load audience: ${error.message}` });
    }
    const d = (data ?? {}) as {
      followers?: number;
      new30?: number;
      engaged30?: number;
      pushReach?: number;
      birthdaysThisMonth?: number | null;
      ageBands?: Record<string, number> | null;
      dobSample?: number;
    };
    return {
      followers: Number(d.followers ?? 0),
      new30: Number(d.new30 ?? 0),
      engaged30: Number(d.engaged30 ?? 0),
      pushReach: Number(d.pushReach ?? 0),
      birthdaysThisMonth: d.birthdaysThisMonth == null ? null : Number(d.birthdaysThisMonth),
      ageBands: d.ageBands ?? null,
      dobSample: Number(d.dobSample ?? 0),
    };
  }),
});
