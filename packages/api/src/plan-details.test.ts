import { describe, it, expect } from "vitest";
import { normalisePlanTitle, normalisePlanNotes, normalisePlannedFor, PLAN_TITLE_MAX, PLAN_NOTES_MAX } from "./plan-details.js";

describe("normalisePlanTitle", () => {
  it("trims and collapses whitespace", () => {
    expect(normalisePlanTitle("  Friday   night  out ")).toBe("Friday night out");
  });
  it("rejects empty", () => {
    expect(() => normalisePlanTitle("   ")).toThrow();
  });
  it("rejects over-long", () => {
    expect(() => normalisePlanTitle("x".repeat(PLAN_TITLE_MAX + 1))).toThrow();
  });
});

describe("normalisePlanNotes", () => {
  it("trims; empty/null → null", () => {
    expect(normalisePlanNotes("  meet at 7  ")).toBe("meet at 7");
    expect(normalisePlanNotes("   ")).toBeNull();
    expect(normalisePlanNotes(null)).toBeNull();
  });
  it("rejects over-long", () => {
    expect(() => normalisePlanNotes("x".repeat(PLAN_NOTES_MAX + 1))).toThrow();
  });
});

describe("normalisePlannedFor", () => {
  it("passes a valid ISO string through; empty/null → null", () => {
    expect(normalisePlannedFor("2026-07-01T19:00:00.000Z")).toBe("2026-07-01T19:00:00.000Z");
    expect(normalisePlannedFor(null)).toBeNull();
    expect(normalisePlannedFor("")).toBeNull();
  });
  it("throws on an unparseable date", () => {
    expect(() => normalisePlannedFor("not a date")).toThrow();
  });
});
