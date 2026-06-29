/**
 * Notifications router — the reader for the recipient-private notifications table (0003),
 * produced by the SECURITY DEFINER triggers in 0032 (wall comments, Town Hall replies, new
 * venue follows). RLS already scopes every row to recipient_id = auth.uid(), so these
 * procedures act safely as the caller on their own notifications.
 *
 *   list        — newest first, for the notification center.
 *   unreadCount — the bell badge.
 *   markAllRead — clear the badge (stamp read_at on all unread).
 *
 * Payloads are denormalised at produce-time to { text, href, actorId }, so the web renders
 * them directly. Inline structural return types (no AppRouter leak).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";

type LooseDb = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null }; error: unknown }> };
};

async function callerId(db: LooseDb): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Could not resolve the signed-in user." });
  }
  return data.user.id;
}

interface RawNotification {
  id: string;
  type: string;
  payload: { text?: unknown; href?: unknown; actorId?: unknown } | null;
  read_at: string | null;
  created_at: string;
}

export const notificationsRouter = router({
  /** Protected: the caller's notifications, newest first. */
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(30) }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const me = await callerId(db);
      const { data, error } = (await db
        .from("notifications")
        .select("id, type, payload, read_at, created_at")
        .eq("recipient_id", me)
        .order("created_at", { ascending: false })
        .limit(input.limit)) as { data: RawNotification[] | null; error: { message: string } | null };
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load notifications: ${error.message}` });
      }
      return {
        notifications: (data ?? []).map((n) => ({
          id: n.id,
          type: n.type,
          text: typeof n.payload?.text === "string" ? n.payload.text : "",
          href: typeof n.payload?.href === "string" ? n.payload.href : null,
          readAt: n.read_at,
          createdAt: n.created_at,
        })),
      };
    }),

  /** Protected: how many unread (the bell badge). */
  unreadCount: protectedProcedure.query(async ({ ctx }) => {
    const db = ctx.db as unknown as LooseDb;
    const me = await callerId(db);
    const { count, error } = (await db
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("recipient_id", me)
      .is("read_at", null)) as { count: number | null; error: { message: string } | null };
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load notifications: ${error.message}` });
    }
    return { count: count ?? 0 };
  }),

  /**
   * Protected (venue owner): send an in-app notification to followers — ALL of them (collective)
   * or ONE specific follower (recipientId). Delegates to send_venue_notification (0042,
   * SECURITY DEFINER), which gates on venue ownership and only lands individual sends on real
   * followers. Returns how many notifications were created.
   */
  sendToFollowers: protectedProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        text: z.string().trim().min(1).max(500),
        recipientId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const { data, error } = await db.rpc("send_venue_notification", {
        p_venue: input.venueId,
        p_text: input.text,
        p_recipient: input.recipientId ?? null,
      });
      if (error) {
        if (error.code === "42501") throw new TRPCError({ code: "FORBIDDEN", message: "Only the venue owner can notify its followers." });
        if (error.code === "P0002") throw new TRPCError({ code: "NOT_FOUND", message: "Venue not found." });
        if (error.code === "22023") throw new TRPCError({ code: "BAD_REQUEST", message: "Write a message to send." });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't send the notification." });
      }
      return { sent: typeof data === "number" ? data : 0 };
    }),

  /** Protected: mark all the caller's unread notifications read. */
  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    const db = ctx.db as unknown as LooseDb;
    const me = await callerId(db);
    const nowIso = new Date().toISOString();
    const { error } = (await db
      .from("notifications")
      .update({ read_at: nowIso })
      .eq("recipient_id", me)
      .is("read_at", null)) as { error: { message: string } | null };
    if (error) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't update notifications." });
    }
    return { ok: true as const };
  }),
});
