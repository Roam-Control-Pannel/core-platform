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
import { posts } from "@roam/core";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";

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

      const { data, error } = await ctx.db
        .from("posts")
        .insert({
          venue_id: input.venueId,
          kind: input.kind,
          title: input.title ?? null,
          body: input.body ?? null,
          destinations: input.destinations,
          is_draft: isDraft,
          publish_at: publishAt,
          published_at: publishedAt,
        })
        .select("id")
        .single();

      if (error) {
        return { created: false as const, validation, error: error.message };
      }

      return {
        created: true as const,
        validation,
        timing,
        requiresPushCredit,
        postId: data.id,
      };
    }),
});
