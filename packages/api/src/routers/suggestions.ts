/**
 * suggestions router — the marketing suggestion engine's read surface (Phase 4, v1 templates).
 *
 * list(venueId) gathers the owner's marketing prefs + per-theme engagement, then runs the pure
 * @roam/core generator to return ready-to-edit offer & post ideas. Returns { enabled:false } when
 * the business hasn't opted in, so the dashboard hides the panel. Owner-scoped: prefs read via RLS,
 * engagement via the owner-checked RPC (non-owner → FORBIDDEN). Inline structural return (no leak).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { generateSuggestions } from "@roam/core/suggestions";
import { router, protectedProcedure } from "../trpc.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }> };

export const suggestionsRouter = router({
  /** Owner: ranked, cap-respecting offer & post suggestions for a venue (empty when opted out). */
  list: protectedProcedure.input(z.object({ venueId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;

    const { data: prefsRow, error: prefsErr } = (await db
      .from("venue_marketing_prefs")
      .select("suggestions_enabled, discount_cap_pct, offer_types, product_notes")
      .eq("venue_id", input.venueId)
      .maybeSingle()) as {
      data: { suggestions_enabled: boolean; discount_cap_pct: number | null; offer_types: string[] | null; product_notes: string | null } | null;
      error: { message: string } | null;
    };
    if (prefsErr) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load prefs: ${prefsErr.message}` });
    }
    if (!prefsRow?.suggestions_enabled) {
      return { enabled: false as const, suggestions: [] as ReturnType<typeof mapSuggestions> };
    }

    const { data: engData, error: engErr } = await db.rpc("venue_offer_engagement", { p_venue: input.venueId });
    if (engErr) {
      if (engErr.code === "42501") throw new TRPCError({ code: "FORBIDDEN", message: "Only the venue owner can view suggestions." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load engagement: ${engErr.message}` });
    }
    const engagement = ((engData ?? []) as { offer_type: string; saves: number | string; redemptions: number | string }[]).map((r) => ({
      offerType: r.offer_type,
      saves: Number(r.saves),
      redemptions: Number(r.redemptions),
    }));

    // Day-of-week in a UK-ish locale (the app's home market); the pure generator can't read a clock.
    const dayName = new Date().toLocaleDateString("en-GB", { weekday: "long" });

    const generated = generateSuggestions({
      discountCapPct: prefsRow.discount_cap_pct ?? null,
      offerTypes: prefsRow.offer_types ?? [],
      productNotes: prefsRow.product_notes ?? null,
      engagement,
      dayName,
    });

    return { enabled: true as const, suggestions: mapSuggestions(generated) };
  }),
});

/** Map core suggestions to an inline structural shape (keeps the named core type out of AppRouter). */
function mapSuggestions(
  list: { id: string; kind: "offer" | "post"; offerType: string | null; title: string; body: string; suggestedDiscountPct: number | null; rationale: string }[],
) {
  return list.map((s) => ({
    id: s.id,
    kind: s.kind,
    offerType: s.offerType,
    title: s.title,
    body: s.body,
    suggestedDiscountPct: s.suggestedDiscountPct,
    rationale: s.rationale,
  }));
}
