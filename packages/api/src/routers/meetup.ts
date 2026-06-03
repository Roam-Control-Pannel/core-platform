/**
 * Meetup router — THE CROWN JEWEL, now wrapping the real @roam/core/meetup.
 *
 * core/meetup splits cleanly: logic.ts is PURE (tallyVotes/resolvePoll/canTransition),
 * service.ts is the thin orchestrator (getPollResolution/tryResolveMeetup/endMeetup).
 * This router is thinner still — it validates input and calls the orchestrators under
 * the caller's RLS. No meet-up rule is reimplemented here; that's the whole point of
 * the one-core architecture.
 *
 * - resolution      : read-only live tally (getPollResolution). Protected — meet-ups
 *                     are private to their participants; RLS scopes visibility.
 * - tryResolve      : attempt voting→resolved if a clear winner exists (tryResolveMeetup).
 *                     Returns the resolution either way so the UI can show tie/no-votes.
 * - end             : end a meet-up (endMeetup); validates the transition in core.
 *
 * castVote / addOption / createMeetup are deliberately NOT here yet: those are writes to
 * meetup_votes / meetup_options / meetups whose insert shapes I'd want to verify column-
 * by-column first (same discipline that just saved the other routers). They're the next
 * additive slice once these three orchestrator wrappers land green.
 */
import { z } from "zod";
import { meetup } from "@roam/core";
import { router, protectedProcedure } from "../trpc.js";

const meetupId = z.object({ meetupId: z.string().uuid() });

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
});
