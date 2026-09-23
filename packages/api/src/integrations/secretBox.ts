/**
 * secretBox — authenticated encryption for partner credentials at rest.
 *
 * A whitelabel partner's OAuth refresh token is a standing key to THEIR system (for HubSpot, their
 * CRM contacts — other people's personal data). It has to be stored, because a nightly sync cannot
 * ask a human to re-authorise. So it is stored encrypted, under a key that lives in the API's
 * environment and NOT in the database: a database dump on its own then yields nothing usable, and an
 * attacker needs both the dump and the API host's environment.
 *
 * AES-256-GCM, so the ciphertext is authenticated — a tampered record fails to decrypt rather than
 * silently decrypting to something else. Format is `v1.<iv>.<tag>.<ciphertext>`, all base64url, with
 * the version first so the scheme can be changed later without guessing at old records.
 *
 * FAILS CLOSED. With no key configured, encryption throws rather than returning plaintext. The
 * alternative — quietly storing an unencrypted token — is the kind of "safe" default that turns one
 * missing environment variable into a credential leak.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Read the encryption key from env. Accepts base64 or hex; must decode to exactly 32 bytes, because
 * a short key silently weakening the cipher is worse than a startup error.
 */
export function loadSecretKey(raw: string | null | undefined = process.env.INTEGRATION_ENCRYPTION_KEY): Buffer | null {
  const v = raw?.trim();
  if (!v) return null;
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(v)) key = Buffer.from(v, "hex");
  else key = fromB64url(v);
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `INTEGRATION_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** Encrypt a secret for storage. Throws when no key is configured — never returns plaintext. */
export function sealSecret(plaintext: string, key: Buffer | null = loadSecretKey()): string {
  if (!key) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY is not set, so a partner credential cannot be stored safely. " +
        "Refusing to write it in plaintext.",
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${b64url(iv)}.${b64url(tag)}.${b64url(ciphertext)}`;
}

/**
 * Decrypt a stored secret. Throws on a missing key, an unknown version, or a failed authentication
 * tag — all of which mean "this value cannot be trusted", not "try your best".
 */
export function openSecret(sealed: string, key: Buffer | null = loadSecretKey()): string {
  if (!key) throw new Error("INTEGRATION_ENCRYPTION_KEY is not set; a stored credential cannot be read.");
  const parts = sealed.split(".");
  if (parts.length !== 4) throw new Error("secretBox: malformed sealed value");
  const [version, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  // Constant-time compare on the version label keeps the shape of the check uniform; the real
  // integrity guarantee is the GCM tag below.
  const vBuf = Buffer.from(version);
  const expected = Buffer.from(VERSION);
  if (vBuf.length !== expected.length || !timingSafeEqual(vBuf, expected)) {
    throw new Error(`secretBox: unsupported version '${version}'`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, fromB64url(ivB64));
  decipher.setAuthTag(fromB64url(tagB64));
  return Buffer.concat([decipher.update(fromB64url(dataB64)), decipher.final()]).toString("utf8");
}

/** Whether a credential can be stored at all — lets a caller report "unconfigured" before trying. */
export function canSealSecrets(): boolean {
  try {
    return loadSecretKey() !== null;
  } catch {
    return false; // a malformed key is not a usable one
  }
}
