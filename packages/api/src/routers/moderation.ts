/**
 * Moderation router — the report-then-act backstop for self-serve claiming.
 *
 *   reportVenue (public/protected): any signed-in user files a report. It lands in
 *     moderation_queue (0003) as a `user_report` via the user client — the 0004 RLS policy
 *     authorises exactly this insert (reason = 'user_report' AND reporter_id = auth.uid()).
 *
 *   revokeClaim / setVenueSuspended / banProfile (INTERNAL): the staff actions, thin wrappers
 *     over the service-role SECURITY DEFINER functions in 0029. internalProcedure + ctx.service
 *     means they are unreachable by a user JWT (same posture as approveClaim) — a future admin
 *     surface or an ops script calls them; conferring/removing power never sits on a user path.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, internalProcedure } from "../trpc.js";

/** Widened rpc surface — the 0029 functions aren't in generated DB types. Same idiom as venues. */
type LooseRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

export const moderationRouter = router({
  /** Protected: report a C2C market listing (scam, prohibited item, abuse) for human review.
   *  Same moderation_queue insert the venue report uses — the 0004 policy gates on
   *  reason='user_report' + self as reporter, not on entity type. */
  reportListing: protectedProcedure
    .input(z.object({ listingId: z.string().uuid(), detail: z.string().trim().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { data: u, error: uErr } = await ctx.db.auth.getUser();
      if (uErr || !u.user) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Could not resolve the signed-in user." });
      }
      type LooseInsert = {
        from: (t: string) => { insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }> };
      };
      const { error } = await (ctx.db as unknown as LooseInsert).from("moderation_queue").insert({
        entity_type: "market_listing",
        entity_id: input.listingId,
        reason: "user_report",
        reporter_id: u.user.id,
        detail: input.detail ?? null,
      });
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't submit your report. Please try again." });
      }
      return { ok: true as const };
    }),

  /** Protected: report a venue (wrong claim, abusive content, etc.) for human review. */
  reportVenue: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), detail: z.string().trim().max(2000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { data: u, error: uErr } = await ctx.db.auth.getUser();
      if (uErr || !u.user) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Could not resolve the signed-in user." });
      }
      // moderation_queue (0003) isn't in the generated DB types — loose insert, RLS-gated to
      // exactly this shape (reason 'user_report', reporter_id = self).
      type LooseInsert = {
        from: (t: string) => {
          insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
        };
      };
      const db = ctx.db as unknown as LooseInsert;
      const { error } = await db.from("moderation_queue").insert({
        entity_type: "venue",
        entity_id: input.venueId,
        reason: "user_report",
        reporter_id: u.user.id,
        detail: input.detail ?? null,
      });
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't submit your report. Please try again." });
      }
      return { ok: true as const };
    }),

  /** Internal: undo a wrongful claim — clear ownership, venue back to unclaimed. */
  revokeClaim: internalProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rpc = ctx.service.rpc.bind(ctx.service) as unknown as LooseRpc;
      const { error } = await rpc("moderate_revoke_claim", { p_venue_id: input.venueId });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Revoke failed: ${error.message}` });
      return { ok: true as const };
    }),

  /** Internal: hide or restore a venue from public discovery. */
  setVenueSuspended: internalProcedure
    .input(z.object({ venueId: z.string().uuid(), suspended: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const rpc = ctx.service.rpc.bind(ctx.service) as unknown as LooseRpc;
      const { error } = await rpc("moderate_set_venue_suspended", {
        p_venue_id: input.venueId,
        p_suspended: input.suspended,
      });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Suspend failed: ${error.message}` });
      return { ok: true as const };
    }),

  /** Internal: ban or un-ban a profile (also suspends/restores their venues). */
  banProfile: internalProcedure
    .input(z.object({ userId: z.string().uuid(), banned: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const rpc = ctx.service.rpc.bind(ctx.service) as unknown as LooseRpc;
      const { error } = await rpc("moderate_ban_profile", { p_user_id: input.userId, p_banned: input.banned });
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Ban failed: ${error.message}` });
      return { ok: true as const };
    }),
});
