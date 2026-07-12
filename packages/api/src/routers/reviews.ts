/**
 * Reviews router — Roam's own first-party venue reviews (migration 0085).
 *
 * A review is one person's 1–5 rating + optional text for a venue; a user has at most ONE review
 * per venue (editable via `save`, which upserts on (venue_id, author_id)). Reads are public
 * (browsing needs no account, same posture as venues.near); writes are protected and act as the
 * caller under RLS (author_id = auth.uid()). The venue's Roam rollup (roam_rating/roam_rating_count)
 * is maintained by a DB trigger, so `summary` just reads the venue row.
 *
 * venue_reviews isn't in the generated DB types, so the client is loose-typed (same idiom as
 * townHall/plans); resolvers return inline types.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

type PgResult<T> = { data: T; error: { message: string; code?: string } | null };
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

export const reviewsRouter = router({
  /**
   * Public: the rating headline for a venue — the Roam rollup (our own reviews) alongside the
   * Google figures, so the client can prefer Roam once it has enough reviews and fall back to
   * Google otherwise. One cheap read of the venue row (the rollup is denormalised by trigger).
   */
  summary: publicProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("venues")
        .select("roam_rating, roam_rating_count, rating, rating_count")
        .eq("id", input.venueId)
        .maybeSingle()) as PgResult<{
        roam_rating: number | null;
        roam_rating_count: number | null;
        rating: number | null;
        rating_count: number | null;
      } | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load the rating summary: ${error.message}` });
      }
      return {
        roamRating: data?.roam_rating ?? null,
        roamCount: data?.roam_rating_count ?? 0,
        googleRating: data?.rating ?? null,
        googleCount: data?.rating_count ?? 0,
      };
    }),

  /** Public: a venue's Roam reviews with their author, newest first (paged). */
  list: publicProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rpc = ctx.db.rpc.bind(ctx.db) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
      const { data, error } = await rpc("venue_reviews_list", {
        venue_id_param: input.venueId,
        max_results: input.limit,
        page_offset: input.offset,
      });
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load reviews: ${error.message}` });
      }
      const rows = (data ?? []) as {
        id: string;
        rating: number;
        body: string | null;
        created_at: string;
        updated_at: string;
        author_id: string;
        author_name: string | null;
        author_handle: string | null;
        author_avatar: string | null;
      }[];
      return {
        reviews: rows.map((r) => ({
          id: r.id,
          rating: r.rating,
          body: r.body,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          authorId: r.author_id,
          authorName: r.author_name,
          authorHandle: r.author_handle,
          authorAvatar: r.author_avatar,
        })),
      };
    }),

  /** Protected: the caller's own review for a venue (to prefill the editor), or null. */
  mine: protectedProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const me = await callerId(db);
      const { data, error } = (await db
        .from("venue_reviews")
        .select("id, rating, body, created_at, updated_at")
        .eq("venue_id", input.venueId)
        .eq("author_id", me)
        .maybeSingle()) as PgResult<{ id: string; rating: number; body: string | null; created_at: string; updated_at: string } | null>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load your review: ${error.message}` });
      }
      if (!data) return { review: null };
      return { review: { id: data.id, rating: data.rating, body: data.body, createdAt: data.created_at, updatedAt: data.updated_at } };
    }),

  /**
   * Protected: create or update the caller's review for a venue (one per author — upsert on the
   * (venue_id, author_id) unique key). ON CONFLICT DO UPDATE is fine here: both the insert and
   * update RLS policies are author-scoped, and the caller is the author.
   */
  save: protectedProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        rating: z.number().int().min(1).max(5),
        body: z.string().trim().max(4000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const author_id = await callerId(db);
      const body = input.body && input.body.length > 0 ? input.body : null;
      const { data, error } = (await db
        .from("venue_reviews")
        .upsert(
          { venue_id: input.venueId, author_id, rating: input.rating, body },
          { onConflict: "venue_id,author_id" },
        )
        .select("id, rating, body, created_at, updated_at")
        .single()) as PgResult<{ id: string; rating: number; body: string | null; created_at: string; updated_at: string }>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't save your review: ${error.message}` });
      }
      return { review: { id: data.id, rating: data.rating, body: data.body, createdAt: data.created_at, updatedAt: data.updated_at } };
    }),

  /** Protected: remove the caller's review for a venue. */
  remove: protectedProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const me = await callerId(db);
      const { error } = (await db
        .from("venue_reviews")
        .delete()
        .eq("venue_id", input.venueId)
        .eq("author_id", me)) as PgResult<unknown>;
      if (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't remove your review: ${error.message}` });
      }
      return { ok: true as const };
    }),
});
