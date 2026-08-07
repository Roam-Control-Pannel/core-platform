/**
 * savedStops router — a person's bookmarked Translink stops (Stage 5 · Slice E).
 *
 * A saved stop is Roam's OWN data, not Translink's: the opaque EFA stop id plus a snapshot of the
 * name/coords so the "Saved stops" list renders without a live board lookup. Private to the owner —
 * every procedure is protected, and RLS on `saved_transit_stops` scopes each read/write to the
 * caller's own rows (`profile_id = auth.uid()`), so a client can never touch someone else's list.
 *
 * The stop id/name/coords come from the departures board the user is looking at; there's no server
 * validation against Translink (the id is opaque and the whole feature is best-effort), so we simply
 * store the snapshot the client hands us, bounded by zod.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { RoamClient } from "@roam/db";
import { router, protectedProcedure } from "../trpc.js";

/** Resolve the caller's auth user id from the validated session JWT. */
async function callerId(db: RoamClient): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Could not resolve the signed-in user." });
  }
  return data.user.id;
}

export const savedStopsRouter = router({
  /** The caller's saved stops, newest first. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const profile_id = await callerId(ctx.db);
    const { data, error } = await ctx.db
      .from("saved_transit_stops")
      .select("stop_id, name, lat, lng, created_at")
      .eq("profile_id", profile_id)
      .order("created_at", { ascending: false });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, stops: data ?? [] };
  }),

  /** Save a stop (idempotent on the owner+stop key — re-saving refreshes the name/coords snapshot). */
  save: protectedProcedure
    .input(
      z.object({
        stopId: z.string().min(1).max(120),
        name: z.string().min(1).max(200),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const profile_id = await callerId(ctx.db);
      const { error } = await ctx.db
        .from("saved_transit_stops")
        .upsert({ profile_id, stop_id: input.stopId, name: input.name, lat: input.lat, lng: input.lng });
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const };
    }),

  /** Remove a saved stop. RLS scopes the delete to the caller's own row. */
  remove: protectedProcedure
    .input(z.object({ stopId: z.string().min(1).max(120) }))
    .mutation(async ({ ctx, input }) => {
      const profile_id = await callerId(ctx.db);
      const { error } = await ctx.db
        .from("saved_transit_stops")
        .delete()
        .eq("profile_id", profile_id)
        .eq("stop_id", input.stopId);
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const };
    }),
});
