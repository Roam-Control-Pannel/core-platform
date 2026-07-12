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
      const { data, error } = await ctx.db
        .from("follows")
        .update({ push_enabled: input.enabled })
        .eq("follower_id", follower_id)
        .eq("venue_id", input.venueId)
        .select("venue_id, push_enabled");
      if (error) return { ok: false as const, error: error.message };
      const updated = data?.[0];
      if (!updated) {
        return {
          ok: false as const,
          error: "No follow row updated — not following this venue, or blocked by policy.",
        };
      }
      return { ok: true as const, pushEnabled: updated.push_enabled };
    }),

  /**
   * A venue's followers — count + the most recent profiles — for the owner's dashboard
   * ("see who follows you"). follows_read RLS is public, so this is a straightforward read;
   * we embed the follower profile via the follows -> profiles FK and surface the public card
   * fields. Returns the TOTAL count (not limited) plus the first `limit` followers.
   */
  venueFollowers: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), limit: z.number().int().min(1).max(50).default(12) }))
    .query(async ({ ctx, input }) => {
      type Embed = { id: string; handle: string | null; display_name: string | null; avatar_url: string | null };
      type Row = { follower_id: string; created_at: string; profiles: Embed | Embed[] | null };
      type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const db = ctx.db as unknown as Loose;
      const { data, error, count } = (await db
        .from("follows")
        .select("follower_id, created_at, profiles!follows_follower_id_fkey(id, handle, display_name, avatar_url)", { count: "exact" })
        .eq("venue_id", input.venueId)
        .order("created_at", { ascending: false })
        .limit(input.limit)) as { data: Row[] | null; error: { message: string } | null; count: number | null };
      if (error) return { ok: false as const, error: error.message, count: 0, followers: [] };
      const one = (e: Embed | Embed[] | null): Embed | null => (Array.isArray(e) ? (e[0] ?? null) : e);
      const followers = (data ?? []).map((r) => {
        const p = one(r.profiles);
        return {
          id: p?.id ?? r.follower_id,
          handle: p?.handle ?? null,
          displayName: p?.display_name ?? null,
          avatarUrl: p?.avatar_url ?? null,
        };
      });
      return { ok: true as const, count: count ?? followers.length, followers };
    }),

  /**
   * A venue's follower growth — net new follows per week over the last `weeks` weeks (oldest
   * first, zero-filled), for the dashboard's growth bars. follows_read RLS is public and this
   * is COUNTS only (created_at timestamps aggregated server-side; no follower identity).
   */
  venueFollowerGrowth: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), weeks: z.number().int().min(4).max(12).default(6) }))
    .query(async ({ ctx, input }) => {
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - input.weeks * 7);
      type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const db = ctx.db as unknown as Loose;
      const { data, error } = (await db
        .from("follows")
        .select("created_at")
        .eq("venue_id", input.venueId)
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: true })
        .limit(5000)) as { data: { created_at: string }[] | null; error: { message: string } | null };
      if (error) return { ok: false as const, weeks: [] as { weekStart: string; count: number }[] };
      // Bucket by week, anchored so the LAST bucket ends now (partial current week included).
      const msWeek = 7 * 24 * 60 * 60 * 1000;
      const end = Date.now();
      const buckets: { weekStart: string; count: number }[] = [];
      for (let i = input.weeks - 1; i >= 0; i--) {
        const start = new Date(end - (i + 1) * msWeek);
        buckets.push({ weekStart: start.toISOString().slice(0, 10), count: 0 });
      }
      for (const r of data ?? []) {
        const t = new Date(r.created_at).getTime();
        const idx = input.weeks - 1 - Math.floor((end - t) / msWeek);
        const b = buckets[idx];
        if (b) b.count += 1;
      }
      return { ok: true as const, weeks: buckets };
    }),

  /** Venues the caller follows, newest first, with each follow's push preference. */
  myFollows: protectedProcedure
    .query(async ({ ctx }) => {
      const follower_id = await callerId(ctx.db);
      const { data, error } = await ctx.db
        .from("follows")
        .select("venue_id, push_enabled, created_at, venues(id, name, category, locality, rating, rating_count)")
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

  /**
   * The caller's accepted friends — the OTHER profile in each accepted friendship. RLS scopes
   * friendships to the two parties; we embed both ends and pick the one that isn't the caller.
   */
  myFriends: protectedProcedure.query(async ({ ctx }) => {
    const me = await callerId(ctx.db);
    type Embed = { id: string; handle: string | null; display_name: string | null; avatar_url: string | null };
    type Row = {
      requester_id: string;
      addressee_id: string;
      requester: Embed | Embed[] | null;
      addressee: Embed | Embed[] | null;
    };
    type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const db = ctx.db as unknown as Loose;
    const { data, error } = (await db
      .from("friendships")
      .select(
        "requester_id, addressee_id, requester:profiles!friendships_requester_id_fkey(id, handle, display_name, avatar_url), addressee:profiles!friendships_addressee_id_fkey(id, handle, display_name, avatar_url)",
      )
      .eq("status", "accepted")) as { data: Row[] | null; error: { message: string } | null };
    if (error) return { ok: false as const, error: error.message };
    const one = (e: Embed | Embed[] | null): Embed | null => (Array.isArray(e) ? (e[0] ?? null) : e);
    const friends = (data ?? []).map((r) => {
      const other = r.requester_id === me ? one(r.addressee) : one(r.requester);
      return {
        id: other?.id ?? (r.requester_id === me ? r.addressee_id : r.requester_id),
        handle: other?.handle ?? null,
        displayName: other?.display_name ?? null,
        avatarUrl: other?.avatar_url ?? null,
      };
    });
    return { ok: true as const, friends };
  }),

  /** Incoming pending friend requests (the caller is the addressee), with the requester's profile. */
  friendRequests: protectedProcedure.query(async ({ ctx }) => {
    const me = await callerId(ctx.db);
    type Embed = { id: string; handle: string | null; display_name: string | null; avatar_url: string | null };
    type Row = { requester_id: string; requester: Embed | Embed[] | null; created_at: string };
    type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const db = ctx.db as unknown as Loose;
    const { data, error } = (await db
      .from("friendships")
      .select("requester_id, created_at, requester:profiles!friendships_requester_id_fkey(id, handle, display_name, avatar_url)")
      .eq("addressee_id", me)
      .eq("status", "pending")
      .order("created_at", { ascending: false })) as { data: Row[] | null; error: { message: string } | null };
    if (error) return { ok: false as const, error: error.message };
    const one = (e: Embed | Embed[] | null): Embed | null => (Array.isArray(e) ? (e[0] ?? null) : e);
    const requests = (data ?? []).map((r) => {
      const p = one(r.requester);
      return {
        id: r.requester_id,
        handle: p?.handle ?? null,
        displayName: p?.display_name ?? null,
        avatarUrl: p?.avatar_url ?? null,
        createdAt: r.created_at,
      };
    });
    return { ok: true as const, requests };
  }),

  /**
   * The caller's relationship to another profile — drives the wall "Add friend" button.
   * 'none' | 'friends' | 'pending_out' (caller requested) | 'pending_in' (they requested).
   */
  friendshipStatus: protectedProcedure
    .input(z.object({ otherId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const me = await callerId(ctx.db);
      type Row = { requester_id: string; addressee_id: string; status: string };
      type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const db = ctx.db as unknown as Loose;
      const { data, error } = (await db
        .from("friendships")
        .select("requester_id, addressee_id, status")
        .or(
          `and(requester_id.eq.${me},addressee_id.eq.${input.otherId}),and(requester_id.eq.${input.otherId},addressee_id.eq.${me})`,
        )
        .maybeSingle()) as { data: Row | null; error: { message: string } | null };
      if (error) return { status: "none" as const };
      if (!data) return { status: "none" as const };
      if (data.status === "accepted") return { status: "friends" as const };
      if (data.status === "pending") {
        return { status: data.requester_id === me ? ("pending_out" as const) : ("pending_in" as const) };
      }
      return { status: "none" as const };
    }),
});
