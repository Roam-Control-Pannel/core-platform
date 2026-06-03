/**
 * Credits router — thin wrapper over @roam/core/credits.
 *
 * Read of a venue's balance is protected (a logged-in venue owner; RLS on
 * push_credit_ledger enforces they can only see their own). Consuming credits for a
 * send and crediting back (refund/grant) are SERVER-driven actions — they happen via
 * the push-send Edge Function and the Stripe webhook, not a user button — so they're
 * internal procedures using the service client. This keeps the ledger's integrity on
 * the server side, matching the append-only model.
 */
import { z } from "zod";
import { credits } from "@roam/core";
import { router, protectedProcedure, internalProcedure } from "../trpc.js";

const venueIdInput = z.object({ venueId: z.string().uuid() });

export const creditsRouter = router({
  /** A venue owner reads their own credit balance (RLS-guarded). */
  balance: protectedProcedure
    .input(venueIdInput)
    .query(async ({ ctx, input }) => {
      const balance = await credits.getBalance(ctx.db, input.venueId);
      return { venueId: input.venueId, balance };
    }),

  /** Internal: consume credits for a push send. Called by the send Edge Function. */
  consumeForSend: internalProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        cost: z.number().int().nonnegative(),
        ref: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return credits.consumeForSend(
        ctx.service,
        input.venueId,
        input.cost,
        input.ref,
      );
    }),

  /** Internal: credit a venue (grant/purchase/refund/adjustment). Webhook + cron. */
  credit: internalProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        amount: z.number().int().positive(),
        reason: z.enum(["grant", "purchase", "refund", "adjustment"]),
        ref: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const balance = await credits.creditVenue(
        ctx.service,
        input.venueId,
        input.amount,
        input.reason,
        input.ref,
      );
      return { venueId: input.venueId, balance };
    }),
});
