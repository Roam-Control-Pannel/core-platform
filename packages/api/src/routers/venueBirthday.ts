/**
 * venueBirthday router — a business's standing birthday-treat config + delivery counts.
 *
 * getOffer/setOffer manage the treat (owner-only via RLS on venue_birthday_offer). stats returns
 * how many birthday offers have been delivered (this month / total) via the owner-gated
 * venue_birthday_stats RPC — counts only, never who received one. The actual delivery is done by
 * the deliver_birthday_offers() job (scheduled daily), not from here. Inline structural returns.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }> };

export const venueBirthdayRouter = router({
  /** Owner: read a venue's birthday-treat config (defaults when never set). */
  getOffer: protectedProcedure.input(z.object({ venueId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = (await db
      .from("venue_birthday_offer")
      .select("enabled, title, details")
      .eq("venue_id", input.venueId)
      .maybeSingle()) as { data: { enabled: boolean; title: string | null; details: string | null } | null; error: { message: string } | null };
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load birthday offer: ${error.message}` });
    }
    return {
      enabled: data?.enabled ?? false,
      title: data?.title ?? null,
      details: data?.details ?? null,
    };
  }),

  /** Owner: upsert a venue's birthday-treat config (owner-gated by RLS). */
  setOffer: protectedProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        enabled: z.boolean().optional(),
        title: z.string().trim().max(120).nullable().optional(),
        details: z.string().trim().max(500).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = { venue_id: input.venueId };
      if (input.enabled !== undefined) patch["enabled"] = input.enabled;
      if ("title" in input) patch["title"] = input.title ?? null;
      if ("details" in input) patch["details"] = input.details ?? null;

      const db = ctx.db as unknown as LooseDb;
      const { error } = await db.from("venue_birthday_offer").upsert(patch, { onConflict: "venue_id" }).select("venue_id");
      if (error) {
        if ((error as { code?: string }).code === "42501") throw new TRPCError({ code: "FORBIDDEN", message: "Only the venue owner can do that." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to save birthday offer: ${(error as { message: string }).message}` });
      }
      return { ok: true as const };
    }),

  /** Owner: how many birthday offers have been delivered (counts only). */
  stats: protectedProcedure.input(z.object({ venueId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = await db.rpc("venue_birthday_stats", { p_venue: input.venueId });
    if (error) {
      if (error.code === "42501") throw new TRPCError({ code: "FORBIDDEN", message: "Only the venue owner can view this." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load birthday stats: ${error.message}` });
    }
    const d = (data ?? {}) as { sentThisMonth?: number; sentTotal?: number };
    return { sentThisMonth: Number(d.sentThisMonth ?? 0), sentTotal: Number(d.sentTotal ?? 0) };
  }),
});
