/**
 * fsaAdmin router — Roam HQ reads for the FSA hygiene-rating match review (backlog #51).
 *
 * Observe side of the FSA view: the review queue (unlinked food venues with their ranked candidate
 * establishments, re-scored on demand), a free-text corpus search, and the coverage numbers.
 * Staff-only via adminProcedure; reads go through ctx.service (fsa_match_dismissals is
 * service-managed). The audited WRITES (confirm / unlink / dismiss) live in adminActions, mirroring
 * how channelsAdmin (observe) and adminActions (act) split the B4b roster queue.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { admin } from "@roam/core";
import { router, adminProcedure } from "../trpc.js";

function boom(e: unknown, fallback: string): never {
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e instanceof Error ? e.message : fallback });
}

export const fsaAdminRouter = router({
  /** Unlinked food venues with ranked FSA candidates, most confident first. */
  reviewQueue: adminProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
        includeDismissed: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await admin.fsaReviewQueue(ctx.service, input);
      } catch (e) {
        boom(e, "Failed to load the FSA review queue.");
      }
    }),

  /** Free-text search of the synced FSA corpus by trading name. */
  search: adminProcedure
    .input(z.object({ q: z.string().min(2).max(80), limit: z.number().int().min(1).max(30).default(15) }))
    .query(async ({ ctx, input }) => {
      try {
        return await admin.fsaSearch(ctx.service, input);
      } catch (e) {
        boom(e, "FSA search failed.");
      }
    }),

  /** Headline coverage: food venues, linked, dismissed, percentage. */
  coverage: adminProcedure.query(async ({ ctx }) => {
    try {
      return await admin.fsaCoverage(ctx.service);
    } catch (e) {
      boom(e, "Failed to load FSA coverage.");
    }
  }),
});
