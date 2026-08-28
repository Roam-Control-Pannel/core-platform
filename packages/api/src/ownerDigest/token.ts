/**
 * Owner-digest unsubscribe tokens. Every digest email carries a one-click unsubscribe link; the
 * token is a stateless, tamper-proof capability so the unsubscribe endpoint needs no login and no
 * stored token — it just verifies the signature and flips the owner's opt-out flag.
 *
 * Shape: `<ownerId>.<hmac>` where hmac = HMAC-SHA256(ownerId, secret), base64url. The signature is
 * verified in constant time. The token carries only the capability to unsubscribe a known owner id
 * (low sensitivity), never a session — but signing prevents anyone from unsubscribing an owner
 * whose id they happen to know.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(ownerId: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(ownerId).digest());
}

/** Build the unsubscribe token for an owner. */
export function signOwnerToken(ownerId: string, secret: string): string {
  return `${ownerId}.${sign(ownerId, secret)}`;
}

/**
 * Verify a token and return the owner id it authorises, or null if malformed / signature invalid.
 * Constant-time signature compare. A null/empty secret always rejects (feature effectively off).
 */
export function verifyOwnerToken(token: string, secret: string | null): string | null {
  if (!secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const ownerId = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(ownerId, secret);
  // timingSafeEqual throws on length mismatch — guard first so a wrong-length sig just rejects.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? ownerId : null;
}
