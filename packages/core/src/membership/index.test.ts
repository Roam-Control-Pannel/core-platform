import { describe, it, expect } from "vitest";
import {
  MEMBER_STATUSES,
  canTransition,
  isTerminal,
  normaliseMembershipRef,
  normalisePostcode,
  outwardCode,
  type MemberStatus,
} from "./index.js";

/** The authoritative expected edge set, kept independent of the module's internal table so the test
 * is a genuine second opinion rather than a mirror of the implementation. */
const ALLOWED: Record<MemberStatus, MemberStatus[]> = {
  imported: ["invited", "removed"],
  invited: ["invited", "claimed", "lapsed", "removed"],
  claimed: ["live", "removed"],
  live: ["lapsed", "removed"],
  lapsed: ["invited", "live", "removed"],
  removed: [],
};

describe("membership state machine", () => {
  it("accepts exactly the allowed transitions and rejects every other (from × to) pair", () => {
    for (const from of MEMBER_STATUSES) {
      for (const to of MEMBER_STATUSES) {
        const expected = ALLOWED[from].includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("allows invited -> invited (resend) but no other self-loop", () => {
    expect(canTransition("invited", "invited")).toBe(true);
    for (const s of MEMBER_STATUSES) {
      if (s !== "invited") expect(canTransition(s, s), `${s} -> ${s}`).toBe(false);
    }
  });

  it("treats removed as terminal", () => {
    expect(isTerminal("removed")).toBe(true);
    for (const to of MEMBER_STATUSES) expect(canTransition("removed", to)).toBe(false);
    for (const s of MEMBER_STATUSES) {
      if (s !== "removed") expect(isTerminal(s)).toBe(false);
    }
  });
});

describe("normaliseMembershipRef", () => {
  it("trims, collapses internal whitespace, uppercases", () => {
    expect(normaliseMembershipRef("  assoc-0042 ")).toBe("ASSOC-0042");
    expect(normaliseMembershipRef("ref  a\tb")).toBe("REF A B");
    expect(normaliseMembershipRef("MixedCase")).toBe("MIXEDCASE");
  });

  it("returns '' for empty/blank/nullish input", () => {
    expect(normaliseMembershipRef("")).toBe("");
    expect(normaliseMembershipRef("   ")).toBe("");
    expect(normaliseMembershipRef(null)).toBe("");
    expect(normaliseMembershipRef(undefined)).toBe("");
  });

  it("is idempotent (re-import stability)", () => {
    const once = normaliseMembershipRef(" Assoc 0042 ");
    expect(normaliseMembershipRef(once)).toBe(once);
  });
});

describe("normalisePostcode", () => {
  it("canonicalises spacing and case with a single outward/inward split", () => {
    expect(normalisePostcode("bt11aa")).toBe("BT1 1AA");
    expect(normalisePostcode(" BT47 6XX ")).toBe("BT47 6XX");
    expect(normalisePostcode("bt1  1aa")).toBe("BT1 1AA");
    expect(normalisePostcode("BT521AB")).toBe("BT52 1AB");
  });

  it("leaves an outward-only code untouched (no inward code to split)", () => {
    expect(normalisePostcode("bt1")).toBe("BT1");
    expect(normalisePostcode("BT47")).toBe("BT47");
  });

  it("returns '' for empty/nullish", () => {
    expect(normalisePostcode("")).toBe("");
    expect(normalisePostcode(null)).toBe("");
    expect(normalisePostcode(undefined)).toBe("");
  });

  it("equal postcodes with different formatting compare equal after normalisation", () => {
    expect(normalisePostcode("bt1 1aa")).toBe(normalisePostcode("BT11AA"));
  });
});

describe("outwardCode", () => {
  it("returns the outward half of a full postcode", () => {
    expect(outwardCode("BT47 6XX")).toBe("BT47");
    expect(outwardCode("bt11aa")).toBe("BT1");
  });

  it("returns the whole code when outward-only, and '' when empty", () => {
    expect(outwardCode("BT47")).toBe("BT47");
    expect(outwardCode("")).toBe("");
    expect(outwardCode(null)).toBe("");
  });
});
