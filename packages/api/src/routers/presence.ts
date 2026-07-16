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
import { router, protectedProcedure, escalateToService } from "../trpc.js";
import type { Context } from "../context.js";
import { pushToProfileIds } from "../push/dispatch.js";
import {
  AVAILABILITY,
  DEFAULT_LOCATION_TTL_HOURS,
  MAX_LOCATION_TTL_HOURS,
  MAX_TTL_HOURS,
  NOTE_MAX,
  alertName,
  buildNearbyAlert,
  buildPresenceRow,
  isLive,
  isLocationLive,
  type Availability,
  type PresenceRow,
} from "../presence.js";

/** Radius + cooldown for proximity alerts. 5 km catches "in the same town"; 3 h stops re-nagging. */
const ALERT_RADIUS_M = 5000;
const ALERT_COOLDOWN_SECS = 3 * 60 * 60;

/**
 * Best-effort proximity ping (PR 3): if the caller is currently free_to_meet AND sharing a live
 * location, notify their nearby location-sharing friends ("{name} is nearby and free"). The DB
 * function claim_nearby_alert_targets does the whole gate — caller-state check, are_friends filter,
 * radius, and per-pair throttle — atomically, and returns only the ids to notify. We then fan the
 * web-push out via the service client. NEVER throws into the mutation: a push problem must not fail
 * "set my status". Fire-and-forget from the caller (this is a persistent Node service).
 */
async function pingNearbyFriends(ctx: Context, callerId: string): Promise<void> {
  const rpc = ctx.db.rpc.bind(ctx.db) as unknown as LooseRpc;
  const { data, error } = await rpc("claim_nearby_alert_targets", {
    radius_m: ALERT_RADIUS_M,
    cooldown_secs: ALERT_COOLDOWN_SECS,
  });
  if (error || !data) return;
  const targetIds = (data as { profile_id: string }[]).map((r) => r.profile_id).filter(Boolean);
  if (targetIds.length === 0) return;

  const service = escalateToService(ctx.env);
  const { data: prof } = await service
    .from("profiles")
    .select("display_name, handle")
    .eq("id", callerId)
    .single();
  const name = alertName(prof?.display_name ?? null, prof?.handle ?? null);
  await pushToProfileIds(service, ctx.env.vapid, targetIds, buildNearbyAlert(name));
}

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

/** A row from the friends_nearby() RPC — a friend sharing a live location, plus optional status. */
interface FriendNearbyRow {
  profile_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  availability: Availability | null;
  note: string | null;
  lat: number;
  lng: number;
  distance_m: number;
  geo_expires_at: string | null;
}

/**
 * Widened surfaces — the friend_presence table and its functions aren't in the generated DB types
 * until `pnpm db:types` is re-run, so the typed client rejects the table name / rpc names. We widen
 * JUST these calls (the rest of the client stays fully typed) — the same idiom proven in venues.ts.
 */
type LooseRpc = (
  fn: string,
  args?: Record<string, unknown>,
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
      // Proximity ping: only when the new status is "free to meet". The DB re-checks that the caller
      // is also sharing a live location, so setting a status without sharing simply notifies no one.
      // Fire-and-forget — it must never block or fail the "set status" response.
      if (saved.availability === "free_to_meet") {
        void pingNearbyFriends(ctx, profile_id).catch(() => {});
      }
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

  // ── Live location sharing (PR 2) — ephemeral, precise, time-boxed ──────────────────────────────

  /**
   * Share my precise location with my friends for a bounded window (default 1h, capped 8h). Writes
   * via the set_my_location definer function (constructs the point in SQL, scoped to auth.uid());
   * touches only the geo_* columns, so an availability status is left intact. Returns when the share
   * expires.
   */
  shareLocation: protectedProcedure
    .input(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracyM: z.number().min(0).max(100_000).nullish(),
        ttlHours: z.number().int().min(1).max(MAX_LOCATION_TTL_HOURS).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const uid = await callerId(ctx.db);
      const rpc = ctx.db.rpc.bind(ctx.db) as unknown as LooseRpc;
      const { data, error } = await rpc("set_my_location", {
        p_lat: input.lat,
        p_lng: input.lng,
        p_accuracy_m: input.accuracyM ?? null,
        p_ttl_hours: input.ttlHours ?? DEFAULT_LOCATION_TTL_HOURS,
      });
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to share your location: ${error.message}`,
        });
      }
      // Now sharing a live location — if the caller is also free_to_meet, this pings nearby friends
      // (the DB gate no-ops otherwise). Fire-and-forget; never blocks the response.
      void pingNearbyFriends(ctx, uid).catch(() => {});
      return { expiresAt: (data ?? null) as string | null };
    }),

  /** Stop sharing my location — nulls the coordinate outright. No-op if I wasn't sharing. */
  stopSharingLocation: protectedProcedure.mutation(async ({ ctx }) => {
    const rpc = ctx.db.rpc.bind(ctx.db) as unknown as LooseRpc;
    const { error } = await rpc("stop_my_location", {});
    if (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to stop sharing: ${error.message}`,
      });
    }
    return { stopped: true as const };
  }),

  /** Whether I'm currently sharing my location, and until when. Reads my OWN row under RLS. */
  myLocationShare: protectedProcedure.query(async ({ ctx }) => {
    const profile_id = await callerId(ctx.db);
    const from = ctx.db.from.bind(ctx.db) as unknown as LooseFrom;
    const { data, error } = await from("friend_presence")
      .select("geo_expires_at")
      .eq("profile_id", profile_id)
      .maybeSingle();
    if (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to load your location share: ${error.message}`,
      });
    }
    const geoExpiresAt = ((data as { geo_expires_at?: string | null } | null)?.geo_expires_at ?? null);
    return isLocationLive(geoExpiresAt, Date.now())
      ? { sharing: true as const, expiresAt: geoExpiresAt }
      : { sharing: false as const, expiresAt: null };
  }),

  /**
   * My accepted friends currently sharing a live location within `radiusM` of the given origin
   * (my current position, passed by the client — never stored by this read). Near→far. Reads ONLY
   * through the friends_nearby() definer function (are_friends inside). Returns [] when none.
   */
  friendsNearby: protectedProcedure
    .input(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radiusM: z.number().min(100).max(50_000).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rpc = ctx.db.rpc.bind(ctx.db) as unknown as LooseRpc;
      const { data, error } = await rpc("friends_nearby", {
        origin_lat: input.lat,
        origin_lng: input.lng,
        radius_m: input.radiusM ?? 5000,
      });
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to load nearby friends: ${error.message}`,
        });
      }
      const rows = (data ?? []) as FriendNearbyRow[];
      // Inline literals keep the inferred AppRouter type portable for the web client.
      return rows.map((r) => ({
        profile_id: r.profile_id,
        handle: r.handle,
        display_name: r.display_name,
        avatar_url: r.avatar_url,
        availability: r.availability,
        note: r.note,
        lat: r.lat,
        lng: r.lng,
        distance_m: r.distance_m,
        geo_expires_at: r.geo_expires_at,
      }));
    }),
});
