import { describe, it, expect } from "vitest";
import {
  normaliseVenueDescription,
  normaliseVenueLinks,
  isAllowedLinkUrl,
  VENUE_DETAILS_LIMITS,
} from "./venue-details.js";

/**
 * Unit tests for the PURE venue-details validators (Slice 7). No network, no tRPC —
 * runs in CI. These pin the WRITE contract the updateVenueDetails mutation depends on:
 * the cleared-to-null behaviour, the flat string-map shape the reader expects, the
 * http(s) scheme allow-list, the length/count caps, and order preservation.
 */

describe("normaliseVenueDescription", () => {
  it("returns null for null/undefined", () => {
    expect(normaliseVenueDescription(null)).toBeNull();
    expect(normaliseVenueDescription(undefined)).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(normaliseVenueDescription("  hello  ")).toBe("hello");
  });

  it("treats a whitespace-only string as cleared (null)", () => {
    expect(normaliseVenueDescription("   ")).toBeNull();
    expect(normaliseVenueDescription("")).toBeNull();
  });

  it("accepts a description at the max length", () => {
    const atMax = "x".repeat(VENUE_DETAILS_LIMITS.descriptionMax);
    expect(normaliseVenueDescription(atMax)).toBe(atMax);
  });

  it("throws over the max length", () => {
    const tooLong = "x".repeat(VENUE_DETAILS_LIMITS.descriptionMax + 1);
    expect(() => normaliseVenueDescription(tooLong)).toThrow(RangeError);
  });
});

describe("isAllowedLinkUrl", () => {
  it("allows http and https", () => {
    expect(isAllowedLinkUrl("http://example.com")).toBe(true);
    expect(isAllowedLinkUrl("https://example.com/menu")).toBe(true);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isAllowedLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedLinkUrl("data:text/html,x")).toBe(false);
    expect(isAllowedLinkUrl("mailto:a@b.com")).toBe(false);
    expect(isAllowedLinkUrl("ftp://example.com")).toBe(false);
  });

  it("rejects unparseable strings", () => {
    expect(isAllowedLinkUrl("not a url")).toBe(false);
    expect(isAllowedLinkUrl("")).toBe(false);
  });
});

describe("normaliseVenueLinks", () => {
  it("returns null for null/undefined/non-object", () => {
    expect(normaliseVenueLinks(null)).toBeNull();
    expect(normaliseVenueLinks(undefined)).toBeNull();
  });

  it("produces a flat string map the reader expects", () => {
    expect(
      normaliseVenueLinks({ Menu: "https://x.com/menu", Book: "https://x.com/book" }),
    ).toEqual({ Menu: "https://x.com/menu", Book: "https://x.com/book" });
  });

  it("trims labels and urls", () => {
    expect(normaliseVenueLinks({ "  Menu  ": "  https://x.com/menu  " })).toEqual({
      Menu: "https://x.com/menu",
    });
  });

  it("drops entries with empty label or url (clearing = omitting)", () => {
    expect(
      normaliseVenueLinks({ Menu: "https://x.com", "": "https://y.com", Book: "  " }),
    ).toEqual({ Menu: "https://x.com" });
  });

  it("returns null when nothing survives", () => {
    expect(normaliseVenueLinks({ "": "", Book: "   " })).toBeNull();
    expect(normaliseVenueLinks({})).toBeNull();
  });

  it("drops non-string values", () => {
    expect(
      normaliseVenueLinks({ Menu: "https://x.com", Bad: 42, Worse: null } as Record<
        string,
        unknown
      >),
    ).toEqual({ Menu: "https://x.com" });
  });

  it("preserves insertion order", () => {
    const out = normaliseVenueLinks({
      First: "https://x.com/1",
      Second: "https://x.com/2",
      Third: "https://x.com/3",
    });
    expect(Object.keys(out ?? {})).toEqual(["First", "Second", "Third"]);
  });

  it("rejects a non-http(s) url", () => {
    expect(() => normaliseVenueLinks({ Evil: "javascript:alert(1)" })).toThrow(RangeError);
  });

  it("rejects an over-long label", () => {
    const longLabel = "L".repeat(VENUE_DETAILS_LIMITS.linkLabelMax + 1);
    expect(() => normaliseVenueLinks({ [longLabel]: "https://x.com" })).toThrow(RangeError);
  });

  it("rejects an over-long url", () => {
    const longUrl = "https://x.com/" + "a".repeat(VENUE_DETAILS_LIMITS.linkUrlMax);
    expect(() => normaliseVenueLinks({ Menu: longUrl })).toThrow(RangeError);
  });

  it("accepts exactly maxLinks", () => {
    const map: Record<string, string> = {};
    for (let i = 0; i < VENUE_DETAILS_LIMITS.maxLinks; i++) map[`L${i}`] = `https://x.com/${i}`;
    expect(Object.keys(normaliseVenueLinks(map) ?? {})).toHaveLength(
      VENUE_DETAILS_LIMITS.maxLinks,
    );
  });

  it("rejects more than maxLinks", () => {
    const map: Record<string, string> = {};
    for (let i = 0; i <= VENUE_DETAILS_LIMITS.maxLinks; i++) map[`L${i}`] = `https://x.com/${i}`;
    expect(() => normaliseVenueLinks(map)).toThrow(RangeError);
  });
});
