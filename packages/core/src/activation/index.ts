/**
 * Activation rules (F2G plan 2.4) — the decisions, with no I/O and no crypto.
 *
 * The API layer owns the code, the mail and the database (packages/api/src/f2g/activation.ts). What
 * lives here is the part worth reasoning about on its own: whether an account's e-mail counts as the
 * roster's, whether an unbound roster row may bind to a venue, and how much of an address a stranger
 * is allowed to see. Each is a security decision, so each is a pure function with its own tests
 * rather than a condition buried in a request handler.
 *
 * WHY THESE LIMITS. Until the Association issues membership numbers in 2027, e-mail possession is
 * the ONLY factor (plan §3.2). There is no second thing to know, so the numbers below are the whole
 * of the brute-force budget: six digits is a million possibilities, five tries burns the code, and
 * the per-account and per-row ceilings bound how many fresh codes an attacker can farm in an hour.
 */
import { postcodeAgreement } from "../matching/index.js";

// ── the brute-force budget ──────────────────────────────────────────────────────────────────────

/** How long a code stays usable. Short: it is typed from an inbox that is already open. */
export const ACTIVATION_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Failed verifications before a code is dead. Five tries against six digits is a 1-in-200,000 shot,
 * and a sixth attempt costs a fresh send — which the ceilings below meter.
 */
export const MAX_ATTEMPTS_PER_CODE = 5;

/** Fresh codes one ACCOUNT may request in an hour, across every roster row it asks about. */
export const MAX_CODES_PER_ACCOUNT_PER_HOUR = 5;

/**
 * Fresh codes that may be sent about one ROSTER ROW in an hour, whoever asks. Separate from the
 * per-account limit on purpose: without it, a handful of accounts could between them turn a member's
 * inbox into a mailbomb while each stayed under its own ceiling.
 */
export const MAX_CODES_PER_MEMBER_PER_HOUR = 5;

/** The daily backstop per account, for the patient attacker who stays under the hourly limit. */
export const MAX_CODES_PER_ACCOUNT_PER_DAY = 20;

// ── e-mail possession ───────────────────────────────────────────────────────────────────────────

/**
 * Whether a signed-in account's own verified e-mail already IS the roster's contact address — the
 * no-code path in plan §3.2. Compared case-insensitively and trimmed, which is how mail providers
 * treat the domain and how every real roster differs from a real sign-up.
 *
 * Deliberately NOT normalised further: gmail's dots-and-plus aliasing is a provider-specific rule,
 * and treating `a.b@gmail.com` as `ab@gmail.com` would let one address match a roster row it was
 * never given. An exact match or a code; there is no third, cleverer option.
 */
export function emailMatchesRoster(
  accountEmail: string | null | undefined,
  rosterEmail: string | null | undefined,
): boolean {
  const a = (accountEmail ?? "").trim().toLowerCase();
  const b = (rosterEmail ?? "").trim().toLowerCase();
  if (!a || !b) return false;
  return a === b;
}

/**
 * How much of the roster's address to show the person activating. They may not be its owner — the
 * whole point of the code is that we do not yet know — so the full address must never appear. This
 * shows enough to recognise an inbox you control ("yes, that's my info@ address") and not enough to
 * learn one you don't.
 *
 * `info@belfastcafe.co.uk` → `i•••@b••••••••••.co.uk`
 */
export function maskEmail(email: string | null | undefined): string {
  const raw = (email ?? "").trim();
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return "•••";
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);

  const dot = domain.indexOf(".");
  // No dot at all is not a domain we can partially reveal without revealing all of it.
  if (dot <= 0) return `${mask(local)}@•••`;
  return `${mask(local)}@${mask(domain.slice(0, dot))}${domain.slice(dot)}`;
}

/** First character, then a fixed-width blot. Fixed-width so the length is not leaked either. */
function mask(s: string): string {
  if (!s) return "•••";
  return `${s[0]}•••`;
}

// ── binding an unbound roster row ───────────────────────────────────────────────────────────────

/**
 * What to do with a roster row that names no venue. Plan §3.2: an unbound row binds only when the
 * roster postcode matches the venue, and otherwise the pair goes to HQ review.
 *
 * FULL agreement is required, never outward-only. The matcher already reasons this out for
 * auto-accept (`matching/index.ts`): a perfect name in the same outward code is exactly the
 * chain's-other-branch case, and with no membership number to fall back on, "you control the e-mail
 * on a roster row bound to venue X" is the ENTIRE proof of identity. So binding is at least as
 * strict as auto-matching, not more lenient — a wrong bind hands a real business's listing to
 * someone who legitimately controls their own inbox.
 *
 * A missing postcode on either side yields "review", never "bind": absence of a conflict is not
 * agreement.
 */
export type BindingDecision = "bind" | "review";

export function bindingDecision(
  rosterPostcode: string | null | undefined,
  venuePostcode: string | null | undefined,
): BindingDecision {
  return postcodeAgreement(rosterPostcode, venuePostcode) === "full" ? "bind" : "review";
}

// ── throttling arithmetic ───────────────────────────────────────────────────────────────────────

export interface ThrottleCounts {
  /** Codes this account has been issued in the last hour. */
  accountLastHour: number;
  /** Codes this account has been issued in the last 24 hours. */
  accountLastDay: number;
  /** Codes issued about this roster row in the last hour, whoever asked. */
  memberLastHour: number;
}

/** Which ceiling stopped a request, or null when none did. */
export type ThrottleReason = "account_hourly" | "account_daily" | "member_hourly" | null;

/**
 * Checked in the order that gives the most honest message: the account's own limits first (which the
 * asker can reason about), the roster row's last (which they cannot, and which is really a shield
 * for the member's inbox rather than a rule about the asker).
 */
export function throttleReason(counts: ThrottleCounts): ThrottleReason {
  if (counts.accountLastHour >= MAX_CODES_PER_ACCOUNT_PER_HOUR) return "account_hourly";
  if (counts.accountLastDay >= MAX_CODES_PER_ACCOUNT_PER_DAY) return "account_daily";
  if (counts.memberLastHour >= MAX_CODES_PER_MEMBER_PER_HOUR) return "member_hourly";
  return null;
}
