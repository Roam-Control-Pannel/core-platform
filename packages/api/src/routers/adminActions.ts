/**
 * adminActions router — Roam HQ privileged actions (v2 "Act").
 *
 * adminProcedure gates staff membership; on top of that these mutations require an
 * ACTING role (admin/owner) — viewers are observe-only. Every action is attributed to
 * the acting staff member and written to admin_audit_log by the core action functions.
 *
 * The actual operations reuse the existing service-role plumbing (0029 moderation fns,
 * 0007/0008 claim fns, moderation_queue resolve) — HQ adds identity + audit, nothing more.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { admin } from "@roam/core";
import { router, adminProcedure } from "../trpc.js";
import type { Context } from "../context.js";
import type { AdminRole } from "../trpc.js";

type ActingCtx = Context & { service: import("@roam/db").RoamClient; admin: { id: string; role: AdminRole } };

/**
 * Resolve the acting staff member (id + a best-effort email snapshot) and enforce that
 * they may ACT. Viewers get FORBIDDEN. Email is looked up once via the service-role auth
 * admin API; a failure there is non-fatal (email is a convenience snapshot, not a gate).
 */
async function actor(ctx: ActingCtx): Promise<admin.AdminActor> {
  if (ctx.admin.role === "viewer") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Your Roam HQ role is view-only. Ask an owner for acting access.",
    });
  }
  let email: string | null = null;
  try {
    const { data } = await ctx.service.auth.admin.getUserById(ctx.admin.id);
    email = data.user?.email ?? null;
  } catch {
    /* non-fatal: proceed with a null email snapshot */
  }
  return { id: ctx.admin.id, email };
}

function fail(e: unknown, fallback: string): never {
  if (e instanceof TRPCError) throw e;
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: e instanceof Error ? e.message : fallback,
  });
}

export const adminActionsRouter = router({
  /** Ban or un-ban a user. */
  setUserBanned: adminProcedure
    .input(z.object({ userId: z.string().uuid(), banned: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.setUserBanned(ctx.service, await actor(ctx as ActingCtx), input.userId, input.banned);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to update ban state.");
      }
    }),

  /** Suspend or restore a venue. */
  setVenueSuspended: adminProcedure
    .input(z.object({ venueId: z.string().uuid(), suspended: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.setVenueSuspended(ctx.service, await actor(ctx as ActingCtx), input.venueId, input.suspended);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to update venue state.");
      }
    }),

  /** Approve a pending venue claim (confers ownership). */
  approveClaim: adminProcedure
    .input(z.object({ claimId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.approveClaim(ctx.service, await actor(ctx as ActingCtx), input.claimId);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to approve claim.");
      }
    }),

  /** Reject a pending venue claim. */
  rejectClaim: adminProcedure
    .input(z.object({ claimId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.rejectClaim(ctx.service, await actor(ctx as ActingCtx), input.claimId);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to reject claim.");
      }
    }),

  /** Resolve a moderation queue item (approve = keep / reject = actioned). */
  resolveReport: adminProcedure
    .input(z.object({ reportId: z.string().uuid(), decision: z.enum(["approved", "rejected"]) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.resolveReport(ctx.service, await actor(ctx as ActingCtx), input.reportId, input.decision);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to resolve report.");
      }
    }),
});
