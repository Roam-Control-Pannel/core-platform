/**
 * Meetup router — THE CROWN JEWEL, wrapping @roam/core/meetup.
 *
 * core/meetup splits cleanly: logic.ts is PURE (tallyVotes/resolvePoll/canTransition),
 * service.ts is the thin orchestrator. This router validates input and delegates.
 *
 * Reads/resolution/lifecycle (delegate to existing core orchestrators):
 *   resolution  — live read-only tally (getPollResolution)
 *   tryResolve  — voting→resolved iff a clear winner exists (tryResolveMeetup)
 *   end         — lifecycle-validated end (endMeetup)
 *
 * Writes:
 *   castVote    — delegates to core.castVote, which OWNS the rule (one vote per voter,
 *                 re-votes overwrite, only while voting). voter_id resolved from the JWT.
 *   addOption   — thin insert (ruleless): add a candidate venue to the poll.
 *   create      — thin insert (ruleless): start a meet-up on a thread.
 *
 * addOption/create carry no domain rule, so they live here per the architecture law
 * (rules in core, transport in api). castVote has a rule, so it lives in core.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { RoamClient } from "@roam/db";
import { meetup } from "@roam/core";
import { router, protectedProcedure } from "../trpc.js";

const meetupId = z.object({ meetupId: z.string().uuid() });

/** Resolve the caller's auth user id from the validated session JWT. */
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

export const meetupRouter = router({
  /** Live poll resolution (read-only): current tally + winner/tie/no-votes. */
  resolution: protectedProcedure
    .input(meetupId)
    .query(async ({ ctx, input }) => {
      return meetup.getPollResolution(ctx.db, input.meetupId);
    }),

  /** Attempt to resolve: transitions voting→resolved iff a clear winner exists. */
  tryResolve: protectedProcedure
    .input(meetupId)
    .mutation(async ({ ctx, input }) => {
      return meetup.tryResolveMeetup(ctx.db, input.meetupId);
    }),

  /** End a meet-up. core validates the lifecycle transition from its current state. */
  end: protectedProcedure
    .input(meetupId)
    .mutation(async ({ ctx, input }) => {
      await meetup.endMeetup(ctx.db, input.meetupId);
      return { ended: true as const, meetupId: input.meetupId };
    }),

  /**
   * Cast or change a vote. core.castVote owns the one-vote-per-voter / overwrite /
   * only-while-voting rule. voter_id comes from the JWT, never the client.
   */
  castVote: protectedProcedure
    .input(z.object({ meetupId: z.string().uuid(), optionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const voterId = await callerId(ctx.db);
      return meetup.castVote(ctx.db, input.meetupId, input.optionId, voterId);
    }),

  /** Add a candidate venue option to a meet-up's poll. Thin insert; added_by = caller. */
  addOption: protectedProcedure
    .input(z.object({ meetupId: z.string().uuid(), venueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const added_by = await callerId(ctx.db);
      const { data, error } = await ctx.db
        .from("meetup_options")
        .insert({
          meetup_id: input.meetupId,
          venue_id: input.venueId,
          added_by,
        })
        .select("id")
        .single();
      if (error) return { added: false as const, error: error.message };
      return { added: true as const, optionId: data.id };
    }),

  /**
   * Start a meet-up on a chat thread. Thin insert; started_by = caller, state defaults
   * server-side to 'voting'. A meet-up belongs to a thread (the Create-Plan-Chat flow).
   */
  create: protectedProcedure
    .input(z.object({ threadId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const started_by = await callerId(ctx.db);
      const { data, error } = await ctx.db
        .from("meetups")
        .insert({
          thread_id: input.threadId,
          started_by,
        })
        .select("id")
        .single();
      if (error) return { created: false as const, error: error.message };
      return { created: true as const, meetupId: data.id };
    }),
});
