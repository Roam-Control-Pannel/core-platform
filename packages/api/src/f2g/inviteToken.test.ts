import { describe, it, expect } from "vitest";
import {
  signInviteToken,
  issueInviteToken,
  verifyInviteToken,
  DEFAULT_INVITE_TTL_MS,
} from "./inviteToken.js";

const SECRET = "test-f2g-invite-secret";
const MEMBER = "11111111-2222-3333-4444-555555555555";
const VENUE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NOW = 1_700_000_000_000;

describe("f2g invite token", () => {
  it("round-trips: a signed token verifies back to its (member, venue, exp) payload", () => {
    const expTs = NOW + DEFAULT_INVITE_TTL_MS;
    const token = signInviteToken(MEMBER, VENUE, expTs, SECRET);
    expect(verifyInviteToken(token, SECRET, NOW)).toEqual({ memberId: MEMBER, venueId: VENUE, expTs });
  });

  it("issueInviteToken sets an absolute expiry ttlMs from now", () => {
    const { token, expTs } = issueInviteToken(MEMBER, VENUE, SECRET, DEFAULT_INVITE_TTL_MS, NOW);
    expect(expTs).toBe(NOW + DEFAULT_INVITE_TTL_MS);
    expect(verifyInviteToken(token, SECRET, NOW)).toEqual({ memberId: MEMBER, venueId: VENUE, expTs });
  });

  it("rejects a token signed with a different secret (forged signature)", () => {
    const token = signInviteToken(MEMBER, VENUE, NOW + 1000, SECRET);
    expect(verifyInviteToken(token, "other-secret", NOW)).toBeNull();
  });

  it("rejects a tampered venue id (the signature no longer matches)", () => {
    const token = signInviteToken(MEMBER, VENUE, NOW + 1000, SECRET);
    const tampered = token.replace(VENUE, "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(verifyInviteToken(tampered, SECRET, NOW)).toBeNull();
  });

  it("rejects a tampered expiry (extending it breaks the signature)", () => {
    const expTs = NOW + 1000;
    const token = signInviteToken(MEMBER, VENUE, expTs, SECRET);
    const tampered = token.replace(String(expTs), String(NOW + 999_999_999));
    expect(verifyInviteToken(tampered, SECRET, NOW)).toBeNull();
  });

  it("rejects an expired token even when correctly signed", () => {
    const expTs = NOW - 1; // already in the past
    const token = signInviteToken(MEMBER, VENUE, expTs, SECRET);
    expect(verifyInviteToken(token, SECRET, NOW)).toBeNull();
  });

  it("accepts a token right up to its expiry and rejects one millisecond past it", () => {
    const expTs = NOW + 5;
    const token = signInviteToken(MEMBER, VENUE, expTs, SECRET);
    expect(verifyInviteToken(token, SECRET, expTs)).not.toBeNull(); // exp == now is still valid
    expect(verifyInviteToken(token, SECRET, expTs + 1)).toBeNull();
  });

  it("rejects malformed tokens and a null secret", () => {
    expect(verifyInviteToken("no-dots-here", SECRET, NOW)).toBeNull();
    expect(verifyInviteToken(`${MEMBER}.${VENUE}.notanumber.sig`, SECRET, NOW)).toBeNull();
    expect(verifyInviteToken(`${MEMBER}.${VENUE}`, SECRET, NOW)).toBeNull(); // too few fields
    expect(verifyInviteToken(signInviteToken(MEMBER, VENUE, NOW + 1000, SECRET), null, NOW)).toBeNull();
    expect(verifyInviteToken(signInviteToken(MEMBER, VENUE, NOW + 1000, SECRET), "", NOW)).toBeNull();
  });
});
