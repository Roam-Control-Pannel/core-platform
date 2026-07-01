/**
 * venueActivity router — the Business Activity Centre feed.
 *
 * A venue owner's dashboard reads the per-venue activity stream (new follows, offer saves, offer
 * redemptions) written by the 0049 triggers. Owner-scoping is enforced by RLS
 * (venue_activity_owner_read → owner_id = auth.uid()), so a non-owner simply sees an empty feed /
 * zero unread. markRead escalates through the mark_venue_activity_read RPC (owner-checked there).
 * Every resolver returns inline structural types (no AppRouter leak).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }> };

export const venueActivityRouter = router({
  /** Owner: a venue's recent activity, newest first (RLS scopes to venues you own). */
  list: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), limit: z.number().int().min(1).max(50).default(30) }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("venue_activity")
        .select("id, type, payload, created_at, read_at, actor:profiles!venue_activity_actor_id_fkey(handle, display_name, avatar_url)")
        .eq("venue_id", input.venueId)
        .order("created_at", { ascending: false })
        .limit(input.limit)) as { data: any[] | null; error: { message: string } | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load activity: ${error.message}` });
      }
      return (data ?? []).map((r) => {
        const a = Array.isArray(r.actor) ? r.actor[0] : r.actor;
        const payload = (r.payload ?? {}) as { offerId?: string; offerTitle?: string };
        return {
          id: r.id as string,
          type: r.type as string,
          createdAt: r.created_at as string,
          read: r.read_at != null,
          offerTitle: (payload.offerTitle ?? null) as string | null,
          actor: a
            ? {
                handle: (a.handle ?? null) as string | null,
                displayName: (a.display_name ?? null) as string | null,
                avatarUrl: (a.avatar_url ?? null) as string | null,
              }
            : null,
        };
      });
    }),

  /** Owner: how many unread activity items a venue has (drives the dashboard badge). */
  unreadCount: protectedProcedure.input(z.object({ venueId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;
    const { count, error } = (await db
      .from("venue_activity")
      .select("id", { count: "exact", head: true })
      .eq("venue_id", input.venueId)
      .is("read_at", null)) as { count: number | null; error: { message: string } | null };
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to count activity: ${error.message}` });
    }
    return { count: count ?? 0 };
  }),

  /** Owner: mark a venue's activity all-read. Returns how many were cleared. */
  markRead: protectedProcedure.input(z.object({ venueId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const db = ctx.db as unknown as LooseDb;
    const { data, error } = await db.rpc("mark_venue_activity_read", { p_venue: input.venueId });
    if (error) {
      if (error.code === "42501") throw new TRPCError({ code: "FORBIDDEN", message: "Only the venue owner can do that." });
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to mark read: ${error.message}` });
    }
    return { cleared: Number(data ?? 0) };
  }),
});
