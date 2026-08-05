/**
 * adminActivity router — Roam HQ live activity feed + trust & safety queue (read).
 *
 * Observe-only in v1. Gated by adminProcedure (staff-only; ctx.service is the verified
 * service-role client). Resolve/act on queue items arrives in Phase 3.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { admin } from "@roam/core";
import { router, adminProcedure } from "../trpc.js";

export const adminActivityRouter = router({
  /** The merged, newest-first site-wide activity stream. */
  feed: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(40) }))
    .query(async ({ ctx, input }) => {
      try {
        return await admin.getActivityFeed(ctx.service, input.limit);
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Failed to load activity feed.",
        });
      }
    }),

  /** Open moderation queue (auto-flags + user reports awaiting review). */
  moderationQueue: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      try {
        return await admin.getModerationQueue(ctx.service, input.limit);
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Failed to load moderation queue.",
        });
      }
    }),

  /** The privileged-action audit trail (who did what, newest first). */
  auditLog: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }))
    .query(async ({ ctx, input }) => {
      try {
        return await admin.getAuditLog(ctx.service, input.limit);
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Failed to load audit log.",
        });
      }
    }),
});
