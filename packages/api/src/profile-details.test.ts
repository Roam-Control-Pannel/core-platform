import { describe, it, expect } from "vitest";
import {
  normaliseDisplayName,
  normaliseHandle,
  normaliseBio,
  normaliseImageUrl,
  normaliseProfileLinks,
  PROFILE_LIMITS,
} from "./profile-details.js";

describe("normaliseDisplayName / normaliseBio", () => {
  it("trims and nulls empty", () => {
    expect(normaliseDisplayName("  Andrew  ")).toBe("Andrew");
    expect(normaliseDisplayName("   ")).toBeNull();
    expect(normaliseDisplayName(null)).toBeNull();
    expect(normaliseBio("  Local explorer.  ")).toBe("Local explorer.");
    expect(normaliseBio("")).toBeNull();
  });
  it("throws over the cap", () => {
    expect(() => normaliseDisplayName("x".repeat(PROFILE_LIMITS.displayNameMax + 1))).toThrow(/exceeds/);
    expect(() => normaliseBio("x".repeat(PROFILE_LIMITS.bioMax + 1))).toThrow(/exceeds/);
  });
});

describe("normaliseHandle", () => {
  it("strips a leading @, lowercases, trims", () => {
    expect(normaliseHandle("  @Andrew_R ")).toBe("andrew_r");
    expect(normaliseHandle("yarm_local")).toBe("yarm_local");
  });
  it("nulls empty / just-@", () => {
    expect(normaliseHandle("")).toBeNull();
    expect(normaliseHandle("@")).toBeNull();
    expect(normaliseHandle(null)).toBeNull();
  });
  it("rejects bad length", () => {
    expect(() => normaliseHandle("ab")).toThrow(/characters/);
    expect(() => normaliseHandle("a".repeat(PROFILE_LIMITS.handleMax + 1))).toThrow(/characters/);
  });
  it("rejects illegal characters", () => {
    expect(() => normaliseHandle("hi there")).toThrow(/letters, numbers/);
    expect(() => normaliseHandle("with-dash")).toThrow(/letters, numbers/);
    expect(() => normaliseHandle("emoji😀x")).toThrow(/letters, numbers/);
  });
});

describe("normaliseImageUrl", () => {
  it("keeps http(s) urls, nulls empty", () => {
    expect(normaliseImageUrl("https://x.test/a.png")).toBe("https://x.test/a.png");
    expect(normaliseImageUrl("  ")).toBeNull();
    expect(normaliseImageUrl(null)).toBeNull();
  });
  it("rejects non-http schemes", () => {
    expect(() => normaliseImageUrl("javascript:alert(1)")).toThrow(/http/);
    expect(() => normaliseImageUrl("data:image/png;base64,xxxx")).toThrow(/http/);
  });
});

describe("normaliseProfileLinks", () => {
  it("keeps a flat label→http(s) map and drops empties", () => {
    expect(
      normaliseProfileLinks({ Instagram: "https://instagram.com/roam", Website: "  ", X: "https://x.com/roam" }),
    ).toEqual({ Instagram: "https://instagram.com/roam", X: "https://x.com/roam" });
  });
  it("rejects a non-http link", () => {
    expect(() => normaliseProfileLinks({ Bad: "ftp://x" })).toThrow(/http/);
  });
  it("returns null when nothing survives", () => {
    expect(normaliseProfileLinks({ a: "", b: "  " })).toBeNull();
    expect(normaliseProfileLinks(null)).toBeNull();
  });
});
