/**
 * F2G invite→claim orchestration (B3-d) — the service-side logic behind the invite email and the
 * claim landing page.
 *
 *   sendMemberInvite  — issues a signed capability link for a matched roster member and emails it to
 *                       their source_email, stamping the member invited. Staff-triggered, audited by
 *                       the caller.
 *   claimMemberVenue  — verifies nothing itself (the router has already verified the token + the
 *                       signed-in claimant); it calls the SECURITY DEFINER conferral
 *                       `claim_channel_member_venue` (0139) with the service client and maps its typed
 *                       SQLSTATE raises to a clean, discriminated outcome for the landing page.
 *
 * Both run with the service client (channel_members is service-managed PII; the conferral is
 * service-role-only). The dangerous owner_id write lives ONLY in the definer — this module never
 * writes venues.owner_id.
 */
import type { RoamClient } from "@roam/db";
import { membership, channels as coreChannels } from "@roam/core";
import { sendTransactionalEmail, type EmailSender } from "../brevo/transactional.js";
import { issueInviteToken } from "./inviteToken.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = { from: (t: string) => any };
const loose = (c: RoamClient) => c as unknown as Loose;

// ── claim ──────────────────────────────────────────────────────────────────────────────────────

/** The outcome of a conferral attempt — a superset of the definer's returned + raised outcomes. */
export type ClaimOutcome =
  | "claimed" // this call conferred ownership
  | "already_claimed" // idempotent no-op: the same claimant already owns it
  | "claimed_by_other" // refused: the venue is owned by a different user
  | "not_claimable" // refused: the member's status is not imported/invited
  | "venue_mismatch" // refused: the token's venue doesn't match the member's match
  | "not_found"; // the member or venue no longer exists

export interface ClaimResult {
  outcome: ClaimOutcome;
  venueId: string | null;
}

/**
 * Confer ownership for a verified invite. `service` MUST be the RLS-bypassing service client and
 * `claimantId` MUST be the signed-in user's id (resolved from the JWT by the caller — never from the
 * token). Maps the definer's typed raises to a discriminated outcome; only a genuinely unexpected DB
 * error throws.
 */
export async function claimMemberVenue(
  service: RoamClient,
  args: { memberId: string; venueId: string; claimantId: string },
): Promise<ClaimResult> {
  const rpc = service.rpc.bind(service) as unknown as (
    fn: string,
    params: Record<string, unknown>,
  ) => Promise<{ data: any; error: { message: string; code?: string } | null }>;

  const { data, error } = await rpc("claim_channel_member_venue", {
    p_member_id: args.memberId,
    p_venue_id: args.venueId,
    p_claimant_id: args.claimantId,
  });

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("VENUE_MISMATCH")) return { outcome: "venue_mismatch", venueId: null };
    if (msg.includes("CLAIMED_BY_OTHER")) return { outcome: "claimed_by_other", venueId: null };
    if (msg.includes("NOT_CLAIMABLE")) return { outcome: "not_claimable", venueId: null };
    if (msg.includes("MEMBER_NOT_FOUND") || msg.includes("VENUE_NOT_FOUND"))
      return { outcome: "not_found", venueId: null };
    if (msg.includes("CLAIMANT_REQUIRED")) return { outcome: "not_found", venueId: null };
    throw new Error(`claimMemberVenue: ${msg}`);
  }

  // A function returning a single composite comes back as an object (occasionally wrapped in a
  // one-element array by the PostgREST layer) — accept either shape.
  const row = (Array.isArray(data) ? data[0] : data) ?? {};
  const outcome = (row.outcome as ClaimOutcome | undefined) ?? "claimed";
  return { outcome, venueId: (row.venue_id as string | undefined) ?? args.venueId };
}

// ── invite send ────────────────────────────────────────────────────────────────────────────────

export interface SendInviteDeps {
  inviteSecret: string | null;
  inviteTtlMs: number;
  brevoApiKey: string | null;
  sender: EmailSender;
  /** Web app origin — the claim link is `${webOrigin}/f2g/claim?token=…`. */
  webOrigin: string;
}

export type SendInviteOutcome =
  | "sent"
  | "unconfigured" // no invite secret / no Brevo key
  | "not_found" // member not on the channel
  | "not_matched" // member has no matched venue to claim
  | "no_email" // member has no source_email to send to
  | "not_invitable" // member status can't transition to invited (already claimed/removed)
  | "send_failed"; // Brevo returned a failure

export interface SendInviteResult {
  outcome: SendInviteOutcome;
  /** Whether the member row was stamped invited (true only when the email actually went out). */
  invited: boolean;
}

interface MemberRow {
  id: string;
  channel_id: string;
  source_name: string;
  source_email: string | null;
  venue_id: string | null;
  status: membership.MemberStatus;
}

/** The invite email body. Exported for unit tests; plain, single-CTA, with the source name. */
export function renderInviteEmail(args: {
  sourceName: string;
  claimUrl: string;
  channelName: string;
}): { subject: string; html: string; text: string } {
  const { sourceName, claimUrl, channelName } = args;
  const safeName = sourceName.trim() || "there";
  const subject = `Claim your ${channelName} listing`;
  const text = [
    `Hi ${safeName},`,
    "",
    `Your business has a listing on ${channelName}. Claim it to manage your details, menu and orders.`,
    "",
    `Claim your listing: ${claimUrl}`,
    "",
    "If you weren't expecting this, you can ignore this email — nothing changes until you claim.",
  ].join("\n");
  const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
  <p>Hi ${escapeHtml(safeName)},</p>
  <p>Your business has a listing on <strong>${escapeHtml(channelName)}</strong>. Claim it to manage your details, menu and orders.</p>
  <p style="margin:28px 0">
    <a href="${escapeAttr(claimUrl)}" style="background:#0f766e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600">Claim your listing</a>
  </p>
  <p style="color:#6b7280;font-size:13px">If you weren't expecting this, you can ignore this email — nothing changes until you claim.</p>
</div>`.trim();
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/**
 * Issue + email a claim invite for one roster member. Idempotent-safe to call repeatedly (a resend
 * simply mints a fresh-expiry link and re-stamps invited_at). Returns a discriminated outcome so the
 * admin surface can report per-member results without exceptions for the ordinary "can't invite yet"
 * cases.
 */
export async function sendMemberInvite(
  service: RoamClient,
  deps: SendInviteDeps,
  args: { channelKey: string; memberId: string },
): Promise<SendInviteResult> {
  if (!deps.inviteSecret || !deps.brevoApiKey) return { outcome: "unconfigured", invited: false };

  const channel = await coreChannels.getChannelByKey(service, args.channelKey);
  if (!channel || channel.isDefault) return { outcome: "not_found", invited: false };

  const { data, error } = await loose(service)
    .from("channel_members")
    .select("id, channel_id, source_name, source_email, venue_id, status")
    .eq("id", args.memberId)
    .eq("channel_id", channel.id)
    .maybeSingle();
  if (error) throw new Error(`sendMemberInvite: member read failed: ${error.message}`);
  const member = data as MemberRow | null;
  if (!member) return { outcome: "not_found", invited: false };
  if (!member.venue_id) return { outcome: "not_matched", invited: false };
  const email = member.source_email?.trim();
  if (!email) return { outcome: "no_email", invited: false };
  // Only imported/invited members can (re)transition to invited — never re-invite a claimed/removed one.
  if (!membership.canTransition(member.status, "invited")) {
    return { outcome: "not_invitable", invited: false };
  }

  const { token } = issueInviteToken(member.id, member.venue_id, deps.inviteSecret, deps.inviteTtlMs);
  const base = deps.webOrigin.replace(/\/+$/, "");
  const claimUrl = `${base}/f2g/claim?token=${encodeURIComponent(token)}`;
  const rendered = renderInviteEmail({
    sourceName: member.source_name,
    claimUrl,
    channelName: channel.name,
  });

  const ok = await sendTransactionalEmail(deps.brevoApiKey, deps.sender, {
    toEmail: email,
    toName: member.source_name || undefined,
    subject: rendered.subject,
    htmlContent: rendered.html,
    textContent: rendered.text,
  });
  if (!ok) return { outcome: "send_failed", invited: false };

  // Stamp invited only after the email actually went out, so a send failure leaves state re-tryable.
  const { error: upErr } = await loose(service)
    .from("channel_members")
    .update({ status: "invited", invited_at: new Date().toISOString() })
    .eq("id", member.id);
  if (upErr) throw new Error(`sendMemberInvite: status stamp failed: ${upErr.message}`);

  return { outcome: "sent", invited: true };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
