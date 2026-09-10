import { describe, it, expect } from "vitest";
import {
  normalizeHost,
  isHexColor,
  parseChannelTheme,
  pickChannelKeyForHost,
  rowToChannel,
  parseChannelNav,
  parseChannelSections,
  parseChannelSurface,
  isSectionEnabled,
  DEFAULT_CHANNEL_KEY,
  type Channel,
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
      membership_mode: "members",
    });
    expect(ch).toEqual({
      id: "c1",
      key: "f2g",
      name: "Food to Go",
      tagline: "Order ahead.",
      isDefault: false,
      theme: { brand: "#E8562A" },
      logoUrl: null,
      membershipMode: "members",
      nav: [],
      sections: {},
      surface: "roam",
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
  it("defaults membership_mode to 'open' unless explicitly 'members'", () => {
    expect(rowToChannel({ id: "c3", key: "roam", name: "Roam", is_default: true, theme: {} }).membershipMode).toBe("open");
    expect(rowToChannel({ id: "c4", key: "x", name: "X", theme: {}, membership_mode: "bogus" }).membershipMode).toBe("open");
    expect(rowToChannel({ id: "c5", key: "x", name: "X", theme: {}, membership_mode: "members" }).membershipMode).toBe("members");
  });
  it("parses the config columns (nav / sections / surface) and defaults them when absent", () => {
    const bare = rowToChannel({ id: "c6", key: "roam", name: "Roam", is_default: true, theme: {} });
    expect(bare.nav).toEqual([]);
    expect(bare.sections).toEqual({});
    expect(bare.surface).toBe("roam");
    const f2g = rowToChannel({
      id: "c7",
      key: "f2g",
      name: "Food to Go",
      theme: {},
      surface: "storefront",
      sections: { storefront: true, explore: false },
      nav: [{ key: "nearMe", href: "/", labelKey: "nav_nearMe" }],
    });
    expect(f2g.surface).toBe("storefront");
    expect(f2g.sections).toEqual({ storefront: true, explore: false });
    expect(f2g.nav).toEqual([{ key: "nearMe", href: "/", labelKey: "nav_nearMe" }]);
  });
});

describe("parseChannelNav", () => {
  it("keeps only well-formed { key, href, labelKey } items, in order", () => {
    expect(
      parseChannelNav([
        { key: "a", href: "/a", labelKey: "nav_a" },
        { key: "b", href: "/b", labelKey: "nav_b", extra: "ignored" },
      ]),
    ).toEqual([
      { key: "a", href: "/a", labelKey: "nav_a" },
      { key: "b", href: "/b", labelKey: "nav_b" },
    ]);
  });
  it("drops malformed items rather than throwing", () => {
    expect(parseChannelNav([{ key: "a" }, null, "x", 3, { key: 1, href: "/", labelKey: "n" }])).toEqual([]);
  });
  it("returns [] for non-arrays", () => {
    expect(parseChannelNav(undefined)).toEqual([]);
    expect(parseChannelNav({})).toEqual([]);
    expect(parseChannelNav(null)).toEqual([]);
  });
});

describe("parseChannelSections", () => {
  it("keeps only boolean values (never coerces)", () => {
    expect(parseChannelSections({ storefront: true, explore: false, jobs: "yes", n: 1 })).toEqual({
      storefront: true,
      explore: false,
    });
  });
  it("preserves unknown keys (forward-compatible) and returns {} for non-objects", () => {
    expect(parseChannelSections({ somethingNew: true })).toEqual({ somethingNew: true });
    expect(parseChannelSections(undefined)).toEqual({});
    expect(parseChannelSections([true])).toEqual({});
  });
});

describe("parseChannelSurface", () => {
  it("only 'storefront' is storefront; everything else is roam", () => {
    expect(parseChannelSurface("storefront")).toBe("storefront");
    expect(parseChannelSurface("roam")).toBe("roam");
    expect(parseChannelSurface("bogus")).toBe("roam");
    expect(parseChannelSurface(undefined)).toBe("roam");
    expect(parseChannelSurface(null)).toBe("roam");
  });
});

describe("isSectionEnabled (explicit allow-map, no default-on)", () => {
  const ch = (sections: Record<string, boolean>): Channel =>
    rowToChannel({ id: "c", key: "k", name: "N", theme: {}, sections });
  it("true only when the section is present AND exactly true", () => {
    const c = ch({ storefront: true, explore: false });
    expect(isSectionEnabled(c, "storefront")).toBe(true);
    expect(isSectionEnabled(c, "explore")).toBe(false);
    expect(isSectionEnabled(c, "jobs")).toBe(false); // absent → not exposed (no default-on)
  });
  it("an unconfigured channel exposes nothing", () => {
    const c = ch({});
    expect(isSectionEnabled(c, "storefront")).toBe(false);
    expect(isSectionEnabled(c, "explore")).toBe(false);
  });
});
