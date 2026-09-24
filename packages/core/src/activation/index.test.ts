import { describe, it, expect } from "vitest";
import {
  emailMatchesRoster,
  maskEmail,
  bindingDecision,
  throttleReason,
  MAX_CODES_PER_ACCOUNT_PER_HOUR,
  MAX_CODES_PER_ACCOUNT_PER_DAY,
  MAX_CODES_PER_MEMBER_PER_HOUR,
} from "./index.js";

describe("emailMatchesRoster", () => {
  it("matches ignoring case and surrounding space", () => {
    expect(emailMatchesRoster("  Info@Cafe.co.uk ", "info@cafe.co.uk")).toBe(true);
  });

  it("refuses when either side is missing — absence is not a match", () => {
    expect(emailMatchesRoster(null, "info@cafe.co.uk")).toBe(false);
    expect(emailMatchesRoster("info@cafe.co.uk", null)).toBe(false);
    expect(emailMatchesRoster("", "")).toBe(false);
  });

  it("does NOT apply gmail dot/plus aliasing", () => {
    // Treating these as equal would let an address match a roster row it was never given.
    expect(emailMatchesRoster("a.b@gmail.com", "ab@gmail.com")).toBe(false);
    expect(emailMatchesRoster("ab+roam@gmail.com", "ab@gmail.com")).toBe(false);
  });
});

describe("maskEmail", () => {
  it("reveals only the first character of the local part and of the domain label", () => {
    expect(maskEmail("info@belfastcafe.co.uk")).toBe("i•••@b•••.co.uk");
  });

  it("blots a fixed width, so the length of neither part leaks", () => {
    // Two addresses of very different lengths mask to exactly the same shape.
    expect(maskEmail("a@b.com")).toBe("a•••@b•••.com");
    expect(maskEmail("abcdefghij@bcdefghijk.com")).toBe("a•••@b•••.com");
  });

  it("never returns anything recognisable for junk input", () => {
    expect(maskEmail(null)).toBe("•••");
    expect(maskEmail("not-an-email")).toBe("•••");
    expect(maskEmail("trailing@")).toBe("•••");
    expect(maskEmail("@leading.com")).toBe("•••");
  });

  it("refuses to partially reveal a dotless domain", () => {
    expect(maskEmail("root@localhost")).toBe("r•••@•••");
  });
});

describe("bindingDecision", () => {
  it("binds only on FULL postcode agreement", () => {
    expect(bindingDecision("BT1 5GS", "bt15gs")).toBe("bind");
  });

  it("sends an outward-only agreement to review — the chain's-other-branch case", () => {
    // A perfect name in the same outward code is exactly how you link the wrong branch.
    expect(bindingDecision("BT1 5GS", "BT1 6AA")).toBe("review");
  });

  it("sends a disagreement to review", () => {
    expect(bindingDecision("BT1 5GS", "BT9 7AA")).toBe("review");
  });

  it("sends a MISSING postcode to review — absence of a conflict is not agreement", () => {
    expect(bindingDecision(null, "BT1 5GS")).toBe("review");
    expect(bindingDecision("BT1 5GS", null)).toBe("review");
    expect(bindingDecision(null, null)).toBe("review");
    expect(bindingDecision("", "")).toBe("review");
  });
});

describe("throttleReason", () => {
  const clear = { accountLastHour: 0, accountLastDay: 0, memberLastHour: 0 };

  it("passes an unthrottled account", () => {
    expect(throttleReason(clear)).toBeNull();
  });

  it("stops at the account's hourly ceiling", () => {
    expect(throttleReason({ ...clear, accountLastHour: MAX_CODES_PER_ACCOUNT_PER_HOUR })).toBe(
      "account_hourly",
    );
  });

  it("stops at the account's daily ceiling even when the hour is quiet", () => {
    expect(throttleReason({ ...clear, accountLastDay: MAX_CODES_PER_ACCOUNT_PER_DAY })).toBe(
      "account_daily",
    );
  });

  it("shields the member's inbox from several accounts each staying under their own limit", () => {
    expect(
      throttleReason({
        accountLastHour: MAX_CODES_PER_ACCOUNT_PER_HOUR - 1,
        accountLastDay: 1,
        memberLastHour: MAX_CODES_PER_MEMBER_PER_HOUR,
      }),
    ).toBe("member_hourly");
  });

  it("reports the account's own limit first, which is the one the asker can act on", () => {
    expect(
      throttleReason({
        accountLastHour: MAX_CODES_PER_ACCOUNT_PER_HOUR,
        accountLastDay: MAX_CODES_PER_ACCOUNT_PER_DAY,
        memberLastHour: MAX_CODES_PER_MEMBER_PER_HOUR,
      }),
    ).toBe("account_hourly");
  });
});
