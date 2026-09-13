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
import { importRoster, recordImportBackfill } from "../jobs/importRoster.js";
import { sendMemberInvite } from "../f2g/invite.js";
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

  /** Tag or untag a venue into a marketplace channel (e.g. Food to Go). */
  setVenueChannel: adminProcedure
    .input(
      z.object({
        venueId: z.string().uuid(),
        channelKey: z.string().min(1).max(32),
        member: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.setVenueChannel(
          ctx.service,
          await actor(ctx as ActingCtx),
          input.venueId,
          input.channelKey,
          input.member,
        );
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to update venue channel.");
      }
    }),

  /**
   * Edit a channel's configuration (theme / logo / surface / sections / nav / membership_mode).
   * Each field is re-validated by the core parsers; the membership_mode flip (open↔members) is one
   * of these keys — audited here, and the console additionally gates it behind a confirmation.
   */
  setChannelConfig: adminProcedure
    .input(
      z.object({
        channelKey: z.string().min(1).max(32),
        patch: z.object({
          theme: z.record(z.string(), z.string()).optional(),
          logoUrl: z.string().max(2000).nullable().optional(),
          surface: z.enum(["roam", "storefront"]).optional(),
          sections: z.record(z.string(), z.boolean()).optional(),
          nav: z.array(z.object({ key: z.string(), href: z.string(), labelKey: z.string() })).optional(),
          membershipMode: z.enum(["open", "members"]).optional(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.setChannelConfig(ctx.service, await actor(ctx as ActingCtx), input.channelKey, input.patch);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to update channel config.");
      }
    }),

  /** Onboard a hostname to a channel (a channel_domains row). */
  addChannelDomain: adminProcedure
    .input(z.object({ channelKey: z.string().min(1).max(32), host: z.string().min(1).max(255) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.addChannelDomain(ctx.service, await actor(ctx as ActingCtx), input.channelKey, input.host);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to add channel domain.");
      }
    }),

  /** Remove a hostname from a channel. */
  removeChannelDomain: adminProcedure
    .input(z.object({ channelKey: z.string().min(1).max(32), host: z.string().min(1).max(255) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.removeChannelDomain(ctx.service, await actor(ctx as ActingCtx), input.channelKey, input.host);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to remove channel domain.");
      }
    }),

  /**
   * Bulk-import an Association roster CSV into a channel and run the matcher (B3-a/b). Staff-gated +
   * audited; the detailed per-run outcome is recorded in channel_import_runs. Returns the run report
   * plus the thin matched venue ids, which the caller enriches (B3-c) via places.enrichVenue and then
   * reports back through recordImportBackfill.
   */
  importRoster: adminProcedure
    .input(z.object({ channelKey: z.string().min(1).max(32), csv: z.string().min(1).max(5_000_000) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const who = await actor(ctx as ActingCtx);
        const report = await importRoster(ctx.service, { channelKey: input.channelKey, csv: input.csv, actorId: who.id });
        await admin.recordAudit(ctx.service, who, {
          action: "import_roster",
          entityType: "channel",
          entityId: input.channelKey,
          detail: {
            imported: report.imported, updated: report.updated,
            matchedAccept: report.matchedAccept, matchedReview: report.matchedReview,
            matchedReject: report.matchedReject, errors: report.errors,
          },
        });
        return report;
      } catch (e) {
        fail(e, "Roster import failed.");
      }
    }),

  /**
   * Send (or resend) a claim invite to a matched roster member (B3-d). Idempotent: calling it again
   * mints a fresh-expiry link and re-stamps the member, which is exactly the "resend" case (B4b). The
   * email goes only to the member's source_email; the signed capability link confers ownership when
   * accepted by a signed-in user. Staff-gated + audited; the per-member outcome is returned so the
   * console can report it. Never throws for the ordinary "can't invite yet" outcomes.
   */
  sendInvite: adminProcedure
    .input(z.object({ channelKey: z.string().min(1).max(32), memberId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const who = await actor(ctx as ActingCtx);
        const result = await sendMemberInvite(
          ctx.service,
          {
            inviteSecret: ctx.env.f2g.inviteSecret,
            inviteTtlMs: ctx.env.f2g.inviteTtlDays * 24 * 60 * 60 * 1000,
            brevoApiKey: ctx.env.brevo.apiKey,
            sender: { email: ctx.env.brevo.senderEmail, name: ctx.env.brevo.senderName },
            webOrigin: ctx.env.stripe.webOrigin,
          },
          { channelKey: input.channelKey, memberId: input.memberId },
        );
        // Audit only an actual send (the ownership-granting capability left the building).
        if (result.invited) {
          await admin.recordAudit(ctx.service, who, {
            action: "send_invite",
            entityType: "channel_member",
            entityId: input.memberId,
            detail: { channelKey: input.channelKey },
          });
        }
        return result;
      } catch (e) {
        fail(e, "Failed to send invite.");
      }
    }),

  /** Record how many matched venues were enriched (B3-c) against an import run. */
  recordImportBackfill: adminProcedure
    .input(z.object({ runId: z.string().uuid(), backfilled: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await recordImportBackfill(ctx.service, input.runId, input.backfilled);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to record backfill count.");
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
