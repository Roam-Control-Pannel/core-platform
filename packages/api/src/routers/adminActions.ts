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
import { admin, channels as coreChannels } from "@roam/core";
import { importRoster, recordImportBackfill } from "../jobs/importRoster.js";
import { runHubspotSync } from "../jobs/syncHubspotMembers.js";
import { loadHubspotAppConfig, authorizeUrl } from "../hubspot/oauth.js";
import { getIntegration, disconnectIntegration, toStatus, forgetCachedToken } from "../hubspot/store.js";
import { canSealSecrets } from "../integrations/secretBox.js";
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
   * Appoint a partner officer, or change the role they hold (plan 3.1, migration 0156).
   *
   * This is the act that lets someone outside Roam see a whole channel's membership, so it is
   * staff-only and audited. Re-appointing the same person updates their role; `channel_admins` has
   * no client write policy, so this path is the only way such a row can exist.
   */
  setChannelOfficer: adminProcedure
    .input(
      z.object({
        channelKey: z.string().min(1).max(32),
        profileId: z.string().uuid(),
        role: z.enum(["officer", "viewer"]),
        note: z.string().max(500).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.setChannelOfficer(
          ctx.service,
          await actor(ctx as ActingCtx),
          input.channelKey,
          input.profileId,
          input.role,
          input.note ?? null,
        );
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to appoint channel officer.");
      }
    }),

  /** Revoke a partner officer's role. Idempotent — revoking a role nobody holds is not an error. */
  removeChannelOfficer: adminProcedure
    .input(z.object({ channelKey: z.string().min(1).max(32), profileId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.removeChannelOfficer(
          ctx.service,
          await actor(ctx as ActingCtx),
          input.channelKey,
          input.profileId,
        );
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to remove channel officer.");
      }
    }),

  /**
   * Bulk-import an Association roster CSV into a channel and run the matcher (B3-a/b). Staff-gated +
   * audited; the detailed per-run outcome is recorded in channel_import_runs. Returns the run report
   * plus the thin matched venue ids, which the caller enriches (B3-c) via places.enrichVenue and then
   * reports back through recordImportBackfill.
   */
  /**
   * Import (or REHEARSE importing) an Association roster. `dryRun` defaults to TRUE: committing a
   * partner's roster to the roster of record must be something the operator asked for explicitly, not
   * what happens when a field is omitted. `mapping` lets the operator bind an unfamiliar header to a
   * canonical field from the HQ preview, so a new export shape needs no release.
   */
  importRoster: adminProcedure
    .input(
      z.object({
        channelKey: z.string().min(1).max(32),
        csv: z.string().min(1).max(5_000_000),
        dryRun: z.boolean().default(true),
        mapping: z.record(z.string().max(200), z.string().max(40)).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const who = await actor(ctx as ActingCtx);
        const report = await importRoster(ctx.service, {
          channelKey: input.channelKey,
          csv: input.csv,
          actorId: who.id,
          dryRun: input.dryRun,
          mapping: input.mapping,
        });
        // A dry run wrote nothing, so there is no state change to attribute. The audit trail records
        // imports, not rehearsals of them.
        if (!input.dryRun) {
          await admin.recordAudit(ctx.service, who, {
            action: "import_roster",
            entityType: "channel",
            entityId: input.channelKey,
            detail: {
              imported: report.imported, updated: report.updated,
              matchedAccept: report.matchedAccept, matchedReview: report.matchedReview,
              matchedReject: report.matchedReject, matchedConflict: report.matchedConflict,
              errors: report.errors,
            },
          });
        }
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

  /**
   * Begin "Connect your HubSpot" for a channel: returns the URL to send the partner to.
   *
   * The link is a short-lived signed capability (the `state` parameter names the channel and is
   * HMAC-verified at the callback), so issuing it is the authorised step and the public callback
   * needs no Roam session of its own. One HubSpot app serves every whitelabel — adding a partner is
   * this click, not an engineering task.
   */
  hubspotConnectUrl: adminProcedure
    .input(z.object({ channelKey: z.string().min(1).max(32) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const who = await actor(ctx as ActingCtx);
        const app = loadHubspotAppConfig();
        if (!app) return { status: "unconfigured" as const };
        // Refuse to start a flow whose credential we could not then store safely — better here than
        // after the partner has approved access and we drop their token on the floor.
        if (!canSealSecrets()) return { status: "no_encryption_key" as const };
        const channel = await coreChannels.getChannelByKey(ctx.service, input.channelKey);
        if (!channel || channel.isDefault) return { status: "unknown_channel" as const };
        await admin.recordAudit(ctx.service, who, {
          action: "hubspot_connect_started",
          entityType: "channel",
          entityId: input.channelKey,
          detail: {},
        });
        return { status: "ok" as const, url: authorizeUrl(app, input.channelKey) };
      } catch (e) {
        fail(e, "Could not start the HubSpot connection.");
      }
    }),

  /** Whether a channel has a working HubSpot connection, which portal, and when it last synced. */
  hubspotStatus: adminProcedure
    .input(z.object({ channelKey: z.string().min(1).max(32) }))
    .query(async ({ ctx, input }) => {
      try {
        const app = loadHubspotAppConfig();
        const channel = await coreChannels.getChannelByKey(ctx.service, input.channelKey);
        if (!channel) return { configured: !!app, connected: false as const };
        const row = await getIntegration(ctx.service, channel.id);
        return { configured: !!app, ...toStatus(row) };
      } catch (e) {
        fail(e, "Could not read the HubSpot connection.");
      }
    }),

  /** Forget a partner's credential. They should also uninstall the app on their side. */
  hubspotDisconnect: adminProcedure
    .input(z.object({ channelKey: z.string().min(1).max(32) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const who = await actor(ctx as ActingCtx);
        const channel = await coreChannels.getChannelByKey(ctx.service, input.channelKey);
        if (!channel) return { ok: false as const };
        await disconnectIntegration(ctx.service, channel.id);
        forgetCachedToken(channel.id);
        await admin.recordAudit(ctx.service, who, {
          action: "hubspot_disconnected",
          entityType: "channel",
          entityId: input.channelKey,
          detail: {},
        });
        return { ok: true as const };
      } catch (e) {
        fail(e, "Could not disconnect HubSpot.");
      }
    }),

  /**
   * Pull a partner's membership from HubSpot on demand (plan 2.3), rather than waiting for the
   * nightly cron — the "sync now" an officer will get in the portal (Phase 3), available to HQ
   * first. `dryRun` defaults TRUE for the same reason it does on importRoster: reading a partner's
   * CRM into the roster of record should be something someone asked for, not a default.
   */
  syncHubspot: adminProcedure
    .input(
      z.object({
        channelKey: z.string().min(1).max(32),
        full: z.boolean().default(false),
        dryRun: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const who = await actor(ctx as ActingCtx);
        const app = loadHubspotAppConfig();
        if (!app) return { status: "unconfigured" as const };
        const result = await runHubspotSync(
          ctx.service,
          app,
          {
            channelKey: input.channelKey,
            since: input.full ? null : new Date(Date.now() - 36 * 60 * 60 * 1000),
            dryRun: input.dryRun,
            actorId: who.id,
          },
          (m) => console.log(m),
        );
        if (!input.dryRun) {
          await admin.recordAudit(ctx.service, who, {
            action: "sync_hubspot_members",
            entityType: "channel",
            entityId: input.channelKey,
            detail: {
              full: input.full, fetched: result.fetched, inserted: result.inserted,
              updated: result.updated, withEmail: result.withEmail,
              matchedAccept: result.matchedAccept, matchedConflict: result.matchedConflict,
            },
          });
        }
        return result;
      } catch (e) {
        fail(e, "HubSpot sync failed.");
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

  /**
   * Confirm a reviewer's chosen venue for a roster member (B4b match-review): writes the manual
   * external_ref of record and binds the venue. Staff-gated + audited by the core action.
   */
  confirmMatch: adminProcedure
    .input(
      z.object({
        channelKey: z.string().min(1).max(32),
        memberId: z.string().uuid(),
        venueId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.confirmMatch(ctx.service, await actor(ctx as ActingCtx), input);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to confirm the match.");
      }
    }),

  /**
   * Move a roster member to live / lapsed / removed (holistic plan Phase 1.2 — the "live" spine).
   * Subject to the membership state machine; `live` requires a matched venue. Staff-gated + audited
   * by the core action.
   */
  setMemberStatus: adminProcedure
    .input(
      z.object({
        channelKey: z.string().min(1).max(32),
        memberId: z.string().uuid(),
        status: z.enum(["live", "lapsed", "removed"]),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await admin.setMemberStatus(ctx.service, await actor(ctx as ActingCtx), input);
      } catch (e) {
        fail(e, "Failed to update the member's status.");
      }
    }),

  /** Dismiss (or undo dismissing) a member from the match-review queue (B4b). Audited. */
  setMatchDismissed: adminProcedure
    .input(
      z.object({
        channelKey: z.string().min(1).max(32),
        memberId: z.string().uuid(),
        dismissed: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.setMatchDismissed(ctx.service, await actor(ctx as ActingCtx), input);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to update the match dismissal.");
      }
    }),

  /** FSA review (#51): confirm a venue ↔ establishment link — the manual match of record. Audited. */
  confirmFsaMatch: adminProcedure
    .input(z.object({ venueId: z.string().uuid(), fhrsid: z.string().min(1).max(40) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.confirmFsaMatch(ctx.service, await actor(ctx as ActingCtx), input);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to confirm the FSA match.");
      }
    }),

  /** FSA review: remove a wrong link and dismiss the venue so the nightly sync can't re-link it. Audited. */
  unlinkFsaMatch: adminProcedure
    .input(z.object({ venueId: z.string().uuid(), note: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.unlinkFsaMatch(ctx.service, await actor(ctx as ActingCtx), input);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to unlink the FSA match.");
      }
    }),

  /** FSA review: dismiss ("no FSA record is this venue") or undo. Audited. */
  setFsaMatchDismissed: adminProcedure
    .input(z.object({ venueId: z.string().uuid(), dismissed: z.boolean(), note: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await admin.setFsaMatchDismissed(ctx.service, await actor(ctx as ActingCtx), input);
        return { ok: true as const };
      } catch (e) {
        fail(e, "Failed to update the FSA dismissal.");
      }
    }),

  /** Approve (goes live + public) or reject (stays a hidden draft) a supplier submission. Audited. */
  moderateSupplier: adminProcedure
    .input(z.object({ orgId: z.string().uuid(), decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await admin.moderateSupplier(ctx.service, await actor(ctx as ActingCtx), input);
      } catch (e) {
        fail(e, "Failed to moderate the supplier.");
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
