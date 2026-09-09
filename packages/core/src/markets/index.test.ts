import { describe, it, expect } from "vitest";
import {
  MARKETS,
  DEFAULT_MARKET,
  DEFAULT_MARKET_CODE,
  getMarket,
  isKnownMarket,
  isLiveMarket,
  isUnitedKingdom,
  marketForCoords,
  normalizeCountryCode,
  resolveMarket,
} from "./index.js";
import { inBounds } from "../geocode/index.js";

describe("normalizeCountryCode", () => {
  it("uppercases and trims a 2-letter code", () => {
    expect(normalizeCountryCode(" gb ")).toBe("GB");
    expect(normalizeCountryCode("us")).toBe("US");
  });
  it("rejects non-2-letter input", () => {
    expect(normalizeCountryCode("")).toBeNull();
    expect(normalizeCountryCode("USA")).toBeNull();
    expect(normalizeCountryCode(null)).toBeNull();
    expect(normalizeCountryCode(undefined)).toBeNull();
  });
});

describe("getMarket", () => {
  it("resolves registered markets case-insensitively", () => {
    expect(getMarket("GB")?.code).toBe("GB");
    expect(getMarket("gb")?.code).toBe("GB");
    expect(getMarket("us")?.code).toBe("US");
  });
  it("returns undefined for an unknown country (NOT a silent default)", () => {
    expect(getMarket("FR")).toBeUndefined();
    expect(getMarket("XX")).toBeUndefined();
    expect(getMarket(null)).toBeUndefined();
  });
});

describe("market predicates", () => {
  it("isKnownMarket only for registered codes", () => {
    expect(isKnownMarket("GB")).toBe(true);
    expect(isKnownMarket("US")).toBe(true);
    expect(isKnownMarket("FR")).toBe(false);
  });
  it("isLiveMarket true for GB (live), false for US (seeding) and unknowns", () => {
    expect(isLiveMarket("GB")).toBe(true);
    expect(isLiveMarket("US")).toBe(false);
    expect(isLiveMarket("FR")).toBe(false);
  });
  it("isUnitedKingdom gates on GB only", () => {
    expect(isUnitedKingdom("gb")).toBe(true);
    expect(isUnitedKingdom("US")).toBe(false);
    expect(isUnitedKingdom(null)).toBe(false);
  });
});

describe("marketForCoords (fallback classifier)", () => {
  it("classifies a GB mainland point as GB (Darlington)", () => {
    expect(marketForCoords(54.5253, -1.5536)?.code).toBe("GB");
  });
  it("classifies a Northern Ireland point as GB (Belfast — NI is part of the UK)", () => {
    expect(marketForCoords(54.5973, -5.9301)?.code).toBe("GB");
  });
  it("classifies a contiguous-US point as US (New York)", () => {
    expect(marketForCoords(40.7128, -74.006)?.code).toBe("US");
  });
  it("returns undefined for a country we don't operate in (Paris)", () => {
    expect(marketForCoords(48.8566, 2.3522)).toBeUndefined();
  });
  it("returns undefined for Alaska/Hawaii (outside the contiguous box — code is the real signal)", () => {
    expect(marketForCoords(61.2181, -149.9003)).toBeUndefined(); // Anchorage, AK
    expect(marketForCoords(21.3069, -157.8583)).toBeUndefined(); // Honolulu, HI
  });
  it("returns undefined for non-finite input", () => {
    expect(marketForCoords(Number.NaN, 0)).toBeUndefined();
  });
});

describe("resolveMarket (signal precedence)", () => {
  // Belfast, Dublin, New York coordinates reused across cases.
  const BELFAST = { lat: 54.5973, lng: -5.9301 };
  const DUBLIN = { lat: 53.3498, lng: -6.2603 };
  const NEW_YORK = { lat: 40.7128, lng: -74.006 };

  it("an explicit operated country code wins and is used verbatim", () => {
    expect(resolveMarket("GB", NEW_YORK.lat, NEW_YORK.lng)?.code).toBe("GB");
    expect(resolveMarket("US", BELFAST.lat, BELFAST.lng)?.code).toBe("US");
  });

  it("an explicit UNoperated country code yields undefined — NOT a coord-box rescue (the #A2 fix)", () => {
    // Dublin sits inside GB's generous fallback box, so the old `?? marketForCoords` would have
    // reclassified an "IE" visitor as GB. The explicit code must win: unknown market → seeding.
    expect(resolveMarket("IE", DUBLIN.lat, DUBLIN.lng)).toBeUndefined();
    // Even a coordinate squarely inside an operated box must not override the explicit foreign code.
    expect(resolveMarket("FR", BELFAST.lat, BELFAST.lng)).toBeUndefined();
  });

  it("falls back to the coordinate box only when NO country code is present", () => {
    expect(resolveMarket(null, BELFAST.lat, BELFAST.lng)?.code).toBe("GB");
    expect(resolveMarket(undefined, NEW_YORK.lat, NEW_YORK.lng)?.code).toBe("US");
    expect(resolveMarket("", DUBLIN.lat, DUBLIN.lng)?.code).toBe("GB"); // no code → box (Dublin ∈ GB box)
  });

  it("a malformed country code is treated as no code (falls back to coords)", () => {
    expect(resolveMarket("USA", NEW_YORK.lat, NEW_YORK.lng)?.code).toBe("US");
  });

  it("no usable signal at all → undefined (unknown, seeding — never DEFAULT_MARKET)", () => {
    expect(resolveMarket(null)).toBeUndefined();
    expect(resolveMarket(undefined, null, null)).toBeUndefined();
    expect(resolveMarket("", undefined, undefined)).toBeUndefined();
  });
});

describe("registry invariants", () => {
  it("each entry's code matches its key", () => {
    for (const [key, m] of Object.entries(MARKETS)) expect(m.code).toBe(key);
  });
  it("each market's defaultPlace sits inside its own bounds", () => {
    for (const m of Object.values(MARKETS)) {
      expect(inBounds(m.defaultPlace.lat, m.defaultPlace.lng, m.bounds)).toBe(true);
    }
  });
  it("the default market is GB", () => {
    expect(DEFAULT_MARKET_CODE).toBe("GB");
    expect(DEFAULT_MARKET.code).toBe("GB");
  });
});
