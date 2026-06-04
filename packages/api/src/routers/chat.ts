/**
 * Chat router — Stage 2b thread/plan plumbing.
 *
 * Makes the meet-up flow reachable from real app actions. Before this, threads +
 * participants existed only via manual SQL seed (exactly what Stage 2a's proof had
 * to do). This router is the bridge: create a thread, add participants, spawn a
 * thread from a plan — after which meetup.createMeetup({ threadId }) can run.
 *
 * Procedures:
 * - createThread          : create a thread AND atomically add the caller as its first
 *                           participant, via the create_thread_with_creator RPC
 *                           (migration 0011, SECURITY DEFINER). Optional plan_id links
 *                           the thread to a plan (chat_threads.plan_id); optional title;
 *                           is_group defaults false. The "creator is a participant"
 *                           invariant lives in the DB function, not here — there is no
 *                           other INSERT path to chat_threads.
 * - addThreadParticipant  : add ANOTHER profile to an EXISTING thread. RLS policy
 *                           chat_participants_write (WITH CHECK in_thread(thread_id))
 *                           enforces that the CALLER is already in the thread; this
 *                           router additionally guards that the thread is a group
 *                           (a 1:1 → group promotion is a deliberate product decision,
 *                           not an accident). Idempotent on PK (thread_id, profile_id).
 *
 * Architecture notes:
 * - createThread calls an RPC that isn't in the generated DB types until `pnpm db:types`
 *   is re-pointed at prod and re-run, so we widen JUST that call through a minimal rpc
 *   surface — the same idiom venues.ts uses for venues_near / request_venue_claim. The
 *   rest of ctx.db stays fully typed. (Tech-debt cleanup tracked separately: repoint
 *   db:types at prod, then revert all rpc-widening to plain typed calls.)
 * - The is_group group-only guard is router-side VALIDATION, not a business rule — it
 *   mirrors meetup.ts's assertVoting: changeable product rules live in the router; the
 *   creator-participant invariant lives in the DB.
 * - SQLSTATE → tRPC error mapping mirrors venues.ts: the function raises 28000 if no
 *   authenticated user (defensive — protectedProcedure already guarantees a JWT).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { RoamClient } from "@roam/db";
import { router, protectedProcedure } from "../trpc.js";

/**
 * Shape returned by the `create_thread_with_creator` RPC (migration 0011) — a single
 * chat_threads row. The function isn't in the generated DB types until db:types is
 * re-run against prod, so we type it explicitly and widen the .rpc() call. Keep in
 * sync with the chat_threads table definition.
 */
interface ChatThreadRow {
  id: string;
  is_group: boolean;
  plan_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Postgres error codes create_thread_with_creator raises (via `using errcode`),
 * mapped to friendly, typed outcomes — same pattern as venues.ts's claim mapping.
 */
const THREAD_ERROR_BY_SQLSTATE: Record<string, { code: TRPCError["code"]; message: string }> = {
  "28000": { code: "UNAUTHORIZED", message: "You need to be signed in to start a chat." },
};

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

export const chatRouter = router({
  /**
   * Create a thread and atomically add the caller as its first participant.
   * Delegates entirely to the create_thread_with_creator RPC — the two inserts
   * happen in one transaction under SECURITY DEFINER, so a thread can never exist
   * without its creator-participant. Returns the new thread row.
   */
  createThread: protectedProcedure
    .input(
      z.object({
        isGroup: z.boolean().default(false),
        planId: z.string().uuid().optional(),
        title: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // create_thread_with_creator isn't in the generated DB types until db:types is
      // re-run against prod; widen JUST this call (same idiom as venues.ts).
      const rpc = ctx.db.rpc.bind(ctx.db) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{
        data: unknown;
        error: { message: string; code?: string } | null;
      }>;

      const { data, error } = await rpc("create_thread_with_creator", {
        p_is_group: input.isGroup,
        p_plan_id: input.planId ?? null,
        p_title: input.title ?? null,
      });

      if (error) {
        const mapped = error.code ? THREAD_ERROR_BY_SQLSTATE[error.code] : undefined;
        if (mapped) {
          throw new TRPCError({ code: mapped.code, message: mapped.message });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Couldn't create the chat. Please try again.",
        });
      }

      const thread = data as ChatThreadRow;
      return {
        id: thread.id,
        isGroup: thread.is_group,
        planId: thread.plan_id,
        title: thread.title,
        createdAt: thread.created_at,
      };
    }),

  /**
   * Add another profile to an existing GROUP thread. RLS (chat_participants_write)
   * enforces that the caller is already in the thread; this guard rejects adding to
   * a 1:1 thread (promote to group first — a separate, deliberate action). Idempotent
   * via upsert on the PK (thread_id, profile_id): re-adding the same profile is a no-op.
   */
  addThreadParticipant: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        profileId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Caller must be resolvable (defensive; protectedProcedure guarantees a JWT).
      await callerId(ctx.db);

      // Load the thread the caller can see (RLS scopes this to threads they're in).
      // NOT_FOUND covers both "no such thread" and "not visible to you" — we never
      // confirm existence of a thread the caller isn't a participant of.
      const { data: thread, error: threadErr } = await ctx.db
        .from("chat_threads")
        .select("id, is_group")
        .eq("id", input.threadId)
        .maybeSingle();
      if (threadErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to load thread: ${threadErr.message}`,
        });
      }
      if (!thread) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Thread not found, or you do not have access to it.",
        });
      }

      // Group-only guard: a 1:1 thread gaining a third person is really a new group.
      if (!thread.is_group) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This is a direct chat. Start a group chat to add more people.",
        });
      }

      // Idempotent add. RLS WITH CHECK in_thread(thread_id) enforces the caller is a
      // participant; we pass profile_id explicitly (belt-and-braces, not a bypass).
      const { data, error } = await ctx.db
        .from("chat_participants")
        .upsert(
          { thread_id: input.threadId, profile_id: input.profileId },
          { onConflict: "thread_id,profile_id", ignoreDuplicates: false },
        )
        .select("thread_id, profile_id, created_at")
        .single();
      if (error || !data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to add participant: ${error?.message ?? "no row returned"}`,
        });
      }
      return {
        threadId: data.thread_id,
        profileId: data.profile_id,
        addedAt: data.created_at,
      };
    }),
});
