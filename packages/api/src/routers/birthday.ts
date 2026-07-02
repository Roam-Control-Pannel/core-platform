/**
 * birthday router — the CONSUMER side of birthday treats (a user's own grants).
 *
 * mine: the caller's live birthday treats (delivered, not expired) — read straight from
 * birthday_deliveries under its self-select RLS (user_id = auth.uid()), joined to the venue name.
 * redeem: mark the caller's live grant for a venue redeemed, via the redeem_birthday_offer RPC
 * (controlled write). A business never appears here — this is the user's wallet of treats.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }> };

export const birthdayRouter = router({
  /** The caller's live birthday treats (not yet expired), newest first. */
  mine: protectedProcedure.query(async ({ ctx }) => {
    const db = ctx.db as unknown as LooseDb;
    const todayIso = new Date().toISOString().slice(0, 10);
    const { data, error } = (await db
      .from("birthday_deliveries")
      .select("venue_id, title, code, expires_at, redeemed_at, delivered_on, venues(name, slug)")
      .gte("expires_at", todayIso)
      .order("delivered_on", { ascending: false })) as { data: any[] | null; error: { message: string } | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your birthday treats: ${error.message}` });
    }
    return (data ?? []).map((r) => {
      const v = Array.isArray(r.venues) ? r.venues[0] : r.venues;
      return {
        venueId: r.venue_id as string,
        venueName: (v?.name ?? null) as string | null,
        venueSlug: (v?.slug ?? null) as string | null,
        title: (r.title ?? null) as string | null,
        code: (r.code ?? null) as string | null,
        expiresAt: (r.expires_at ?? null) as string | null,
        redeemed: r.redeemed_at != null,
      };
    });
  }),

  /** Redeem the caller's live birthday treat for a venue. Idempotent (returns the same code). */
  redeem: protectedProcedure.input(z.object({ venueId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = await db.rpc("redeem_birthday_offer", { p_venue: input.venueId });
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't redeem that treat: ${error.message}` });
    }
    const d = (data ?? {}) as { ok?: boolean; reason?: string; alreadyRedeemed?: boolean; code?: string | null };
    if (!d.ok) return { ok: false as const, reason: (d.reason ?? "none") as string };
    return { ok: true as const, alreadyRedeemed: !!d.alreadyRedeemed, code: d.code ?? null };
  }),
});
