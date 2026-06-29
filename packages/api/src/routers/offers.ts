/**
 * Offers router — exclusive deals a business publishes to people who follow it.
 *
 * Following a venue opts you into its loyalty deals; this is the read side of that promise.
 * `forFollowed` resolves the caller's follows server-side and returns the LIVE offers (inside
 * their validity window) from exactly those venues — so the Home "Followed venues" widget can
 * surface "here are the deals from businesses you follow" in one call.
 *
 * Protected: your follow set is yours. RLS already makes offers world-readable and follows
 * caller-scoped; this resolver just joins the two and applies the active-window filter. The
 * returned objects are inline structural types (no named-type leak into AppRouter).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

/** Resolve the signed-in caller (writes/private reads). RLS is the real gate; this 401s nicely. */
async function callerId(ctx: { db: { auth: { getUser: () => Promise<{ data: { user: { id: string } | null }; error: unknown }> } } }): Promise<string> {
  const { data, error } = await ctx.db.auth.getUser();
  if (error || !data.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Could not resolve the signed-in user." });
  }
  return data.user.id;
}

export const offersRouter = router({
  /** Public: a single venue's LIVE offers (its "Offers" tab). Offers are world-readable (RLS). */
  forVenue: publicProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const nowIso = new Date().toISOString();
      const { data, error } = await ctx.db
        .from("offers")
        .select("id, title, details, code, starts_at, ends_at")
        .eq("venue_id", input.venueId)
        .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
        .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load offers: ${error.message}` });
      }
      return (data ?? []).map((o) => ({
        id: o.id,
        title: o.title,
        details: o.details,
        code: o.code,
        startsAt: o.starts_at,
        endsAt: o.ends_at,
      }));
    }),

  /** Protected: live offers from the venues the caller follows, newest first. */
  forFollowed: protectedProcedure.query(async ({ ctx }) => {
    const me = await callerId(ctx);

    // 1. The venues the caller follows.
    const { data: follows, error: fErr } = await ctx.db
      .from("follows")
      .select("venue_id")
      .eq("follower_id", me);
    if (fErr) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your follows: ${fErr.message}` });
    }
    const venueIds = (follows ?? []).map((f) => f.venue_id);
    if (venueIds.length === 0) return [];

    // 2. Live offers from those venues. "Live" = inside the validity window: a null bound is
    //    open-ended (no start → already started; no end → never ends). The two .or() groups
    //    AND together in PostgREST. now() is evaluated here (the router runs in Node).
    const nowIso = new Date().toISOString();
    const { data, error } = await ctx.db
      .from("offers")
      .select("id, venue_id, title, details, code, starts_at, ends_at, venues(name)")
      .in("venue_id", venueIds)
      .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
      .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load deals: ${error.message}` });
    }

    // PostgREST returns the embedded venue as an object for a to-one FK (or, defensively, an
    // array) — read through unknown and normalise, the same idiom as posts.feed.
    type EmbeddedVenue = { name: string };
    return (data ?? []).map((o) => {
      const raw = (o as { venues?: unknown }).venues;
      const v: EmbeddedVenue | null = Array.isArray(raw)
        ? ((raw[0] as EmbeddedVenue | undefined) ?? null)
        : ((raw as EmbeddedVenue | null) ?? null);
      return {
        id: o.id,
        venueId: o.venue_id,
        venueName: v?.name ?? null,
        title: o.title,
        details: o.details,
        code: o.code,
        startsAt: o.starts_at,
        endsAt: o.ends_at,
      };
    });
  }),
});
