import { describe, it, expect } from "vitest";
import { signOwnerToken, verifyOwnerToken } from "./token.js";

const SECRET = "test-unsubscribe-secret";
const OWNER = "11111111-2222-3333-4444-555555555555";

describe("owner-digest unsubscribe token", () => {
  it("round-trips: a signed token verifies back to the owner id", () => {
    const token = signOwnerToken(OWNER, SECRET);
    expect(verifyOwnerToken(token, SECRET)).toBe(OWNER);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signOwnerToken(OWNER, SECRET);
    expect(verifyOwnerToken(token, "other-secret")).toBeNull();
  });

  it("rejects a tampered owner id (signature no longer matches)", () => {
    const token = signOwnerToken(OWNER, SECRET);
    const tampered = token.replace(OWNER, "99999999-2222-3333-4444-555555555555");
    expect(verifyOwnerToken(tampered, SECRET)).toBeNull();
  });

  it("rejects malformed tokens and a null secret", () => {
    expect(verifyOwnerToken("no-dot-here", SECRET)).toBeNull();
    expect(verifyOwnerToken(".", SECRET)).toBeNull();
    expect(verifyOwnerToken(signOwnerToken(OWNER, SECRET), null)).toBeNull();
  });
});
