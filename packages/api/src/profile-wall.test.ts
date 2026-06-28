import { describe, it, expect } from "vitest";
import {
  normaliseWallBody,
  normaliseWallMedia,
  normaliseCommentBody,
  assertPostNotEmpty,
  WALL_BODY_MAX,
  COMMENT_BODY_MAX,
  MAX_WALL_IMAGES,
} from "./profile-wall.js";

describe("normaliseWallBody", () => {
  it("trims and keeps inner newlines", () => {
    expect(normaliseWallBody("  line one\nline two  ")).toBe("line one\nline two");
  });
  it("empty / whitespace / null → null (media-only posts are valid)", () => {
    expect(normaliseWallBody("   ")).toBeNull();
    expect(normaliseWallBody(null)).toBeNull();
    expect(normaliseWallBody(undefined)).toBeNull();
  });
  it("throws over the length bound", () => {
    expect(() => normaliseWallBody("x".repeat(WALL_BODY_MAX + 1))).toThrow();
  });
});

describe("normaliseWallMedia", () => {
  it("accepts valid image items and strips extra keys", () => {
    const out = normaliseWallMedia([{ type: "image", url: "https://cdn.example.com/a.jpg", junk: 1 }]);
    expect(out).toEqual([{ type: "image", url: "https://cdn.example.com/a.jpg" }]);
  });
  it("absent / empty → []", () => {
    expect(normaliseWallMedia(null)).toEqual([]);
    expect(normaliseWallMedia([])).toEqual([]);
  });
  it("rejects non-array, bad type, non-http url", () => {
    expect(() => normaliseWallMedia({})).toThrow();
    expect(() => normaliseWallMedia([{ type: "video", url: "https://x.com/v.mp4" }])).toThrow();
    expect(() => normaliseWallMedia([{ type: "image", url: "javascript:alert(1)" }])).toThrow();
    expect(() => normaliseWallMedia([{ type: "image", url: "not a url" }])).toThrow();
  });
  it("caps the image count", () => {
    const many = Array.from({ length: MAX_WALL_IMAGES + 1 }, (_, i) => ({ type: "image", url: `https://x.com/${i}.jpg` }));
    expect(() => normaliseWallMedia(many)).toThrow();
  });
});

describe("assertPostNotEmpty", () => {
  it("passes with a body", () => {
    expect(() => assertPostNotEmpty("hi", [])).not.toThrow();
  });
  it("passes with media only", () => {
    expect(() => assertPostNotEmpty(null, [{ type: "image", url: "https://x.com/a.jpg" }])).not.toThrow();
  });
  it("throws when both empty", () => {
    expect(() => assertPostNotEmpty(null, [])).toThrow();
    expect(() => assertPostNotEmpty("", [])).toThrow();
  });
});

describe("normaliseCommentBody", () => {
  it("trims", () => {
    expect(normaliseCommentBody("  nice!  ")).toBe("nice!");
  });
  it("rejects empty", () => {
    expect(() => normaliseCommentBody("   ")).toThrow();
  });
  it("rejects over-long", () => {
    expect(() => normaliseCommentBody("x".repeat(COMMENT_BODY_MAX + 1))).toThrow();
  });
});
