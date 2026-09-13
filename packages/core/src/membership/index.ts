/**
 * @roam/core/membership — the channel-membership roster's PURE domain logic.
 *
 * A `channel_members` row (migration 0135) is the roster of record for a channel's membership — the
 * Food to Go Association's vendors, imported from the Association's own list, matched to a Roam
 * venue, invited to claim, and eventually live. The TABLE lives in the DB and is service-managed;
 * the RULES that govern it live here, once, so the import job (B3), the admin console (B4) and any
 * future surface all move a member through the same states and normalise the same keys identically.
 *
 * This module is deliberately pure — no DB, no transport. The DB-thin wrappers (read a member, write
 * a status change) are added by the slices that need them (B3/B4), keeping this half unit-testable
 * with no fixtures beyond plain values.
 */

/**
 * The onboarding state machine for a roster member:
 *   imported — ingested verbatim from the Association's list; not yet contacted.
 *   invited  — a claim invitation has been sent (B3 issues the HMAC token).
 *   claimed  — the owner accepted the invite and claimed the matched venue.
 *   live     — claimed AND surfacing on the storefront (tagged into the channel).
 *   lapsed   — was live/invited but has since fallen out (membership ended, bounced invite).
 *   removed  — struck from the roster (terminal).
 */
export const MEMBER_STATUSES = [
  "imported",
  "invited",
  "claimed",
  "live",
  "lapsed",
  "removed",
] as const;

export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/**
 * Allowed forward transitions, fail-closed: any (from → to) pair NOT listed here is rejected. This
 * is the single source of truth the DB check constraint (which only constrains the VALUES) cannot
 * express. `removed` is terminal. `invited → invited` is allowed so a re-invite (resend) is legal;
 * `lapsed` can be re-invited or restored straight to live.
 */
const TRANSITIONS: Readonly<Record<MemberStatus, readonly MemberStatus[]>> = {
  imported: ["invited", "removed"],
  invited: ["invited", "claimed", "lapsed", "removed"],
  claimed: ["live", "removed"],
  live: ["lapsed", "removed"],
  lapsed: ["invited", "live", "removed"],
  removed: [],
};

/** True when a member may move from `from` to `to`. A no-op (`from === to`) is only allowed where the
 * table explicitly lists it (today just `invited → invited`, the resend case). */
export function canTransition(from: MemberStatus, to: MemberStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** True when a status can never transition onward (the writer can short-circuit / hide actions). */
export function isTerminal(status: MemberStatus): boolean {
  return (TRANSITIONS[status]?.length ?? 0) === 0;
}

/**
 * Normalise a membership reference to the stable idempotency key stored in
 * `channel_members.membership_ref`. Re-importing the same source row must land on the same key so
 * the unique (channel_id, membership_ref) index updates rather than duplicates: trim, collapse
 * internal whitespace, uppercase. Returns "" for empty/blank input (the importer treats "" as
 * "no stable ref" and must fall back to another key).
 */
export function normaliseMembershipRef(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Normalise a UK/NI postcode to its canonical form: uppercase, no stray whitespace, and a single
 * space separating the outward and inward codes (the inward code is always the last 3 characters).
 * This is the match BLOCK KEY the matcher (B2) groups candidates by, so both the roster side and the
 * venue side must normalise identically.
 *
 *   "bt11aa"   → "BT1 1AA"
 *   " BT47 6XX " → "BT47 6XX"
 *   "bt1"      → "BT1"        (outward-only: no inward code to split off)
 *   ""/null    → ""
 *
 * Tolerant, not validating: it does not reject malformed input (the matcher decides confidence), it
 * only canonicalises spacing/case so equal postcodes compare equal.
 */
export function normalisePostcode(raw: string | null | undefined): string {
  if (!raw) return "";
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  // A full UK/NI postcode is 5–8 chars (2–4 outward + 3 inward); anything shorter is an
  // outward-only code (e.g. "BT47") with no inward part to split off — leave it as-is.
  if (compact.length < 5) return compact;
  const outward = compact.slice(0, compact.length - 3);
  const inward = compact.slice(compact.length - 3);
  return `${outward} ${inward}`;
}

/** The outward code alone (e.g. "BT47" from "BT47 6XX") — a coarser block key when full codes miss. */
export function outwardCode(raw: string | null | undefined): string {
  const norm = normalisePostcode(raw);
  if (!norm) return "";
  const space = norm.indexOf(" ");
  return space === -1 ? norm : norm.slice(0, space);
}

// Roster CSV parsing (B3-a) lives in ./import to keep this file focused; re-exported here so it is
// reachable as @roam/core/membership.parseRosterCsv. (import.ts imports the normalisers above; the
// cycle is safe — they are hoisted function declarations.)
export * from "./import.js";
