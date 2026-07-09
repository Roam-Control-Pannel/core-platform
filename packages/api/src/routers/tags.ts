/**
 * Tags router — the hashtag feed behind /tags/{tag}: everything on Roam carrying #tag,
 * across the three public text surfaces (Town Hall topics, business posts, profile wall
 * posts). Read-only, anonymous-safe: every table is world-readable under RLS.
 *
 * Matching is two-phase: a broad ILIKE '%#tag%' narrows candidates in the database, then
 * core hasHashtag() verifies the exact tag with word boundaries in JS ("#newcastle" must
 * not match "#newcastleupon"). At current volumes that is plenty; if tags become hot, the
 * seam to optimise is a denormalised hashtags table maintained on write.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { hashtags } from "@roam/core";
import { router, publicProcedure } from "../trpc.js";

type LooseDb = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const PER_SOURCE = 30;

function carries(tag: string, ...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => hashtags.hasHashtag(t, tag));
}

export const tagsRouter = router({
  /** Public: all content carrying #tag, newest first per source. */
  feed: publicProcedure
    .input(z.object({ tag: z.string().trim().min(2).max(50).regex(/^[\p{L}\p{N}_]+$/u) }))
    .query(async ({ ctx, input }) => {
      const tag = hashtags.normalizeTag(input.tag);
      const like = `%#${tag}%`;
      const db = ctx.db as unknown as LooseDb;

      const [topicsRes, postsRes, wallRes] = (await Promise.all([
        db
          .from("town_hall_topics")
          .select("id, locality, locality_label, slug, title, body, reply_count, upvote_count, created_at")
          .or(`title.ilike.${like},body.ilike.${like}`)
          .order("created_at", { ascending: false })
          .limit(PER_SOURCE),
        db
          .from("posts")
          .select("id, kind, title, body, published_at, venues(name, locality)")
          .not("published_at", "is", null)
          .or(`title.ilike.${like},body.ilike.${like}`)
          .order("published_at", { ascending: false })
          .limit(PER_SOURCE),
        db
          .from("profile_posts")
          .select("id, body, created_at, profiles!profile_posts_author_id_fkey(display_name, handle)")
          .ilike("body", like)
          .order("created_at", { ascending: false })
          .limit(PER_SOURCE),
      ])) as [
        { data: { id: string; locality: string; locality_label: string; slug: string | null; title: string; body: string | null; reply_count: number | null; upvote_count: number | null; created_at: string }[] | null; error: { message: string } | null },
        { data: { id: string; kind: string; title: string | null; body: string | null; published_at: string; venues: { name: string; locality: string | null } | { name: string; locality: string | null }[] | null }[] | null; error: { message: string } | null },
        { data: { id: string; body: string | null; created_at: string; profiles: { display_name: string | null; handle: string | null } | { display_name: string | null; handle: string | null }[] | null }[] | null; error: { message: string } | null },
      ];

      // Each source is independently fault-tolerant — a failure just means that section is
      // empty, except all three failing which is a real error worth surfacing.
      if (topicsRes.error && postsRes.error && wallRes.error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load #${tag}: ${topicsRes.error.message}` });
      }

      const topics = (topicsRes.data ?? [])
        .filter((t) => carries(tag, t.title, t.body))
        .map((t) => ({
          id: t.id,
          locality: t.locality,
          localityLabel: t.locality_label,
          slug: t.slug ?? null,
          title: t.title,
          body: t.body ?? null,
          replyCount: t.reply_count ?? 0,
          upvoteCount: t.upvote_count ?? 0,
          createdAt: t.created_at,
        }));

      const posts = (postsRes.data ?? [])
        .filter((p) => carries(tag, p.title, p.body))
        .map((p) => {
          const v = Array.isArray(p.venues) ? (p.venues[0] ?? null) : p.venues;
          return {
            id: p.id,
            kind: p.kind,
            title: p.title ?? null,
            body: p.body ?? null,
            publishedAt: p.published_at,
            venueName: v?.name ?? null,
            venueLocality: v?.locality ?? null,
          };
        });

      const wall = (wallRes.data ?? [])
        .filter((w) => carries(tag, w.body))
        .map((w) => {
          const a = Array.isArray(w.profiles) ? (w.profiles[0] ?? null) : w.profiles;
          return {
            id: w.id,
            body: w.body ?? null,
            createdAt: w.created_at,
            authorName: a?.display_name ?? null,
            authorHandle: a?.handle ?? null,
          };
        });

      return { tag, topics, posts, wall, total: topics.length + posts.length + wall.length };
    }),
});
