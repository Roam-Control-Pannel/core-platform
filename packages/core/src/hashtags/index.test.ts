import { describe, it, expect } from "vitest";
import { extractHashtags, hasHashtag, normalizeTag } from "./index.js";

describe("extractHashtags", () => {
  it("finds tags in running text, lowercased, deduped, in order", () => {
    expect(extractHashtags("Looking for #Newcastle restaurant recommendations #foodie #newcastle")).toEqual([
      "newcastle",
      "foodie",
    ]);
  });

  it("requires a boundary before the # (no mid-word tags)", () => {
    expect(extractHashtags("price#deal is not a tag, (#deal) is")).toEqual(["deal"]);
  });

  it("does not split longer tags at a shorter prefix", () => {
    expect(extractHashtags("#newcastleupon")).toEqual(["newcastleupon"]);
  });

  it("ignores single-character and empty tags, handles null", () => {
    expect(extractHashtags("#a # ##")).toEqual([]);
    expect(extractHashtags(null)).toEqual([]);
    expect(extractHashtags(undefined)).toEqual([]);
  });

  it("supports digits and unicode letters", () => {
    expect(extractHashtags("see you in #2026 at #café_roma")).toEqual(["2026", "café_roma"]);
  });
});

describe("hasHashtag", () => {
  it("matches the exact tag only (word-boundary correct)", () => {
    const text = "Looking for #Newcastle restaurant recommendations.";
    expect(hasHashtag(text, "newcastle")).toBe(true);
    expect(hasHashtag(text, "Newcastle")).toBe(true);
    expect(hasHashtag(text, "newcastl")).toBe(false);
    expect(hasHashtag("#newcastleupon", "newcastle")).toBe(false);
  });
});

describe("normalizeTag", () => {
  it("strips the leading # and lowercases", () => {
    expect(normalizeTag("#NewCastle")).toBe("newcastle");
    expect(normalizeTag("Foodie")).toBe("foodie");
  });
});
