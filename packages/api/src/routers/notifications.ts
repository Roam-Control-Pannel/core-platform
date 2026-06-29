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
