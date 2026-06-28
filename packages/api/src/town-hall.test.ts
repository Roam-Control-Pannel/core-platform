import { describe, it, expect } from "vitest";
import {
  localitySlug,
  localityLabel,
  normaliseTopicTitle,
  normaliseTopicBody,
  normaliseReplyBody,
  TOPIC_TITLE_MAX,
  TOPIC_BODY_MAX,
} from "./town-hall.js";

describe("localitySlug", () => {
  it("slugs a plain town name", () => {
    expect(localitySlug("Darlington")).toBe("darlington");
  });

  it("converges differently-cased / spaced names onto one key", () => {
    expect(localitySlug("Darlington")).toBe(localitySlug("  darlington "));
    expect(localitySlug("Stockton-on-Tees")).toBe("stockton-on-tees");
    expect(localitySlug("Stockton on Tees")).toBe("stockton-on-tees");
  });

  it("handles postcodes and strips punctuation", () => {
    expect(localitySlug("DH1 1AA")).toBe("dh1-1aa");
    expect(localitySlug("St. Albans")).toBe("st-albans");
  });

  it("strips diacritics so accented forms share a board", () => {
    expect(localitySlug("Málaga")).toBe("malaga");
  });

  it("throws when nothing usable remains", () => {
    expect(() => localitySlug("   ")).toThrow();
    expect(() => localitySlug("!!!")).toThrow();
  });
});

describe("localityLabel", () => {
  it("trims and single-spaces", () => {
    expect(localityLabel("  Stockton   on  Tees ")).toBe("Stockton on Tees");
  });
  it("throws on empty", () => {
    expect(() => localityLabel("   ")).toThrow();
  });
});

describe("normaliseTopicTitle", () => {
  it("trims and collapses whitespace", () => {
    expect(normaliseTopicTitle("  Best   coffee  near the market ")).toBe("Best coffee near the market");
  });
  it("rejects empty", () => {
    expect(() => normaliseTopicTitle("   ")).toThrow();
  });
  it("rejects over-long titles", () => {
    expect(() => normaliseTopicTitle("x".repeat(TOPIC_TITLE_MAX + 1))).toThrow();
  });
  it("accepts a title at the limit", () => {
    expect(normaliseTopicTitle("x".repeat(TOPIC_TITLE_MAX))).toHaveLength(TOPIC_TITLE_MAX);
  });
});

describe("normaliseTopicBody", () => {
  it("trims outer whitespace but keeps inner newlines", () => {
    expect(normaliseTopicBody("  line one\nline two  ")).toBe("line one\nline two");
  });
  it("rejects empty", () => {
    expect(() => normaliseTopicBody("\n  \n")).toThrow();
  });
  it("rejects over-long bodies", () => {
    expect(() => normaliseTopicBody("x".repeat(TOPIC_BODY_MAX + 1))).toThrow();
  });
});

describe("normaliseReplyBody", () => {
  it("trims", () => {
    expect(normaliseReplyBody("  agreed!  ")).toBe("agreed!");
  });
  it("rejects empty", () => {
    expect(() => normaliseReplyBody("   ")).toThrow();
  });
});
