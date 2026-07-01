/**
 * venueMarketing router — a venue's marketing preferences (the claim-time onboarding answers).
 *
 * get returns the prefs (or a sensible default with onboarded:false when the wizard hasn't run, so
 * the dashboard knows to show the first-run prompt). set upserts the row and can stamp onboarded_at
 * (completing OR dismissing the wizard both count as onboarded, so it stops nagging). Owner-only via
 * RLS (vmp_owner_all → owner_id = auth.uid()). Inline structural returns (no AppRouter leak).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { OFFER_TYPES } from "@roam/core/offers";
import { router, protectedProcedure } from "../trpc.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = { from: (t: string) => any };

export const venueMarketingRouter = router({
  /** Owner: read a venue's marketing prefs (defaults with onboarded:false when never set). */
  get: protectedProcedure.input(z.object({ venueId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = (await db
      .from("venue_marketing_prefs")
      .select("suggestions_enabled, discount_cap_pct, offer_types, product_notes, onboarded_at")
      .eq("venue_id", input.venueId)
      .maybeSingle()) as {
      data: { suggestions_enabled: boolean; discount_cap_pct: number | null; offer_types: string[] | null; product_notes: string | null; onboarded_at: string | null } | null;
      error: { message: string } | null;
    };
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load marketing prefs: ${error.message}` });
    }
    return {
      suggestionsEnabled: data?.suggestions_enabled ?? false,
      discountCapPct: data?.discount_cap_pct ?? null,
      offerTypes: data?.offer_types ?? [],
      productNotes: data?.product_notes ?? null,
      onboarded: data?.onboarded_at != null,
    };
  }),

  /** Owner: upsert a venue's marketing prefs. markOnboarded stamps onboarded_at (once). */
  set: protectedProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        suggestionsEnabled: z.boolean().optional(),
        discountCapPct: z.number().int().min(0).max(50).nullable().optional(),
        offerTypes: z.array(z.enum([...OFFER_TYPES] as [string, ...string[]])).max(20).optional(),
        productNotes: z.string().max(2000).nullable().optional(),
        markOnboarded: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = { venue_id: input.venueId };
      if (input.suggestionsEnabled !== undefined) patch["suggestions_enabled"] = input.suggestionsEnabled;
      if ("discountCapPct" in input) patch["discount_cap_pct"] = input.discountCapPct ?? null;
      if (input.offerTypes !== undefined) patch["offer_types"] = input.offerTypes;
      if ("productNotes" in input) patch["product_notes"] = input.productNotes ?? null;
      if (input.markOnboarded) patch["onboarded_at"] = new Date().toISOString();

      const db = ctx.db as unknown as LooseDb;
      const { error } = await db
        .from("venue_marketing_prefs")
        .upsert(patch, { onConflict: "venue_id" })
        .select("venue_id");
      if (error) {
        if ((error as { code?: string }).code === "42501") throw new TRPCError({ code: "FORBIDDEN", message: "Only the venue owner can do that." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to save marketing prefs: ${(error as { message: string }).message}` });
      }
      return { ok: true as const };
    }),
});
