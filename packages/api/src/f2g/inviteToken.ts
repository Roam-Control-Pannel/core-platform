/**
 * F2G invite tokens — the stateless capability that carries a roster member's claim invite.
 *
 * B3-d's onboarding funnel emails each Association roster member a signed link; clicking it (as a
 * signed-in user) confers ownership of the matched venue via `claim_channel_member_venue` (0139).
 * The token is that capability: it names the (member, venue) pair the invite is for and a signed
 * expiry, so the claim endpoint needs no token table — it verifies the signature and reads the
 * payload. This mirrors ownerDigest/token.ts (the proven HMAC capability pattern), extended to a
 * three-field payload with an expiry.
 *
 * Shape: `<memberId>.<venueId>.<expTs>.<hmac>` where
 *   hmac = base64url(HMAC-SHA256(`<memberId>.<venueId>.<expTs>`, secret)).
 * memberId/venueId are UUIDs (no dots) and expTs is an integer (epoch ms), so the four fields split
 * unambiguously on ".". The signature is verified in CONSTANT TIME.
 *
 * Security model (see docs/f2g-b3-onboarding-plan.md §5.1):
 *   * capability-link — whoever holds a valid, unexpired link and signs in becomes the owner; the
 *     link is emailed only to the member's source_email, and the claiming user is recorded;
 *   * SINGLE-USE is enforced by STATE in the definer (a member is claimable only while imported/
 *     invited), not by this token — the token is deliberately stateless;
 *   * EXPIRY is signed INTO the token and re-checked on verify — a captured link dies on its own;
 *   * a null/empty secret always rejects (feature effectively off), so the API is safe before
 *     F2G_INVITE_SECRET is provisioned.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Default invite lifetime — 14 days (decision #2). Resending issues a fresh expiry. */
export const DEFAULT_INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface InvitePayload {
  memberId: string;
  venueId: string;
  /** Expiry as epoch milliseconds. */
  expTs: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

/** Build the signed invite token for a (member, venue) pair with an absolute expiry. */
export function signInviteToken(
  memberId: string,
  venueId: string,
  expTs: number,
  secret: string,
): string {
  const body = `${memberId}.${venueId}.${expTs}`;
  return `${body}.${sign(body, secret)}`;
}

/**
 * Issue a token that expires `ttlMs` from now. Returns the token and the absolute expiry (epoch ms)
 * so the caller can stamp/record it. Convenience over signInviteToken for the send path.
 */
export function issueInviteToken(
  memberId: string,
  venueId: string,
  secret: string,
  ttlMs: number = DEFAULT_INVITE_TTL_MS,
  now: number = Date.now(),
): { token: string; expTs: number } {
  const expTs = now + ttlMs;
  return { token: signInviteToken(memberId, venueId, expTs, secret), expTs };
}

/**
 * Verify a token and return its payload, or null if malformed, wrongly-signed, or expired.
 * Constant-time signature compare. A null/empty secret always rejects. `now` is injectable for tests.
 */
export function verifyInviteToken(
  token: string,
  secret: string | null,
  now: number = Date.now(),
): InvitePayload | null {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [memberId, venueId, expRaw, provided] = parts as [string, string, string, string];
  if (!memberId || !venueId || !expRaw || !provided) return null;

  // Verify the signature FIRST (constant time), so an attacker learns nothing about validity from
  // an expiry check running before an authenticity check.
  const body = `${memberId}.${venueId}.${expRaw}`;
  const expected = sign(body, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — guard first so a wrong-length sig just rejects.
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  // Signature is authentic — now enforce the signed expiry. expTs must be a positive integer.
  const expTs = Number(expRaw);
  if (!Number.isSafeInteger(expTs) || expTs <= 0) return null;
  if (expTs < now) return null;

  return { memberId, venueId, expTs };
}
