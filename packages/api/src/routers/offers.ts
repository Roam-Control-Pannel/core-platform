/**
 * Offers router — exclusive deals a business publishes, plus the save + redeem loop.
 *
 * Reads (public): forVenue (a venue's live offers, with the caller's saved/redeemed state merged
 * when signed in) and forFollowed (live deals from venues you follow). Owner writes: create /
 * update / remove / mine — RLS `offers_owner_all` gates every write to the venue's owner. Consumer
 * writes: save / unsave (offer_saves, RLS owner-of-row), saved (your saved deals), and redeem.
 *
 * Redemption is the one guarded write: offer_redemptions has no insert policy, so redeem() calls
 * the redeem_offer() SECURITY DEFINER RPC (0046), which enforces the live window, one-per-user and
 * the max_redemptions cap. Every resolver returns inline structural types (no AppRouter leak).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { OFFER_TYPES } from "@roam/core/offers";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

/** Resolve the signed-in caller (writes/private reads). RLS is the real gate; this 401s nicely. */
async function callerId(ctx: { db: { auth: { getUser: () => Promise<{ data: { user: { id: string } | null }; error: unknown }> } } }): Promise<string> {
  const { data, error } = await ctx.db.auth.getUser();
  if (error || !data.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Could not resolve the signed-in user." });
  }
  return data.user.id;
}

/** Best-effort caller id for public reads that merge per-user state (null when anonymous). */
async function maybeCallerId(ctx: { db: { auth: { getUser: () => Promise<{ data: { user: { id: string } | null }; error: unknown }> } } }): Promise<string | null> {
  try {
    const { data } = await ctx.db.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

const offerInput = z.object({
  title: z.string().trim().min(1).max(120),
  details: z.string().trim().max(1000).nullable().optional(),
  code: z.string().trim().max(40).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
  // Theme (from the canonical @roam/core set) + the headline % for a percent_off deal.
  offerType: z.enum([...OFFER_TYPES] as [string, ...string[]]).nullable().optional(),
  discountPct: z.number().min(0).max(100).nullable().optional(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }> };

export const offersRouter = router({
  /**
   * Public: a single venue's LIVE offers (its "Offers" tab). World-readable (RLS). When the caller
   * is signed in, each offer carries their `saved` + `redeemed` state so the buttons render right.
   */
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
      const rows = data ?? [];
      const me = await maybeCallerId(ctx);
      const { saved, redeemed } = await callerOfferState(ctx.db as unknown as LooseDb, me, rows.map((o) => o.id));
      return rows.map((o) => ({
        id: o.id,
        title: o.title,
        details: o.details,
        code: o.code,
        startsAt: o.starts_at,
        endsAt: o.ends_at,
        saved: saved.has(o.id),
        redeemed: redeemed.has(o.id),
      }));
    }),

  /** Protected: live offers from the venues the caller follows, newest first (+ saved/redeemed). */
  forFollowed: protectedProcedure.query(async ({ ctx }) => {
    const me = await callerId(ctx);
    const { data: follows, error: fErr } = await ctx.db.from("follows").select("venue_id").eq("follower_id", me);
    if (fErr) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your follows: ${fErr.message}` });
    }
    const venueIds = (follows ?? []).map((f) => f.venue_id);
    if (venueIds.length === 0) return [];
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
    const rows = data ?? [];
    const { saved, redeemed } = await callerOfferState(ctx.db as unknown as LooseDb, me, rows.map((o) => o.id));
    type EmbeddedVenue = { name: string };
    return rows.map((o) => {
      const raw = (o as { venues?: unknown }).venues;
      const v: EmbeddedVenue | null = Array.isArray(raw) ? ((raw[0] as EmbeddedVenue | undefined) ?? null) : ((raw as EmbeddedVenue | null) ?? null);
      return {
        id: o.id,
        venueId: o.venue_id,
        venueName: v?.name ?? null,
        title: o.title,
        details: o.details,
        code: o.code,
        startsAt: o.starts_at,
        endsAt: o.ends_at,
        saved: saved.has(o.id),
        redeemed: redeemed.has(o.id),
      };
    });
  }),

  /** Protected: the caller's saved offers (their "Saved deals"), newest-saved first. */
  saved: protectedProcedure.query(async ({ ctx }) => {
    const me = await callerId(ctx);
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = (await db
      .from("offer_saves")
      .select("offer_id, created_at, offers(id, venue_id, title, details, code, starts_at, ends_at, venues(name, slug))")
      .eq("profile_id", me)
      .order("created_at", { ascending: false })
      .limit(50)) as { data: any[] | null; error: { message: string } | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load saved deals: ${error.message}` });
    }
    const rows = (data ?? []).filter((r) => r.offers);
    const { redeemed } = await callerOfferState(db, me, rows.map((r) => r.offers.id));
    return rows.map((r) => {
      const o = r.offers;
      const ven = Array.isArray(o.venues) ? o.venues[0] : o.venues;
      return {
        id: o.id as string,
        venueId: o.venue_id as string,
        venueName: (ven?.name ?? null) as string | null,
        venueSlug: (ven?.slug ?? null) as string | null,
        title: o.title as string,
        details: (o.details ?? null) as string | null,
        code: (o.code ?? null) as string | null,
        startsAt: (o.starts_at ?? null) as string | null,
        endsAt: (o.ends_at ?? null) as string | null,
        saved: true as const,
        redeemed: redeemed.has(o.id),
      };
    });
  }),

  /** Protected: save an offer (idempotent — saving an already-saved offer is a no-op success). */
  save: protectedProcedure.input(z.object({ offerId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const me = await callerId(ctx);
    const { error } = await ctx.db.from("offer_saves").insert({ offer_id: input.offerId, profile_id: me });
    if (error && (error as { code?: string }).code !== "23505") {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't save that offer: ${error.message}` });
    }
    return { ok: true as const };
  }),

  /** Protected: remove a saved offer. */
  unsave: protectedProcedure.input(z.object({ offerId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const me = await callerId(ctx);
    const { error } = await ctx.db.from("offer_saves").delete().eq("offer_id", input.offerId).eq("profile_id", me);
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't unsave that offer: ${error.message}` });
    }
    return { ok: true as const };
  }),

  /**
   * Protected: redeem an offer via the redeem_offer RPC (0046) — enforces the live window,
   * one-per-user and the max_redemptions cap. Returns the outcome + the code on success.
   */
  redeem: protectedProcedure.input(z.object({ offerId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    await callerId(ctx);
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = await db.rpc("redeem_offer", { p_offer: input.offerId });
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't redeem that offer. Please try again." });
    }
    const res = (data ?? {}) as { ok?: boolean; reason?: string; alreadyRedeemed?: boolean; redeemedAt?: string | null; code?: string | null };
    if (!res.ok) {
      if (res.reason === "not_found") throw new TRPCError({ code: "NOT_FOUND", message: "That offer no longer exists." });
      if (res.reason === "not_active") return { ok: false as const, reason: "expired" as const };
      if (res.reason === "sold_out") return { ok: false as const, reason: "sold_out" as const };
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to redeem this offer." });
    }
    return {
      ok: true as const,
      alreadyRedeemed: !!res.alreadyRedeemed,
      redeemedAt: res.redeemedAt ?? null,
      code: res.code ?? null,
    };
  }),

  /* ── Owner: manage a venue's offers ──────────────────────────────────────────────────────── */

  /** Owner: every offer for a venue you own, newest first, each with its redemption count. */
  mine: protectedProcedure.input(z.object({ venueId: z.string().uuid() })).query(async ({ ctx, input }) => {
    await callerId(ctx);
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = (await db
      .from("offers")
      .select("id, title, details, code, starts_at, ends_at, max_redemptions, created_at, offer_type, discount_pct, offer_redemptions(count), offer_saves(count)")
      .eq("venue_id", input.venueId)
      .order("created_at", { ascending: false })) as { data: any[] | null; error: { message: string } | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your offers: ${error.message}` });
    }
    // PostgREST returns an embedded count either as [{ count }] or { count } depending on shape.
    const countOf = (v: unknown): number => (Array.isArray(v) ? (v[0]?.count ?? 0) : ((v as { count?: number } | null)?.count ?? 0));
    return (data ?? []).map((o) => ({
      id: o.id as string,
      title: o.title as string,
      details: (o.details ?? null) as string | null,
      code: (o.code ?? null) as string | null,
      startsAt: (o.starts_at ?? null) as string | null,
      endsAt: (o.ends_at ?? null) as string | null,
      maxRedemptions: (o.max_redemptions ?? null) as number | null,
      offerType: (o.offer_type ?? null) as string | null,
      discountPct: (o.discount_pct ?? null) as number | null,
      saves: countOf(o.offer_saves),
      redemptions: countOf(o.offer_redemptions),
    }));
  }),

  /** Owner: publish a new offer on a venue you own (RLS offers_owner_all gates the write). */
  create: protectedProcedure
    .input(offerInput.extend({ venueId: z.string().uuid(), notifyFollowers: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      await callerId(ctx);
      // Loose db: offer_type/discount_pct (0048) + notify_followers (0103) aren't in the generated
      // types until they're regenerated post-migration; RLS offers_owner_all still gates the write.
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = await db
        .from("offers")
        .insert({
          venue_id: input.venueId,
          title: input.title,
          details: input.details ?? null,
          code: input.code ?? null,
          starts_at: input.startsAt ?? null,
          ends_at: input.endsAt ?? null,
          max_redemptions: input.maxRedemptions ?? null,
          offer_type: input.offerType ?? null,
          discount_pct: input.discountPct ?? null,
          // Opt-in: fan the offer out to the venue's followers' bells (trigger notify_offer_followers).
          notify_followers: input.notifyFollowers,
        })
        .select("id")
        .single();
      if (error) {
        if ((error as { code?: string }).code === "42501") throw new TRPCError({ code: "FORBIDDEN", message: "Only the venue owner can post offers." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't publish the offer: ${error.message}` });
      }
      return { id: (data as { id: string }).id };
    }),

  /** Owner: edit one of your offers. */
  update: protectedProcedure
    .input(offerInput.partial().extend({ offerId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await callerId(ctx);
      const patch: { title?: string; details?: string | null; code?: string | null; starts_at?: string | null; ends_at?: string | null; max_redemptions?: number | null; offer_type?: string | null; discount_pct?: number | null } = {};
      if (input.title !== undefined) patch.title = input.title;
      if ("details" in input) patch.details = input.details ?? null;
      if ("code" in input) patch.code = input.code ?? null;
      if ("startsAt" in input) patch.starts_at = input.startsAt ?? null;
      if ("endsAt" in input) patch.ends_at = input.endsAt ?? null;
      if ("maxRedemptions" in input) patch.max_redemptions = input.maxRedemptions ?? null;
      if ("offerType" in input) patch.offer_type = input.offerType ?? null;
      if ("discountPct" in input) patch.discount_pct = input.discountPct ?? null;
      if (Object.keys(patch).length === 0) return { ok: true as const };
      const db = ctx.db as unknown as LooseDb;
      const { error } = await db.from("offers").update(patch).eq("id", input.offerId);
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't update the offer: ${error.message}` });
      }
      return { ok: true as const };
    }),

  /** Owner: delete one of your offers (cascades to its saves + redemptions). */
  remove: protectedProcedure.input(z.object({ offerId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    await callerId(ctx);
    const { error } = await ctx.db.from("offers").delete().eq("id", input.offerId);
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't delete the offer: ${error.message}` });
    }
    return { ok: true as const };
  }),

  /**
   * Owner: per-theme engagement for a venue you own — how many offers, saves and redemptions each
   * offer THEME has drawn. Powers the dashboard "what's working" panel and, later, ranks
   * suggestions. The venue_offer_engagement RPC (0048) does the owner check + aggregation; a
   * non-owner comes back 42501 → FORBIDDEN.
   */
  engagement: protectedProcedure.input(z.object({ venueId: z.string().uuid() })).query(async ({ ctx, input }) => {
    await callerId(ctx);
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = await db.rpc("venue_offer_engagement", { p_venue: input.venueId });
    if (error) {
      if (error.code === "42501") throw new TRPCError({ code: "FORBIDDEN", message: "Only the venue owner can view offer insights." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load offer insights: ${error.message}` });
    }
    const rows = (data ?? []) as { offer_type: string; offers: number | string; saves: number | string; redemptions: number | string }[];
    const themes = rows
      .map((r) => ({
        offerType: r.offer_type,
        offers: Number(r.offers),
        saves: Number(r.saves),
        redemptions: Number(r.redemptions),
      }))
      .sort((a, b) => b.saves - a.saves || b.redemptions - a.redemptions);
    const totals = themes.reduce(
      (acc, t) => ({ offers: acc.offers + t.offers, saves: acc.saves + t.saves, redemptions: acc.redemptions + t.redemptions }),
      { offers: 0, saves: 0, redemptions: 0 },
    );
    return { themes, totals };
  }),
});

/** The caller's saved + redeemed offer ids among a set (empty sets when anonymous / no ids). */
async function callerOfferState(db: LooseDb, me: string | null, offerIds: string[]): Promise<{ saved: Set<string>; redeemed: Set<string> }> {
  if (!me || offerIds.length === 0) return { saved: new Set(), redeemed: new Set() };
  const [savesRes, redsRes] = await Promise.all([
    db.from("offer_saves").select("offer_id").eq("profile_id", me).in("offer_id", offerIds),
    db.from("offer_redemptions").select("offer_id").eq("profile_id", me).in("offer_id", offerIds),
  ]);
  const saved = new Set<string>(((savesRes.data ?? []) as { offer_id: string }[]).map((r) => r.offer_id));
  const redeemed = new Set<string>(((redsRes.data ?? []) as { offer_id: string }[]).map((r) => r.offer_id));
  return { saved, redeemed };
}
