/**
 * Meetup router — THE CROWN JEWEL, now wrapping the real @roam/core/meetup.
 *
 * core/meetup splits cleanly: logic.ts is PURE (tallyVotes/resolvePoll/canTransition),
 * service.ts is the thin orchestrator (getPollResolution/tryResolveMeetup/endMeetup).
 * This router is thinner still — it validates input and calls the orchestrators under
 * the caller's RLS. No meet-up rule is reimplemented here; that's the whole point of
 * the one-core architecture.
 *
 * Read / lifecycle wrappers:
 * - resolution      : read-only live tally (getPollResolution). Protected — meet-ups
 *                     are private to their participants; RLS scopes visibility.
 * - tryResolve      : attempt voting→resolved if a clear winner exists (tryResolveMeetup).
 *                     Returns the resolution either way so the UI can show tie/no-votes.
 * - end             : end a meet-up (endMeetup); validates the transition in core.
 *
 * Write mutations (Stage 2a):
 * - createMeetup    : open a poll on a chat thread. One live (non-ended) meet-up per
 *                     thread; rejects if one already exists. started_by = caller.
 * - addOption       : add a candidate venue to a poll. Idempotent on (meetup_id, venue_id)
 *                     via the table's unique constraint. added_by = caller. Voting only.
 * - castVote        : cast/switch the caller's vote. PK is (meetup_id, voter_id), so a
 *                     re-vote is an upsert (switch = update). voter_id = caller. Voting only.
 *
 * Write-shape discipline (mirrors social.ts): voter_id / added_by / started_by are
 * resolved from the validated JWT (auth.getUser) and passed explicitly. RLS still
 * enforces voter_id = auth.uid(); passing it is belt-and-braces, not a bypass.
 * The state guard (voting-only) and the option↔meetup coherence check are router-side
 * validation, NOT business rules — the lifecycle rules themselves stay in core.
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

/**
 * Load a meet-up's current state, or throw NOT_FOUND if it doesn't exist / isn't
 * visible to the caller (RLS). Mirrors the .select("state").single() shape the core
 * orchestrators use, so the router guards on exactly what core reads.
 */
async function loadState(db: RoamClient, id: string): Promise<string> {
  const { data, error } = await db
    .from("meetups")
    .select("state")
    .eq("id", id)
    .single();
  if (error || !data) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Meet-up not found, or you do not have access to it.",
    });
  }
  return data.state;
}

/** Reject any write that isn't against an actively-voting meet-up. */
function assertVoting(state: string): void {
  if (state !== "voting") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `This meet-up is ${state}, so it is no longer open for changes.`,
    });
  }
}

export const meetupRouter = router({
  /**
   * Discover the live (non-ended) meet-up for a thread, or null. Read-only.
   * The router had no thread->meetup lookup (createMeetup's CONFLICT is a write-guard,
   * not a discovery path), so the thread UI couldn't find an existing meet-up's id to
   * drive `resolution`. This mirrors createMeetup's exact existence check and rides the
   * same participant-scoped RLS. No rule lives here — pure read.
   */
  forThread: protectedProcedure
    .input(z.object({ threadId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.db
        .from("meetups")
        .select("id, state")
        .eq("thread_id", input.threadId)
        .neq("state", "ended")
        .limit(1)
        .maybeSingle();
      if (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to load the meet-up: ${error.message}`,
        });
      }
      return data ?? null;
    }),

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
   * Open a poll on a chat thread. Enforces one live (non-ended) meet-up per thread:
   * if a voting/resolved meet-up already exists on the thread, rejects with CONFLICT.
   * state defaults to 'voting' at the DB; we don't set it from the client.
   */
  createMeetup: protectedProcedure
    .input(z.object({ threadId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const started_by = await callerId(ctx.db);

      // One live poll per thread. 'ended' meet-ups don't block a fresh one.
      const { data: existing, error: existingErr } = await ctx.db
        .from("meetups")
        .select("id, state")
        .eq("thread_id", input.threadId)
        .neq("state", "ended")
        .limit(1)
        .maybeSingle();
      if (existingErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to check existing meet-ups: ${existingErr.message}`,
        });
      }
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This thread already has an active meet-up.",
        });
      }

      const { data, error } = await ctx.db
        .from("meetups")
        .insert({ thread_id: input.threadId, started_by })
        .select("id, thread_id, state, started_at")
        .single();
      if (error || !data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to create meet-up: ${error?.message ?? "no row returned"}`,
        });
      }
      return data;
    }),

  /**
   * Add a candidate venue to a poll. Idempotent: the table's unique (meetup_id, venue_id)
   * means re-adding the same venue is a no-op rather than a duplicate. Voting state only.
   */
  addOption: protectedProcedure
    .input(z.object({ meetupId: z.string().uuid(), venueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const added_by = await callerId(ctx.db);
      assertVoting(await loadState(ctx.db, input.meetupId));

      const { data, error } = await ctx.db
        .from("meetup_options")
        .upsert(
          { meetup_id: input.meetupId, venue_id: input.venueId, added_by },
          { onConflict: "meetup_id,venue_id", ignoreDuplicates: false },
        )
        .select("id, meetup_id, venue_id, added_by")
        .single();
      if (error || !data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to add option: ${error?.message ?? "no row returned"}`,
        });
      }
      return data;
    }),

  /**
   * Cast or switch the caller's vote. PK (meetup_id, voter_id) ⇒ upsert: a second vote
   * from the same voter overwrites the first (switch). The option must belong to this
   * meet-up — a foreign option_id would write a row core's tally silently ignores, so we
   * reject it up front with NOT_FOUND. Voting state only.
   */
  castVote: protectedProcedure
    .input(z.object({ meetupId: z.string().uuid(), optionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const voter_id = await callerId(ctx.db);
      assertVoting(await loadState(ctx.db, input.meetupId));

      // Option must exist AND belong to this meet-up.
      const { data: option, error: optionErr } = await ctx.db
        .from("meetup_options")
        .select("id")
        .eq("id", input.optionId)
        .eq("meetup_id", input.meetupId)
        .maybeSingle();
      if (optionErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to verify option: ${optionErr.message}`,
        });
      }
      if (!option) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That option does not belong to this meet-up.",
        });
      }

      const { data, error } = await ctx.db
        .from("meetup_votes")
        .upsert(
          { meetup_id: input.meetupId, option_id: input.optionId, voter_id },
          { onConflict: "meetup_id,voter_id", ignoreDuplicates: false },
        )
        .select("meetup_id, option_id, voter_id, voted_at")
        .single();
      if (error || !data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to cast vote: ${error?.message ?? "no row returned"}`,
        });
      }
      return data;
    }),
});
