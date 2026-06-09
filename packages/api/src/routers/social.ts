/**
 * Social router — venue follows and profile friendships.
 *
 * Two DISTINCT edges (confirmed against generated types):
 *   follows      — follower_id (a profile) → venue_id (a venue). Following is always
 *                  user→VENUE; there is no profile→profile follow.
 *   friendships  — requester_id ↔ addressee_id, status enum (pending|accepted|blocked).
 *                  The only profile↔profile relationship. No "declined" status, so a
 *                  decline deletes the pending row (blocking is separate/explicit).
 *
 * follower_id / requester_id are NOT NULL with no client-known default, so the generated
 * Insert types require them explicitly — we cannot omit them and lean on RLS to fill them.
 * We resolve the caller's own id from the validated JWT (auth.getUser) and pass it. RLS
 * still enforces that a user may only write rows where they are the follower/requester;
 * passing the id explicitly is belt-and-braces, not a bypass.
 *
 * All procedures are protected (a JWT is guaranteed present).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { RoamClient } from "@roam/db";
import { push } from "@roam/core";
import { router, protectedProcedure } from "../trpc.js";

/** Resolve the caller's auth user id from the validated session JWT. */
async function callerId(db: RoamClient): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Could not resolve the signed-in user.",
    });
  }
  return data.user.id;
}

export const socialRouter = router({
  /**
   * Register THIS device's push subscription (capture). Grain is per-PERSON, not
   * per-venue: push_subscriptions is keyed (profile_id, token), and which venues
   * a person gets pushes for is the separate `follows` edge. Dispatch (a later
   * slice) fans out by joining follows x push_subscriptions on profile_id.
   *
   * Idempotent on the (profile_id, token) unique key (re-subscribing the same
   * browser is a no-op upsert). Validation lives in @roam/core/push so the rule
   * is shared; we re-run it server-side here before the write. Read back on write
   * and throw on zero rows, per the banked write-path rule.
   */
  register: protectedProcedure
    .input(
      z.object({
        platform: z.enum(["web", "ios", "android"]),
        token: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const validation = push.validateRegistration(input);
      if (!validation.ok) {
        return { ok: false as const, errors: validation.errors };
      }

      const profile_id = await callerId(ctx.db);
      const { data, error } = await ctx.db
        .from("push_subscriptions")
        .upsert(
          {
            profile_id,
            platform: input.platform,
            token: input.token,
            consent: true,
          },
          { onConflict: "profile_id,token" },
        )
        .select("id")
        .single();

      if (error) return { ok: false as const, errors: [error.message] };
      if (!data) {
        return { ok: false as const, errors: ["Subscription write returned no row."] };
      }
      return { ok: true as const, subscriptionId: data.id };
    }),

  /** Follow a venue (idempotent on the follower+venue key). */
  followVenue: protectedProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const follower_id = await callerId(ctx.db);
      const { error } = await ctx.db
        .from("follows")
        .upsert({ follower_id, venue_id: input.venueId })
        .select("venue_id");
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const };
    }),

  /** Unfollow a venue. RLS scopes the delete to the caller's own follow row. */
  unfollowVenue: protectedProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const follower_id = await callerId(ctx.db);
      const { error } = await ctx.db
        .from("follows")
        .delete()
        .eq("follower_id", follower_id)
        .eq("venue_id", input.venueId);
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const };
    }),

  /**
   * Toggle push delivery for a venue the caller already follows. The follow row
   * is left intact; only push_enabled flips. Updating a venue the caller does not
   * follow affects zero rows and returns ok (idempotent no-op) — you cannot tune
   * delivery for something you do not follow.
   */
  setVenuePushEnabled: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const follower_id = await callerId(ctx.db);
      const { error } = await ctx.db
        .from("follows")
        .update({ push_enabled: input.enabled })
        .eq("follower_id", follower_id)
        .eq("venue_id", input.venueId);
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const };
    }),

  /** Venues the caller follows, newest first, with each follow's push preference. */
  myFollows: protectedProcedure
    .query(async ({ ctx }) => {
      const follower_id = await callerId(ctx.db);
      const { data, error } = await ctx.db
        .from("follows")
        .select("venue_id, push_enabled, created_at, venues(id, name, category)")
        .eq("follower_id", follower_id)
        .order("created_at", { ascending: false });
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const, follows: data ?? [] };
    }),

  /** Send a friend request (requester is the caller; addressee is the target). */
  requestFriend: protectedProcedure
    .input(z.object({ addresseeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const requester_id = await callerId(ctx.db);
      const { error } = await ctx.db
        .from("friendships")
        .insert({
          requester_id,
          addressee_id: input.addresseeId,
          status: "pending",
        })
        .select("addressee_id");
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const, status: "pending" as const };
    }),

  /**
   * Respond to a friend request. Accept → status:"accepted". Decline → delete the
   * pending row (no "declined" status exists). The caller must be the addressee; RLS
   * enforces that. We scope the write to (requester=them, addressee=caller).
   */
  respondToFriend: protectedProcedure
    .input(z.object({ requesterId: z.string().uuid(), accept: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const addressee_id = await callerId(ctx.db);
      if (input.accept) {
        const { error } = await ctx.db
          .from("friendships")
          .update({ status: "accepted" })
          .eq("requester_id", input.requesterId)
          .eq("addressee_id", addressee_id);
        if (error) return { ok: false as const, error: error.message };
        return { ok: true as const, status: "accepted" as const };
      }
      const { error } = await ctx.db
        .from("friendships")
        .delete()
        .eq("requester_id", input.requesterId)
        .eq("addressee_id", addressee_id);
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const, status: "declined" as const };
    }),
});
