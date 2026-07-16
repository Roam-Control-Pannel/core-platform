/**
 * Presence router — friend availability status (PR 1 of "share with friends").
 *
 * A signed-in user broadcasts a lightweight, self-expiring status ("Free for a coffee") that ONLY
 * their accepted friends can see. The friend-only boundary lives in the DATABASE (migration 0092):
 *   - friend_presence is OWNER-ONLY under RLS, so setAvailability / myAvailability write & read the
 *     caller's OWN row under their JWT — no special privilege here.
 *   - friendsAvailability reads friends' statuses ONLY through the friends_availability() SECURITY
 *     DEFINER function, which gates every row behind are_friends(auth.uid(), profile_id). This
 *     router never selects another user's row directly.
 *
 * Write-shape discipline (mirrors social.ts / meetup.ts): profile_id is resolved from the validated
 * JWT and passed explicitly. RLS still enforces profile_id = auth.uid(); passing it is
 * belt-and-braces, not a bypass. The pure status rules (normalise, clear-vs-set, expiry) live in
 * ../presence.js and are unit-tested there.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { RoamClient } from "@roam/db";
import { router, protectedProcedure } from "../trpc.js";
import {
  AVAILABILITY,
  MAX_TTL_HOURS,
  NOTE_MAX,
  buildPresenceRow,
  isLive,
  type Availability,
  type PresenceRow,
} from "../presence.js";

/** A row from the friends_availability() RPC — a friend's live status plus their profile basics.
 *  Internal: procedures map it to an inline literal so the inferred AppRouter type stays portable. */
interface FriendAvailabilityRow {
  profile_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  availability: Availability;
  note: string | null;
  expires_at: string | null;
  updated_at: string;
}

/**
 * Widened surfaces — friend_presence and friends_availability() aren't in the generated DB types
 * until `pnpm db:types` is re-run, so the typed client rejects the table name / rpc name. We widen
 * JUST these calls (the rest of the client stays fully typed) — the same idiom proven in venues.ts.
 */
type LooseRpc = (
  fn: string,
) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose table read, same idiom as venues.ts
type LooseFrom = (t: string) => any;

/** Resolve the caller's auth user id from the validated session JWT (mirrors meetup.ts). */
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

export const presenceRouter = router({
  /**
   * My current status, or null if I've never set one / it's cleared / it has expired. Reads my OWN
   * row under RLS; expiry is re-checked here so the setter UI never shows a stale "Free for a coffee".
   */
  myAvailability: protectedProcedure.query(async ({ ctx }) => {
    const profile_id = await callerId(ctx.db);
    const from = ctx.db.from.bind(ctx.db) as unknown as LooseFrom;
    const { data, error } = await from("friend_presence")
      .select("profile_id, availability, note, expires_at, updated_at")
      .eq("profile_id", profile_id)
      .maybeSingle();
    if (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to load your status: ${error.message}`,
      });
    }
    const row = (data ?? null) as PresenceRow | null;
    if (!row || !isLive(row, Date.now())) return null;
    // Inline literal (not the named PresenceRow) so the inferred AppRouter type stays portable
    // for the web client — the same idiom venues.ts uses for its mapped rows.
    return { availability: row.availability, note: row.note, expires_at: row.expires_at };
  }),

  /**
   * Set (or clear) my availability. `availability: null` clears it — nulls the row so no friend
   * sees a status. Otherwise the status expires after `ttlHours` (default 4h, capped 24h) so it
   * self-clears. One row per profile: upsert on profile_id.
   */
  setAvailability: protectedProcedure
    .input(
      z.object({
        availability: z.enum(AVAILABILITY).nullable(),
        // Accept slightly-over input and normalise/cap server-side rather than reject.
        note: z.string().max(NOTE_MAX + 500).nullish(),
        ttlHours: z.number().int().min(1).max(MAX_TTL_HOURS).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const profile_id = await callerId(ctx.db);
      const from = ctx.db.from.bind(ctx.db) as unknown as LooseFrom;
      const row = buildPresenceRow(profile_id, input, Date.now());

      const { data, error } = await from("friend_presence")
        .upsert(row, { onConflict: "profile_id" })
        .select("profile_id, availability, note, expires_at, updated_at")
        .single();
      if (error || !data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to update your status: ${error?.message ?? "no row returned"}`,
        });
      }
      const saved = data as PresenceRow;
      return { availability: saved.availability, note: saved.note, expires_at: saved.expires_at };
    }),

  /**
   * My accepted friends who currently have a live status. Reads ONLY through the
   * friends_availability() definer function — the sole friend-gated path (are_friends inside).
   * Returns [] when no friend is broadcasting.
   */
  friendsAvailability: protectedProcedure.query(async ({ ctx }) => {
    const rpc = ctx.db.rpc.bind(ctx.db) as unknown as LooseRpc;
    const { data, error } = await rpc("friends_availability");
    if (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to load friends' status: ${error.message}`,
      });
    }
    const rows = (data ?? []) as FriendAvailabilityRow[];
    // Inline literals keep the inferred AppRouter type portable for the web client (see myAvailability).
    return rows.map((r) => ({
      profile_id: r.profile_id,
      handle: r.handle,
      display_name: r.display_name,
      avatar_url: r.avatar_url,
      availability: r.availability,
      note: r.note,
      expires_at: r.expires_at,
    }));
  }),
});
