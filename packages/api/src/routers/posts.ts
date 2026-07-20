/**
 * Posts router — multi-destination composer + the public local feed read.
 *
 * The COMPOSITION RULES are pure and already in @roam/core/posts (validateComposition,
 * resolvePublishTiming, requiresPushCredit). This router validates input with Zod,
 * runs the pure rules, and on a valid publish, persists. Optional fields are
 * `.optional()` to match core's `?: string | undefined` under exactOptionalPropertyTypes.
 *
 * Schema note (verified against generated types): the `posts` table has no single
 * `status` column. Timing maps to `is_draft` (boolean) plus the timestamps
 * `publish_at` (scheduled go-live) / `published_at` (actual go-live).
 *
 * The `feed` query is the Explore Feed tab's data source. It reads PUBLIC posts only —
 * the `posts_read_public` RLS policy (0004) already restricts selects to
 * `published_at is not null and moderation in ('auto_approved','approved')`, and the
 * `'feed' = any(destinations)` filter matches the partial index `idx_posts_feed`
 * (0002). At launch there are no claimed venues and so no posts: the empty result is
 * the MEDIAN case worldwide, and the UI ships its first-run state with the feature
 * ("looks new, not dead"), per ARCHITECTURE.md.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { posts, credits, routes } from "@roam/core";
import { router, publicProcedure, protectedProcedure, escalateToService } from "../trpc.js";
import { dispatchFollowerPush } from "../push/dispatch.js";
import { normaliseCommentBody, COMMENT_BODY_MAX } from "../profile-wall.js";

const postKind = z.enum(["news", "offer", "event"]);

/* ── engagement (likes + comments) — loose-typed reads; the posts_likes/posts_comments tables and
 *    the new posts.like_count/comment_count columns aren't in the generated DB types yet (same idiom
 *    as townHall/search). Counts are trigger-maintained by migration 0105. ──────────────────────── */
type LooseDb = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> };
};

/** The signed-in caller's id, or null (anonymous). Never throws. */
async function maybeCallerId(db: LooseDb): Promise<string | null> {
  try {
    const { data } = await db.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

/** The subset of postIds the caller has liked. Anonymous → empty (RLS scopes likes to self). */
async function viewerLikes(db: LooseDb, postIds: string[]): Promise<Set<string>> {
  if (postIds.length === 0) return new Set();
  const me = await maybeCallerId(db);
  if (!me) return new Set();
  const { data } = (await db
    .from("posts_likes")
    .select("post_id")
    .eq("liker_id", me)
    .in("post_id", postIds)) as { data: { post_id: string }[] | null };
  return new Set((data ?? []).map((l) => l.post_id));
}

/** Trigger-maintained like/comment counts for a set of posts, keyed by post id. */
async function postCounts(db: LooseDb, postIds: string[]): Promise<Map<string, { likeCount: number; commentCount: number }>> {
  const m = new Map<string, { likeCount: number; commentCount: number }>();
  if (postIds.length === 0) return m;
  const { data } = (await db
    .from("posts")
    .select("id, like_count, comment_count")
    .in("id", postIds)) as { data: { id: string; like_count: number | null; comment_count: number | null }[] | null };
  for (const r of data ?? []) m.set(r.id, { likeCount: r.like_count ?? 0, commentCount: r.comment_count ?? 0 });
  return m;
}

/** Fold likeCount/commentCount/viewerLiked onto a page of posts (one batched query each). */
async function withEngagement<T extends { id: string }>(
  db: LooseDb,
  rows: T[],
): Promise<(T & { likeCount: number; commentCount: number; viewerLiked: boolean })[]> {
  const ids = rows.map((r) => r.id);
  const [counts, liked] = await Promise.all([postCounts(db, ids), viewerLikes(db, ids)]);
  return rows.map((r) => {
    const c = counts.get(r.id);
    return { ...r, likeCount: c?.likeCount ?? 0, commentCount: c?.commentCount ?? 0, viewerLiked: liked.has(r.id) };
  });
}

/** The signed-in caller's id, throwing when anonymous (for the protected engagement mutations). */
async function callerId(db: LooseDb): Promise<string> {
  const me = await maybeCallerId(db);
  if (!me) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to continue." });
  return me;
}

interface RawPostComment {
  id: string;
  body: string;
  created_at: string;
  author: unknown; // PostgREST embed — object or (for a non-unique FK) a one-element array
}
/** Normalise the embedded comment author to the { id, handle, displayName, avatarUrl } shape the UI wants. */
function shapeCommentAuthor(a: unknown) {
  const o = (Array.isArray(a) ? a[0] : a) as
    | { id?: string; handle?: string | null; display_name?: string | null; avatar_url?: string | null }
    | null;
  return {
    id: o?.id ?? "",
    handle: o?.handle ?? null,
    displayName: o?.display_name ?? null,
    avatarUrl: o?.avatar_url ?? null,
  };
}
const postDestination = z.enum(["profile", "feed", "follower_push"]);

/** Post images live in posts.media (jsonb). v1 is images-only: [{type:'image', url}]. */
const postMedia = z.array(z.object({ type: z.literal("image"), url: z.string().max(4096) })).max(4);
type PostMedia = { type: "image"; url: string };

/** Normalise the posts.media jsonb into a typed image list, dropping anything malformed. */
function asMedia(v: unknown): PostMedia[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((m) => {
    const o = m as { url?: unknown };
    return typeof o?.url === "string" && o.url.length > 0 ? [{ type: "image" as const, url: o.url }] : [];
  });
}

const composeInput = z.object({
  venueId: z.string().uuid(),
  kind: postKind,
  title: z.string().optional(),
  body: z.string().optional(),
  destinations: z.array(postDestination).min(1),
  isDraft: z.boolean(),
  publishAt: z.string().datetime().optional(),
  media: postMedia.optional(),
});

/** Map validated Zod input to core's ComposeInput (drops venueId — that's persistence). */
function toComposeInput(
  input: z.infer<typeof composeInput>,
): posts.ComposeInput {
  return {
    kind: input.kind,
    title: input.title,
    body: input.body,
    destinations: input.destinations,
    isDraft: input.isDraft,
    publishAt: input.publishAt,
  };
}

export const postsRouter = router({
  /**
   * Public: the local feed. Published, moderation-approved posts that target the
   * `feed` destination, newest first, with their venue's name + locality for the card.
   *
   * RLS does the security (posts_read_public); this adds the feed-destination filter
   * and the venue join. The embedded `venues` select uses PostgREST's FK-embed; the
   * `posts_venue_id_fkey` relationship makes `venues(...)` resolve to the parent venue.
   */
  feed: publicProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(50).default(25),
        // When a place centre is supplied, the feed is GEOFENCED to that town — only posts
        // from businesses within radiusM of the origin (the product rule: a business posts
        // into its own town's feed). Omitting lat/lng falls back to the global feed.
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
        radiusM: z.number().int().min(500).max(100_000).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      type FeedRow = {
        id: string;
        kind: string;
        title: string | null;
        body: string | null;
        publishedAt: string | null;
        venueId: string;
        venueName: string | null;
        venueLocality: string | null;
        media: PostMedia[];
      };

      // Geofenced path: delegate to the posts_feed_near RPC (PostGIS distance filter).
      if (input.lat != null && input.lng != null) {
        const rpc = ctx.db.rpc.bind(ctx.db) as unknown as (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { message: string } | null }>;
        const { data, error } = await rpc("posts_feed_near", {
          lat: input.lat,
          lng: input.lng,
          radius_m: input.radiusM ?? 25_000,
          max_results: input.limit,
        });
        if (error) throw new Error(`Failed to load feed: ${error.message}`);
        const rows = (data as Array<{
          id: string;
          kind: string;
          title: string | null;
          body: string | null;
          published_at: string | null;
          venue_id: string;
          venue_name: string | null;
          venue_locality: string | null;
          media?: unknown;
        }> | null) ?? [];
        const base = rows.map(
          (r): FeedRow => ({
            id: r.id,
            kind: r.kind,
            title: r.title,
            body: r.body,
            publishedAt: r.published_at,
            venueId: r.venue_id,
            venueName: r.venue_name,
            venueLocality: r.venue_locality,
            media: asMedia(r.media),
          }),
        );
        return withEngagement(ctx.db as unknown as LooseDb, base);
      }

      // Global path (no origin): the original whole-network feed.
      const { data, error } = await ctx.db
        .from("posts")
        .select(
          "id, kind, title, body, media, published_at, venue_id, venues(name, locality)",
        )
        .contains("destinations", ["feed"])
        .not("published_at", "is", null)
        .order("published_at", { ascending: false })
        .limit(input.limit);
      if (error) throw new Error(`Failed to load feed: ${error.message}`);

      // PostgREST returns the embedded venue for a to-one FK. The generated client may
      // type the embed as an object OR (for a non-unique FK) an array, so we read it
      // through `unknown` and normalise both shapes — the same widening idiom used for
      // the byId result in VenueDetail. Never fabricate a venue name if the embed is
      // absent.
      type EmbeddedVenue = { name: string; locality: string | null };
      const base = (data ?? []).map(
        (p): FeedRow => {
          const raw = (p as { venues?: unknown }).venues;
          const v: EmbeddedVenue | null = Array.isArray(raw)
            ? ((raw[0] as EmbeddedVenue | undefined) ?? null)
            : ((raw as EmbeddedVenue | null) ?? null);
          return {
            id: p.id,
            kind: p.kind,
            title: p.title,
            body: p.body,
            publishedAt: p.published_at,
            venueId: p.venue_id,
            venueName: v?.name ?? null,
            venueLocality: v?.locality ?? null,
            media: asMedia((p as { media?: unknown }).media),
          };
        },
      );
      return withEngagement(ctx.db as unknown as LooseDb, base);
    }),

  /**
   * Public: one published post by id — the post-detail surface (mobile screen + the web feed's
   * detail pane). Same RLS as the feed (posts_read_public restricts to published + approved), so
   * an unpublished/hidden post resolves to null rather than leaking. Inline-typed (no leak).
   */
  byId: publicProcedure
    .input(z.object({ postId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from("posts")
        .select("id, kind, title, body, media, published_at, venue_id, venues(name, locality)")
        .eq("id", input.postId)
        .not("published_at", "is", null)
        .maybeSingle();
      if (error) throw new Error(`Failed to load post: ${error.message}`);
      if (!data) return null;

      type EmbeddedVenue = { name: string; locality: string | null };
      const raw = (data as { venues?: unknown }).venues;
      const v: EmbeddedVenue | null = Array.isArray(raw)
        ? ((raw[0] as EmbeddedVenue | undefined) ?? null)
        : ((raw as EmbeddedVenue | null) ?? null);
      const base = {
        id: data.id,
        kind: data.kind,
        title: data.title,
        body: data.body,
        media: asMedia((data as { media?: unknown }).media),
        publishedAt: data.published_at,
        venueId: data.venue_id,
        venueName: v?.name ?? null,
        venueLocality: v?.locality ?? null,
      };
      const [hydrated] = await withEngagement(ctx.db as unknown as LooseDb, [base]);
      return hydrated ?? { ...base, likeCount: 0, commentCount: 0, viewerLiked: false };
    }),

  /**
   * Public: a town's local news — published, feed-destination posts whose venue is in the given
   * locality (matched on venues.locality, case-insensitively). Powers the Town Hall town hub.
   * Loose-typed read so the embedded-resource filter (venues.locality) isn't type-checked against
   * the posts columns; runtime is a normal PostgREST inner-join filter.
   */
  byLocality: publicProcedure
    .input(z.object({ locality: z.string().trim().min(1).max(120), limit: z.number().int().min(1).max(24).default(8) }))
    .query(async ({ ctx, input }) => {
      type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const db = ctx.db as unknown as Loose;
      const { data, error } = (await db
        .from("posts")
        .select("id, kind, title, body, media, published_at, venue_id, venues!inner(name, locality)")
        .contains("destinations", ["feed"])
        .not("published_at", "is", null)
        .ilike("venues.locality", input.locality)
        .order("published_at", { ascending: false })
        .limit(input.limit)) as { data: unknown[] | null; error: { message: string } | null };
      if (error) throw new Error(`Failed to load local news: ${error.message}`);
      type EmbeddedVenue = { name: string; locality: string | null };
      return (data ?? []).map((row) => {
        const p = row as {
          id: string; kind: string; title: string | null; body: string | null;
          published_at: string | null; venue_id: string; media?: unknown; venues?: unknown;
        };
        const raw = p.venues;
        const v: EmbeddedVenue | null = Array.isArray(raw) ? ((raw[0] as EmbeddedVenue | undefined) ?? null) : ((raw as EmbeddedVenue | null) ?? null);
        return {
          id: p.id,
          kind: p.kind,
          title: p.title,
          body: p.body,
          media: asMedia(p.media),
          publishedAt: p.published_at,
          venueId: p.venue_id,
          venueName: v?.name ?? null,
          venueLocality: v?.locality ?? null,
        };
      });
    }),

  /**
   * Public: a single venue's published posts (its "Posts" tab), newest first. Same RLS as the
   * feed (published + approved only); unlike the feed this is NOT limited to the feed
   * destination — it's the venue's own wall of updates. Inline-typed.
   */
  byVenue: publicProcedure
    .input(z.object({ venueId: z.string().uuid(), limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from("posts")
        .select("id, kind, title, body, media, published_at, venue_id")
        .eq("venue_id", input.venueId)
        .not("published_at", "is", null)
        .order("published_at", { ascending: false })
        .limit(input.limit);
      if (error) throw new Error(`Failed to load venue posts: ${error.message}`);
      const base = (data ?? []).map((p) => ({
        id: p.id,
        kind: p.kind,
        title: p.title,
        body: p.body,
        media: asMedia((p as { media?: unknown }).media),
        publishedAt: p.published_at,
        venueId: p.venue_id,
      }));
      return withEngagement(ctx.db as unknown as LooseDb, base);
    }),

  /**
   * Owner: every post for a venue you own — including drafts and scheduled, newest first —
   * for the console's manage view. RLS posts_owner_all (for ALL commands) scopes selects to
   * the caller's own venues, so a venue you don't own returns nothing. Inline-typed.
   */
  mine: protectedProcedure
    .input(z.object({ venueId: z.string().uuid(), limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from("posts")
        .select("id, kind, title, body, media, destinations, is_draft, publish_at, published_at, created_at")
        .eq("venue_id", input.venueId)
        .order("created_at", { ascending: false })
        .limit(input.limit);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your posts: ${error.message}` });
      return (data ?? []).map((p) => ({
        id: p.id,
        kind: p.kind,
        title: p.title,
        body: p.body,
        media: asMedia((p as { media?: unknown }).media),
        destinations: (p.destinations ?? []) as string[],
        isDraft: p.is_draft,
        publishAt: p.publish_at,
        publishedAt: p.published_at,
        createdAt: p.created_at,
      }));
    }),

  /**
   * Owner: edit a post's title / body (RLS posts_owner_all gates to the caller's venues).
   * Scope is deliberately the text only — kind, destinations and publish timing are fixed once
   * composed (a follower_push may already have fanned out, so re-targeting after the fact would
   * be misleading). Selects the row back so an edit that matched nothing fails loudly.
   */
  update: protectedProcedure
    .input(
      z.object({
        postId: z.string().uuid(),
        title: z.string().max(200).nullish(),
        body: z.string().max(5000).nullish(),
        media: postMedia.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: { title?: string | null; body?: string | null; media?: PostMedia[] } = {};
      if ("title" in input) patch.title = input.title?.trim() ? input.title.trim() : null;
      if ("body" in input) patch.body = input.body?.trim() ? input.body.trim() : null;
      if ("media" in input) patch.media = input.media ?? [];
      if (Object.keys(patch).length === 0) return { ok: true as const };
      const { data, error } = await ctx.db
        .from("posts")
        .update(patch)
        .eq("id", input.postId)
        .select("id")
        .maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't update that post: ${error.message}` });
      if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "Post not found, or it isn't yours to edit." });
      return { ok: true as const };
    }),

  /** Owner: delete a post (RLS posts_owner_all). Removes it from the feed, the venue wall and detail. */
  remove: protectedProcedure
    .input(z.object({ postId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.db.from("posts").delete().eq("id", input.postId);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't delete that post: ${error.message}` });
      return { ok: true as const };
    }),

  /* ── Likes + comments (mirrors profileWall; migration 0105) ──────────────────────────────── */

  /** Protected: toggle the caller's like on a post. Returns the fresh state + count. */
  toggleLike: protectedProcedure
    .input(z.object({ postId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const liker_id = await callerId(db);

      const { data: existing } = (await db
        .from("posts_likes")
        .select("post_id")
        .eq("post_id", input.postId)
        .eq("liker_id", liker_id)
        .maybeSingle()) as { data: { post_id: string } | null };

      if (existing) {
        const { error } = (await db.from("posts_likes").delete().eq("post_id", input.postId).eq("liker_id", liker_id)) as { error: { message: string } | null };
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't remove your like." });
      } else {
        const { error } = (await db.from("posts_likes").insert({ post_id: input.postId, liker_id })) as { error: { message: string } | null };
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't add your like." });
      }

      const { data: fresh } = (await db
        .from("posts")
        .select("like_count")
        .eq("id", input.postId)
        .maybeSingle()) as { data: { like_count: number } | null };
      return { liked: !existing, likeCount: fresh?.like_count ?? 0 };
    }),

  /** Public: a post's comments, oldest first. */
  listComments: publicProcedure
    .input(z.object({ postId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const { data, error } = (await db
        .from("posts_comments")
        .select("id, body, created_at, author:profiles!posts_comments_author_id_fkey(id, handle, display_name, avatar_url)")
        .eq("post_id", input.postId)
        .order("created_at", { ascending: true })) as { data: RawPostComment[] | null; error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Couldn't load comments: ${error.message}` });
      return {
        comments: (data ?? []).map((c) => ({
          id: c.id,
          body: c.body,
          createdAt: c.created_at,
          author: shapeCommentAuthor(c.author),
        })),
      };
    }),

  /** Protected: comment on a post (the trigger bumps comment_count + notifies the venue owner). */
  addComment: protectedProcedure
    .input(z.object({ postId: z.string().uuid(), body: z.string().min(1).max(COMMENT_BODY_MAX + 500) }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      const author_id = await callerId(db);
      let body: string;
      try {
        body = normaliseCommentBody(input.body);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Invalid comment." });
      }
      const { data, error } = (await db
        .from("posts_comments")
        .insert({ post_id: input.postId, author_id, body })
        .select("id")
        .single()) as { data: { id: string } | null; error: { message: string } | null };
      if (error || !data) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't post your comment." });
      return { id: data.id };
    }),

  /** Protected: edit your own comment's body (RLS author_id = auth.uid()). */
  updateComment: protectedProcedure
    .input(z.object({ commentId: z.string().uuid(), body: z.string().min(1).max(COMMENT_BODY_MAX + 500) }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      let body: string;
      try {
        body = normaliseCommentBody(input.body);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Invalid comment." });
      }
      const { data, error } = (await db
        .from("posts_comments")
        .update({ body })
        .eq("id", input.commentId)
        .select("id")
        .maybeSingle()) as { data: { id: string } | null; error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't update that comment." });
      if (!data) throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found, or it isn't yours to edit." });
      return { ok: true as const };
    }),

  /** Protected: delete your own comment. */
  removeComment: protectedProcedure
    .input(z.object({ commentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseDb;
      await callerId(db);
      const { error } = (await db.from("posts_comments").delete().eq("id", input.commentId)) as { error: { message: string } | null };
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Couldn't delete that comment." });
      return { ok: true as const };
    }),

  /** Pure preview: validate a composition + report timing and push cost. No write. */
  validate: protectedProcedure
    .input(composeInput)
    .query(({ input }) => {
      const compose = toComposeInput(input);
      return {
        validation: posts.validateComposition(compose),
        timing: posts.resolvePublishTiming(compose),
        requiresPushCredit: posts.requiresPushCredit(compose),
      };
    }),

  /**
   * Create a post. Re-runs validation server-side, then writes under the caller's RLS.
   * Timing → real columns:
   *   draft     -> is_draft:true,  publish_at:null,     published_at:null
   *   scheduled -> is_draft:false, publish_at:<future>, published_at:null
   *   published -> is_draft:false, publish_at:null,     published_at:<now>
   */
  create: protectedProcedure
    .input(composeInput)
    .mutation(async ({ ctx, input }) => {
      const compose = toComposeInput(input);

      const validation = posts.validateComposition(compose);
      if (!validation.ok) {
        return { created: false as const, validation };
      }

      const timing = posts.resolvePublishTiming(compose);
      const requiresPushCredit = posts.requiresPushCredit(compose);

      const isDraft = timing.status === "draft";
      const publishAt = timing.status === "scheduled" ? timing.at : null;
      const publishedAt = timing.status === "published" ? timing.at : null;

      // Credit precondition (the slice's "block entirely" decision): a follower_push
      // publish costs one credit. Read the venue's balance under the caller's RLS
      // (the author owns the venue, so push_ledger_owner lets them read it) and, if
      // they cannot afford it, write NOTHING — the post is not created. The composer
      // validates affordability before submit; this is the hard server-side enforce.
      const PUSH_COST = 1;
      if (requiresPushCredit) {
        const balance = await credits.getBalance(ctx.db, input.venueId);
        if (balance < PUSH_COST) {
          return {
            created: false as const,
            validation,
            reason: "insufficient_credits" as const,
            balance,
          };
        }
      }

      const { data: userData, error: userErr } = await ctx.db.auth.getUser();
      if (userErr || !userData.user) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Could not resolve the signed-in user.",
        });
      }

      const { data, error } = await ctx.db
        .from("posts")
        .insert({
          venue_id: input.venueId,
          author_id: userData.user.id,
          kind: input.kind,
          title: input.title ?? null,
          body: input.body ?? null,
          media: input.media ?? [],
          destinations: input.destinations,
          is_draft: isDraft,
          publish_at: publishAt,
          published_at: publishedAt,
          // Optimistic-publish + async-moderation, mirroring chat.sendMessage:
          // the posts.moderation column defaults to 'pending', but no scanner runs
          // to clear it, so a 'pending' post would be invisible to posts.feed
          // (posts_read_public exposes only auto_approved/approved) forever. We
          // auto-approve on publish so the post surfaces immediately; the async
          // moderation scanner (when it lands) runs post-insert and can demote a
          // row into moderation_queue, keeping the hard gate without a write-only feed.
          moderation: "auto_approved",
        })
        .select("id")
        .single();

      if (error) {
        return { created: false as const, validation, error: error.message };
      }

      // Post is persisted. If it targets follower_push, consume one credit then fan
      // out — both need the service client (the ledger consume bypasses RLS, and the
      // dispatch reads OTHER followers' subscriptions). escalateToService is the one
      // sanctioned construction site, shared with the internal-call gate. The consume
      // re-checks affordability atomically against the live ledger; if a concurrent
      // send drained the balance between the gate read and here, we DON'T push (safe
      // direction: "published but not pushed", never "pushed without paying").
      let dispatch:
        | { sent: number; failed: number; pruned: number; skipped: number; candidates: number }
        | null = null;
      if (requiresPushCredit) {
        const service = escalateToService(ctx.env);
        const consumed = await credits.consumeForSend(
          service,
          input.venueId,
          PUSH_COST,
          data.id,
        );
        if (consumed.ok) {
          dispatch = await dispatchFollowerPush(service, ctx.env.vapid, {
            venueId: input.venueId,
            url: routes.venuePath(input.venueId),
            title: input.title ?? "New update",
            body: input.body ?? "",
          });
        }
      }

      return {
        created: true as const,
        validation,
        timing,
        requiresPushCredit,
        postId: data.id,
        dispatch,
      };
    }),
});
