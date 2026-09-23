import { describe, it, expect } from "vitest";
import { sealSecret, openSecret, loadSecretKey, canSealSecrets } from "./secretBox.js";

const KEY = Buffer.alloc(32, 7);

describe("secretBox", () => {
  it("round-trips a secret", () => {
    const sealed = sealSecret("a-partners-refresh-token", KEY);
    expect(openSecret(sealed, KEY)).toBe("a-partners-refresh-token");
  });

  it("never emits the plaintext in the sealed value", () => {
    const sealed = sealSecret("super-secret-token", KEY);
    expect(sealed).not.toContain("super-secret-token");
    expect(sealed.startsWith("v1.")).toBe(true); // versioned, so the scheme can change later
  });

  it("produces a different ciphertext each time, so equal tokens are not recognisable", () => {
    expect(sealSecret("same", KEY)).not.toBe(sealSecret("same", KEY));
  });

  it("refuses to decrypt with the wrong key", () => {
    const sealed = sealSecret("token", KEY);
    expect(() => openSecret(sealed, Buffer.alloc(32, 9))).toThrow();
  });

  it("refuses a TAMPERED value rather than returning something plausible", () => {
    // GCM authenticates the ciphertext: flipping a byte must fail loudly, not decrypt to garbage.
    const sealed = sealSecret("token", KEY);
    const parts = sealed.split(".");
    const flipped = Buffer.from(parts[3]!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    flipped[0] = flipped[0]! ^ 0xff;
    parts[3] = flipped.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => openSecret(parts.join("."), KEY)).toThrow();
  });

  it("rejects an unknown version and a malformed shape", () => {
    expect(() => openSecret("v2.a.b.c", KEY)).toThrow(/unsupported version/);
    expect(() => openSecret("not-sealed", KEY)).toThrow(/malformed/);
  });

  it("FAILS CLOSED with no key — a credential is never stored in plaintext", () => {
    // The dangerous "helpful" behaviour would be to return the plaintext when unconfigured. One
    // missing environment variable would then silently become a credential leak.
    expect(() => sealSecret("token", null)).toThrow(/INTEGRATION_ENCRYPTION_KEY/);
    expect(() => openSecret("v1.a.b.c", null)).toThrow(/INTEGRATION_ENCRYPTION_KEY/);
  });

  it("refuses a key that is not 32 bytes rather than silently weakening the cipher", () => {
    expect(() => loadSecretKey(Buffer.alloc(16, 1).toString("base64"))).toThrow(/32 bytes/);
    expect(loadSecretKey(undefined)).toBeNull();
    expect(loadSecretKey("   ")).toBeNull();
  });

  it("accepts a key as base64 or hex", () => {
    expect(loadSecretKey(KEY.toString("base64"))).toEqual(KEY);
    expect(loadSecretKey(KEY.toString("hex"))).toEqual(KEY);
  });

  it("canSealSecrets reports false for an unset or malformed key", () => {
    const original = process.env.INTEGRATION_ENCRYPTION_KEY;
    try {
      delete process.env.INTEGRATION_ENCRYPTION_KEY;
      expect(canSealSecrets()).toBe(false);
      process.env.INTEGRATION_ENCRYPTION_KEY = "too-short";
      expect(canSealSecrets()).toBe(false);
      process.env.INTEGRATION_ENCRYPTION_KEY = KEY.toString("base64");
      expect(canSealSecrets()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
      else process.env.INTEGRATION_ENCRYPTION_KEY = original;
    }
  });
});
