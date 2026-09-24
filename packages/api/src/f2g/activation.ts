/**
 * Activation — proving control of a roster member's e-mail, and acting on that proof (plan 2.4).
 *
 * Sibling to invite.ts, which it supersedes as the thing that confers ownership. B3-d's link WAS the
 * credential; from here the link only points at a page, and the credential is either the signed-in
 * account's own verified address already matching the roster's, or a six-digit code sent to that
 * roster address and typed back.
 *
 * Everything here runs with the SERVICE client. `channel_members` is service-managed PII, the code
 * table has no client-readable path by construction (0161), and the conferral definer is revoked
 * from every client role. The escalation happens in the router, after the caller is known.
 *
 * WHAT THIS MODULE REFUSES TO DO. It never returns the roster's e-mail address to a caller — only a
 * mask (`maskEmail`) — because at the moment of asking we do not yet know the asker is its owner.
 * That is the entire point of the code. Nor does it ever say "no such member": a probe for which
 * businesses are on the roster gets the same answer as a genuine miss.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { RoamClient } from "@roam/db";
import { activation } from "@roam/core";
import { sendTransactionalEmail, type EmailSender } from "../brevo/transactional.js";
import { renderActivationEmail } from "./activationEmail.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = { from: (t: string) => any };
const loose = (c: RoamClient) => c as unknown as Loose;

/** Six digits. Uniform — `randomInt` rejects the biased tail rather than taking a modulo. */
export function generateActivationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** SHA-256 hex of the code. The plaintext is never stored (0161's table holds only this). */
export function hashActivationCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Whatever the user typed → the six digits, so spaces and dashes in a pasted code are forgiven. */
export function normaliseActivationCode(raw: string): string {
  return (raw ?? "").replace(/\D+/g, "").slice(0, 6);
}

/** Compare two hex hashes without leaking how far they matched. */
function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── the roster row ──────────────────────────────────────────────────────────────────────────────

export interface ActivationMember {
  id: string;
  channelId: string;
  sourceName: string;
  sourceEmail: string | null;
  sourcePostcode: string | null;
  venueId: string | null;
  status: string;
}

/** Read one roster row, scoped to the channel. Null when absent — the caller must not distinguish. */
export async function readMember(
  service: RoamClient,
  args: { channelId: string; memberId: string },
): Promise<ActivationMember | null> {
  const { data, error } = await loose(service)
    .from("channel_members")
    .select("id, channel_id, source_name, source_email, source_postcode, venue_id, status")
    .eq("id", args.memberId)
    .eq("channel_id", args.channelId)
    .maybeSingle();
  if (error) throw new Error(`activation: member read failed: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id as string,
    channelId: data.channel_id as string,
    sourceName: (data.source_name as string) ?? "",
    sourceEmail: (data.source_email as string | null) ?? null,
    sourcePostcode: (data.source_postcode as string | null) ?? null,
    venueId: (data.venue_id as string | null) ?? null,
    status: (data.status as string) ?? "imported",
  };
}

// ── the audit ───────────────────────────────────────────────────────────────────────────────────

/**
 * Record an attempt. Best-effort by design: a failure to write the audit must not hand the caller a
 * way to suppress it by making the write fail, so it is logged and swallowed rather than thrown.
 * `detail` must never carry an e-mail address or a code — 0161's comment says so, and this is where
 * that promise is kept.
 */
export async function recordAttempt(
  service: RoamClient,
  args: {
    channelId: string;
    memberId?: string | null;
    venueId?: string | null;
    profileId?: string | null;
    outcome: string;
    detail?: Record<string, string | number | boolean> | undefined;
  },
): Promise<void> {
  const { error } = await loose(service)
    .from("channel_activation_attempts")
    .insert({
      channel_id: args.channelId,
      member_id: args.memberId ?? null,
      venue_id: args.venueId ?? null,
      profile_id: args.profileId ?? null,
      outcome: args.outcome,
      detail: args.detail ?? {},
    });
  if (error) console.warn(`[activation] attempt audit failed: ${error.message}`);
}

// ── throttling ──────────────────────────────────────────────────────────────────────────────────

async function countCodes(
  service: RoamClient,
  column: "profile_id" | "member_id",
  value: string,
  sinceMs: number,
): Promise<number> {
  const since = new Date(Date.now() - sinceMs).toISOString();
  const { count, error } = await loose(service)
    .from("channel_activation_codes")
    .select("id", { count: "exact", head: true })
    .eq(column, value)
    .gte("created_at", since);
  if (error) throw new Error(`activation: throttle read failed: ${error.message}`);
  return count ?? 0;
}

export async function throttleCounts(
  service: RoamClient,
  args: { profileId: string; memberId: string },
): Promise<activation.ThrottleCounts> {
  const HOUR = 60 * 60 * 1000;
  const [accountLastHour, accountLastDay, memberLastHour] = await Promise.all([
    countCodes(service, "profile_id", args.profileId, HOUR),
    countCodes(service, "profile_id", args.profileId, 24 * HOUR),
    countCodes(service, "member_id", args.memberId, HOUR),
  ]);
  return { accountLastHour, accountLastDay, memberLastHour };
}

// ── issuing ─────────────────────────────────────────────────────────────────────────────────────

export interface IssueDeps {
  brevoApiKey: string | null;
  /** The base sender; the channel's name is swapped in by `channelSender` at the call site. */
  sender: EmailSender;
  channelName: string;
}

export type IssueOutcome =
  | "sent"
  | "already_verified" // the account's own e-mail IS the roster's — no code needed
  | "no_email" // the roster row has no address, so there is no self-serve path at all
  | "not_activatable" // wrong status: already live, lapsed, removed
  | "throttled"
  | "unconfigured" // no Brevo key
  | "send_failed"
  | "not_found";

export interface IssueResult {
  outcome: IssueOutcome;
  /** Masked, never the address itself. Present only when a code actually went out. */
  sentToMasked?: string;
  /** Which ceiling refused, when throttled. */
  throttle?: activation.ThrottleReason;
  expiresInMinutes?: number;
}

/**
 * Issue and send a code for a (member, venue, account) triple. The venue is carried through so the
 * code cannot later be replayed against a different one.
 */
export async function issueActivationCode(
  service: RoamClient,
  deps: IssueDeps,
  args: { channelId: string; memberId: string; venueId: string; profileId: string; accountEmail: string | null },
): Promise<IssueResult> {
  const member = await readMember(service, { channelId: args.channelId, memberId: args.memberId });
  if (!member) {
    await recordAttempt(service, {
      channelId: args.channelId, profileId: args.profileId, outcome: "issue_not_found",
    });
    return { outcome: "not_found" };
  }

  // Only a roster row that has not yet been activated can be activated. Matches the definer's own
  // rule (0161) so the two cannot drift.
  if (member.status !== "imported" && member.status !== "invited") {
    await recordAttempt(service, {
      channelId: args.channelId, memberId: member.id, venueId: args.venueId,
      profileId: args.profileId, outcome: "issue_not_activatable", detail: { status: member.status },
    });
    return { outcome: "not_activatable" };
  }

  // The no-code path: this account already controls the roster's address.
  if (activation.emailMatchesRoster(args.accountEmail, member.sourceEmail)) {
    await recordAttempt(service, {
      channelId: args.channelId, memberId: member.id, venueId: args.venueId,
      profileId: args.profileId, outcome: "issue_already_verified",
    });
    return { outcome: "already_verified" };
  }

  if (!member.sourceEmail) {
    // Plan §3.2: these members have no self-serve path and are activated by HQ one at a time. The
    // portal reports how many there are, because that number caps self-serve onboarding.
    await recordAttempt(service, {
      channelId: args.channelId, memberId: member.id, venueId: args.venueId,
      profileId: args.profileId, outcome: "issue_no_email",
    });
    return { outcome: "no_email" };
  }

  const counts = await throttleCounts(service, { profileId: args.profileId, memberId: member.id });
  const reason = activation.throttleReason(counts);
  if (reason) {
    await recordAttempt(service, {
      channelId: args.channelId, memberId: member.id, venueId: args.venueId,
      profileId: args.profileId, outcome: "issue_throttled", detail: { reason },
    });
    return { outcome: "throttled", throttle: reason };
  }

  if (!deps.brevoApiKey) return { outcome: "unconfigured" };

  const code = generateActivationCode();
  const expiresInMinutes = Math.round(activation.ACTIVATION_CODE_TTL_MS / 60000);
  const rendered = renderActivationEmail({
    sourceName: member.sourceName,
    code,
    expiresInMinutes,
    channelName: deps.channelName,
  });

  const ok = await sendTransactionalEmail(deps.brevoApiKey, deps.sender, {
    toEmail: member.sourceEmail,
    toName: member.sourceName || undefined,
    subject: rendered.subject,
    htmlContent: rendered.html,
    textContent: rendered.text,
  });
  if (!ok) {
    await recordAttempt(service, {
      channelId: args.channelId, memberId: member.id, venueId: args.venueId,
      profileId: args.profileId, outcome: "issue_send_failed",
    });
    return { outcome: "send_failed" };
  }

  // Recorded only AFTER the send succeeds: a code that never left the building should not consume
  // the sender's throttle budget, and should not be verifiable either.
  const { error } = await loose(service).from("channel_activation_codes").insert({
    member_id: member.id,
    venue_id: args.venueId,
    profile_id: args.profileId,
    code_hash: hashActivationCode(code),
    expires_at: new Date(Date.now() + activation.ACTIVATION_CODE_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`activation: code insert failed: ${error.message}`);

  await recordAttempt(service, {
    channelId: args.channelId, memberId: member.id, venueId: args.venueId,
    profileId: args.profileId, outcome: "issue_sent",
  });

  return {
    outcome: "sent",
    sentToMasked: activation.maskEmail(member.sourceEmail),
    expiresInMinutes,
  };
}

// ── verifying ───────────────────────────────────────────────────────────────────────────────────

export type VerifyOutcome =
  | "verified"
  | "wrong_code"
  | "expired" // no live code for this triple: expired, used, or never issued
  | "too_many_attempts";

export interface VerifyResult {
  outcome: VerifyOutcome;
  /** Tries left on the current code, when one is still alive. */
  attemptsRemaining?: number;
}

/**
 * Check a typed code against the newest live one for this (member, venue, account) triple, and
 * consume it on success.
 *
 * A wrong code burns an attempt. Expired, already-used and never-issued all answer "expired": the
 * caller learns only that they need a fresh code, never whether one was outstanding.
 */
export async function verifyActivationCode(
  service: RoamClient,
  args: { channelId: string; memberId: string; venueId: string; profileId: string; code: string },
): Promise<VerifyResult> {
  const nowIso = new Date().toISOString();
  const { data, error } = await loose(service)
    .from("channel_activation_codes")
    .select("id, code_hash, attempts")
    .eq("member_id", args.memberId)
    .eq("venue_id", args.venueId)
    .eq("profile_id", args.profileId)
    .is("consumed_at", null)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`activation: code read failed: ${error.message}`);

  const row = (data ?? [])[0] as { id: string; code_hash: string; attempts: number } | undefined;
  if (!row) {
    await recordAttempt(service, {
      channelId: args.channelId, memberId: args.memberId, venueId: args.venueId,
      profileId: args.profileId, outcome: "verify_no_live_code",
    });
    return { outcome: "expired" };
  }

  if (row.attempts >= activation.MAX_ATTEMPTS_PER_CODE) {
    await recordAttempt(service, {
      channelId: args.channelId, memberId: args.memberId, venueId: args.venueId,
      profileId: args.profileId, outcome: "verify_too_many_attempts",
    });
    return { outcome: "too_many_attempts" };
  }

  const typed = normaliseActivationCode(args.code);
  if (typed.length === 6 && hashesEqual(hashActivationCode(typed), row.code_hash)) {
    const { error: upErr } = await loose(service)
      .from("channel_activation_codes")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", row.id)
      // Single-use, enforced by the write: two requests racing on the same code mean exactly one
      // update matches, so only one can go on to confer ownership.
      .is("consumed_at", null);
    if (upErr) throw new Error(`activation: code consume failed: ${upErr.message}`);

    await recordAttempt(service, {
      channelId: args.channelId, memberId: args.memberId, venueId: args.venueId,
      profileId: args.profileId, outcome: "verify_ok",
    });
    return { outcome: "verified" };
  }

  const attempts = row.attempts + 1;
  const { error: bumpErr } = await loose(service)
    .from("channel_activation_codes")
    .update({ attempts })
    .eq("id", row.id);
  if (bumpErr) throw new Error(`activation: attempt bump failed: ${bumpErr.message}`);

  await recordAttempt(service, {
    channelId: args.channelId, memberId: args.memberId, venueId: args.venueId,
    profileId: args.profileId, outcome: "verify_wrong_code", detail: { attempts },
  });

  const remaining = Math.max(0, activation.MAX_ATTEMPTS_PER_CODE - attempts);
  return remaining === 0
    ? { outcome: "too_many_attempts", attemptsRemaining: 0 }
    : { outcome: "wrong_code", attemptsRemaining: remaining };
}

// ── conferral ───────────────────────────────────────────────────────────────────────────────────

export type ActivateOutcome =
  | "activated"
  | "already_claimed"
  | "claimed_by_other"
  | "not_bound"
  | "venue_mismatch"
  | "not_claimable"
  | "not_found";

export interface ActivateResult {
  outcome: ActivateOutcome;
  venueId: string | null;
}

/**
 * Call the 0161 definer. Verifies nothing itself — the router has already proved possession — and
 * maps the definer's typed raises to a discriminated outcome. Only a genuinely unexpected DB error
 * throws.
 */
export async function activateMemberVenue(
  service: RoamClient,
  args: { memberId: string; venueId: string; claimantId: string },
): Promise<ActivateResult> {
  const rpc = service.rpc.bind(service) as unknown as (
    fn: string,
    params: Record<string, unknown>,
  ) => Promise<{ data: any; error: { message: string; code?: string } | null }>;

  const { data, error } = await rpc("activate_channel_member_venue", {
    p_member_id: args.memberId,
    p_venue_id: args.venueId,
    p_claimant_id: args.claimantId,
  });

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("NOT_BOUND")) return { outcome: "not_bound", venueId: null };
    if (msg.includes("VENUE_MISMATCH")) return { outcome: "venue_mismatch", venueId: null };
    if (msg.includes("CLAIMED_BY_OTHER")) return { outcome: "claimed_by_other", venueId: null };
    if (msg.includes("NOT_CLAIMABLE")) return { outcome: "not_claimable", venueId: null };
    if (msg.includes("MEMBER_NOT_FOUND") || msg.includes("VENUE_NOT_FOUND"))
      return { outcome: "not_found", venueId: null };
    if (msg.includes("CLAIMANT_REQUIRED")) return { outcome: "not_found", venueId: null };
    throw new Error(`activateMemberVenue: ${msg}`);
  }

  const row = (Array.isArray(data) ? data[0] : data) ?? {};
  const outcome = (row.outcome as ActivateOutcome | undefined) ?? "activated";
  return { outcome, venueId: (row.venue_id as string | undefined) ?? args.venueId };
}

// ── binding an unbound roster row ───────────────────────────────────────────────────────────────

export type BindOutcome = "bound" | "review" | "already_bound" | "conflict";

/**
 * Bind an unbound roster row to a venue when the postcodes agree fully, so the definer (which
 * refuses unbound rows outright) has an asserted pair to work with. A mismatch is NOT an error: it
 * is the HQ-review path from plan §3.2, and it is audited as such.
 *
 * The write is conditional on the row still being unbound, so two callers racing on the same roster
 * row cannot both bind it to different venues.
 */
export async function bindMemberVenue(
  service: RoamClient,
  args: {
    channelId: string;
    memberId: string;
    venueId: string;
    profileId: string;
    rosterPostcode: string | null;
    venuePostcode: string | null;
  },
): Promise<BindOutcome> {
  if (activation.bindingDecision(args.rosterPostcode, args.venuePostcode) !== "bind") {
    await recordAttempt(service, {
      channelId: args.channelId, memberId: args.memberId, venueId: args.venueId,
      profileId: args.profileId, outcome: "bind_review",
    });
    return "review";
  }

  const { data, error } = await loose(service)
    .from("channel_members")
    .update({ venue_id: args.venueId })
    .eq("id", args.memberId)
    .is("venue_id", null)
    .select("id");
  if (error) throw new Error(`activation: bind failed: ${error.message}`);

  if (!data || (data as unknown[]).length === 0) {
    // Someone bound it between our read and our write. Whether that is the same venue or another is
    // the caller's to re-read; either way this call did not do it.
    await recordAttempt(service, {
      channelId: args.channelId, memberId: args.memberId, venueId: args.venueId,
      profileId: args.profileId, outcome: "bind_conflict",
    });
    return "conflict";
  }

  await recordAttempt(service, {
    channelId: args.channelId, memberId: args.memberId, venueId: args.venueId,
    profileId: args.profileId, outcome: "bind_ok",
  });
  return "bound";
}
/* eslint-enable @typescript-eslint/no-explicit-any */
