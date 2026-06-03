/**
 * Posts router — multi-destination composer.
 *
 * The COMPOSITION RULES are pure and already in @roam/core/posts (validateComposition,
 * resolvePublishTiming, requiresPushCredit). This router validates input with Zod,
 * runs the pure rules, and on a valid publish, persists. Optional fields are
 * `.optional()` to match core's `?: string | undefined` under exactOptionalPropertyTypes.
 *
 * Schema note (verified against generated types): the `posts` table has no single
 * `status` column. Timing maps to `is_draft` (boolean) plus the timestamps
 * `publish_at` (scheduled go-live) / `published_at` (actual go-live).
 */
import { z } from "zod";
import { posts } from "@roam/core";
import { router, protectedProcedure } from "../trpc.js";

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
