import { describe, it, expect } from "vitest";
import {
  normalizeHost,
  isHexColor,
  parseChannelTheme,
  pickChannelKeyForHost,
  rowToChannel,
  DEFAULT_CHANNEL_KEY,
  type DomainMapping,
} from "./index.js";

describe("normalizeHost", () => {
  it("lowercases and trims", () => {
    expect(normalizeHost("  F2G.Local  ")).toBe("f2g.local");
  });
  it("strips scheme, port, path, query and trailing dot", () => {
    expect(normalizeHost("https://f2g.local:3000/menu?x=1")).toBe("f2g.local");
    expect(normalizeHost("food.local.")).toBe("food.local");
  });
  it("takes the first hop of a forwarded host list", () => {
    expect(normalizeHost("f2g.local, proxy.internal")).toBe("f2g.local");
  });
  it("returns '' for empty/nullish input", () => {
    expect(normalizeHost("")).toBe("");
    expect(normalizeHost(null)).toBe("");
    expect(normalizeHost(undefined)).toBe("");
  });
});

describe("isHexColor", () => {
  it("accepts #rgb and #rrggbb", () => {
    expect(isHexColor("#E8562A")).toBe(true);
    expect(isHexColor("#abc")).toBe(true);
  });
  it("rejects non-hex, wrong length, and non-strings", () => {
    expect(isHexColor("red")).toBe(false);
    expect(isHexColor("#12")).toBe(false);
    expect(isHexColor("rgb(0,0,0)")).toBe(false);
    expect(isHexColor(123)).toBe(false);
    expect(isHexColor(null)).toBe(false);
  });
});

describe("parseChannelTheme", () => {
  it("keeps only known keys with valid hex values", () => {
    expect(
      parseChannelTheme({
        brand: "#E8562A",
        accent: "#1F9D55",
        paper: "not-a-colour",
        ink: "#20140E",
        evil: "url(javascript:alert(1))",
      }),
    ).toEqual({ brand: "#E8562A", accent: "#1F9D55", ink: "#20140E" });
  });
  it("returns {} for non-objects, arrays and null", () => {
    expect(parseChannelTheme(null)).toEqual({});
    expect(parseChannelTheme("nope")).toEqual({});
    expect(parseChannelTheme(["#fff"])).toEqual({});
  });
});

describe("pickChannelKeyForHost", () => {
  const domains: DomainMapping[] = [
    { host: "f2g.local", channelKey: "f2g" },
    { host: "food.local", channelKey: "f2g" },
    { host: "roam.local", channelKey: "roam" },
  ];
  it("matches a mapped host regardless of scheme/port/case", () => {
    expect(pickChannelKeyForHost("https://F2G.local:3000/x", domains)).toBe("f2g");
  });
  it("falls back to the default for an unmapped host", () => {
    expect(pickChannelKeyForHost("unknown.example", domains)).toBe(DEFAULT_CHANNEL_KEY);
  });
  it("falls back to the default for an empty host", () => {
    expect(pickChannelKeyForHost("", domains)).toBe(DEFAULT_CHANNEL_KEY);
  });
  it("honours a custom default key", () => {
    expect(pickChannelKeyForHost("nope", [], "house")).toBe("house");
  });
});

describe("rowToChannel", () => {
  it("maps snake_case row to the domain shape and validates theme", () => {
    const ch = rowToChannel({
      id: "c1",
      key: "f2g",
      name: "Food to Go",
      tagline: "Order ahead.",
      is_default: false,
      theme: { brand: "#E8562A", bogus: "x" },
      logo_url: null,
    });
    expect(ch).toEqual({
      id: "c1",
      key: "f2g",
      name: "Food to Go",
      tagline: "Order ahead.",
      isDefault: false,
      theme: { brand: "#E8562A" },
      logoUrl: null,
    });
  });
  it("defaults missing nullable fields", () => {
    const ch = rowToChannel({
      id: "c2",
      key: "roam",
      name: "Roam",
      is_default: true,
      theme: {},
    });
    expect(ch.tagline).toBeNull();
    expect(ch.logoUrl).toBeNull();
    expect(ch.isDefault).toBe(true);
  });
});
