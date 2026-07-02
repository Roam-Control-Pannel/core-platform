/**
 * poll router — voting on a chat poll (a message of kind='poll').
 *
 * All three procedures delegate to the SECURITY DEFINER functions from migration 0060, which own
 * the access rules (participant to vote/read, creator to close) and the single-vs-multi logic — so
 * this router is a thin, typed boundary that maps their SQLSTATEs to tRPC errors. The poll's
 * question/options live in the message payload (already on the client); these read/write only the
 * mutable state (votes + closed).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";

type LooseRpc = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};

/** Map the RPCs' `using errcode` SQLSTATEs to typed tRPC errors. */
function mapErr(error: { message: string; code?: string }): TRPCError {
  if (error.code === "42501") return new TRPCError({ code: "FORBIDDEN", message: error.message });
  if (error.code === "42704") return new TRPCError({ code: "NOT_FOUND", message: error.message });
  if (error.code === "22023") return new TRPCError({ code: "BAD_REQUEST", message: error.message });
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Poll action failed: ${error.message}` });
}

export const pollRouter = router({
  /** Cast/switch/toggle the caller's vote on an option (single vs multi enforced server-side). */
  vote: protectedProcedure
    .input(z.object({ messageId: z.string().uuid(), optionId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseRpc;
      const { error } = await db.rpc("cast_poll_vote", { p_message: input.messageId, p_option: input.optionId });
      if (error) throw mapErr(error);
      return { ok: true as const };
    }),

  /** Read a poll's votes (who voted for what) + closed state. */
  results: protectedProcedure
    .input(z.object({ messageId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseRpc;
      const { data, error } = await db.rpc("poll_results", { p_message: input.messageId });
      if (error) throw mapErr(error);
      const d = (data ?? { closed: false, votes: [] }) as {
        closed?: boolean;
        votes?: { optionId: string; profileId: string; name: string | null; avatar: string | null }[];
      };
      return {
        closed: !!d.closed,
        votes: (d.votes ?? []).map((v) => ({
          optionId: v.optionId,
          profileId: v.profileId,
          name: v.name ?? null,
          avatar: v.avatar ?? null,
        })),
      };
    }),

  /** Close the poll (creator only). */
  close: protectedProcedure
    .input(z.object({ messageId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db as unknown as LooseRpc;
      const { error } = await db.rpc("close_poll", { p_message: input.messageId });
      if (error) throw mapErr(error);
      return { ok: true as const };
    }),
});
