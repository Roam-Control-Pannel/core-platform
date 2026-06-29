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

const postKind = z.enum(["news", "offer", "event"]);
const postDestination = z.enum(["profile", "feed", "follower_push"]);

const composeInput = z.object({
  venueId: z.string().uuid(),
  kind: postKind,
  title: z.string().optional(),
  body: z.string().optional(),
  destinations: z.array(postDestination).min(1),
  isDraft: z.boolean(),
  publishAt: z.string().datetime().optional(),
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
      }),
    )
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from("posts")
        .select(
          "id, kind, title, body, published_at, venue_id, venues(name, locality)",
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
      return (data ?? []).map((p) => {
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
        };
      });
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
        .select("id, kind, title, body, published_at, venue_id, venues(name, locality)")
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
      return {
        id: data.id,
        kind: data.kind,
        title: data.title,
        body: data.body,
        publishedAt: data.published_at,
        venueId: data.venue_id,
        venueName: v?.name ?? null,
        venueLocality: v?.locality ?? null,
      };
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
        .select("id, kind, title, body, published_at, venue_id")
        .eq("venue_id", input.venueId)
        .not("published_at", "is", null)
        .order("published_at", { ascending: false })
        .limit(input.limit);
      if (error) throw new Error(`Failed to load venue posts: ${error.message}`);
      return (data ?? []).map((p) => ({
        id: p.id,
        kind: p.kind,
        title: p.title,
        body: p.body,
        publishedAt: p.published_at,
        venueId: p.venue_id,
      }));
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
        .select("id, kind, title, body, destinations, is_draft, publish_at, published_at, created_at")
        .eq("venue_id", input.venueId)
        .order("created_at", { ascending: false })
        .limit(input.limit);
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to load your posts: ${error.message}` });
      return (data ?? []).map((p) => ({
        id: p.id,
        kind: p.kind,
        title: p.title,
        body: p.body,
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
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: { title?: string | null; body?: string | null } = {};
      if ("title" in input) patch.title = input.title?.trim() ? input.title.trim() : null;
      if ("body" in input) patch.body = input.body?.trim() ? input.body.trim() : null;
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
