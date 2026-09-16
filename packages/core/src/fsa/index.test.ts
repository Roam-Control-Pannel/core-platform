import { describe, it, expect } from "vitest";
import {
  isDisplayableRating,
  officialBadge,
  ratingAlt,
  FHRS_BADGE_KEYS,
  parseFsaEstablishment,
  FSA_ATTRIBUTION,
} from "./index.js";

describe("isDisplayableRating — the never-show-a-status-as-0 guardrail", () => {
  it("maps a genuine numeric 0–5 to a score (string or number)", () => {
    expect(isDisplayableRating("5")).toEqual({ kind: "score", score: 5 });
    expect(isDisplayableRating("0")).toEqual({ kind: "score", score: 0 });
    expect(isDisplayableRating(3)).toEqual({ kind: "score", score: 3 });
  });

  it("NEVER renders a non-numeric status as a score", () => {
    // The whole point: these must not become 0.
    expect(isDisplayableRating("AwaitingInspection")).toEqual({ kind: "awaiting" });
    expect(isDisplayableRating("Awaiting Inspection")).toEqual({ kind: "awaiting" });
    expect(isDisplayableRating("awaitingpublication")).toEqual({ kind: "awaiting" });
    expect(isDisplayableRating("Exempt")).toEqual({ kind: "exempt" });
    expect(isDisplayableRating("exempt")).toEqual({ kind: "exempt" });
  });

  it("returns none for null/empty/unknown and non-FHRS schemes", () => {
    expect(isDisplayableRating(null)).toEqual({ kind: "none" });
    expect(isDisplayableRating(undefined)).toEqual({ kind: "none" });
    expect(isDisplayableRating("")).toEqual({ kind: "none" });
    expect(isDisplayableRating("   ")).toEqual({ kind: "none" });
    expect(isDisplayableRating("Pass")).toEqual({ kind: "none" }); // Scotland FHIS — we render FHRS only
    expect(isDisplayableRating("Improvement Required")).toEqual({ kind: "none" });
  });

  it("rejects out-of-range and non-integer numbers (no 6, no 4.5, no '05')", () => {
    expect(isDisplayableRating(6)).toEqual({ kind: "none" });
    expect(isDisplayableRating(-1)).toEqual({ kind: "none" });
    expect(isDisplayableRating(4.5)).toEqual({ kind: "none" });
    expect(isDisplayableRating("05")).toEqual({ kind: "none" });
    expect(isDisplayableRating(Number.NaN)).toEqual({ kind: "none" });
  });
});

describe("officialBadge — the official FHRS artwork, keyed by the FSA's own rating key", () => {
  it("returns the asset id (= the FSA key) + an alt carrying the sticker's descriptor for each score", () => {
    for (const score of [0, 1, 2, 3, 4, 5] as const) {
      const key = `fhrs_${score}_en-gb`;
      expect(officialBadge(key, { kind: "score", score })).toEqual({
        assetId: key,
        alt: ratingAlt({ kind: "score", score }),
      });
    }
    expect(officialBadge("fhrs_5_en-gb", { kind: "score", score: 5 })?.alt).toBe(
      "Food Hygiene Rating: 5 out of 5 (Very good)",
    );
    expect(officialBadge("fhrs_0_en-gb", { kind: "score", score: 0 })?.alt).toBe(
      "Food Hygiene Rating: 0 out of 5 (Urgent improvement necessary)",
    );
  });

  it("gives the statuses their own official artwork — never a numeric one", () => {
    expect(officialBadge("fhrs_awaitinginspection_en-gb", { kind: "awaiting" })).toEqual({
      assetId: "fhrs_awaitinginspection_en-gb",
      alt: "Food Hygiene Rating: Awaiting inspection",
    });
    expect(officialBadge("fhrs_exempt_en-gb", { kind: "exempt" })).toEqual({
      assetId: "fhrs_exempt_en-gb",
      alt: "Food Hygiene Rating: Exempt",
    });
    // A status paired with a numeric key is a contradiction → no official badge.
    expect(officialBadge("fhrs_0_en-gb", { kind: "awaiting" })).toBeNull();
    expect(officialBadge("fhrs_5_en-gb", { kind: "exempt" })).toBeNull();
  });

  it("refuses a key that disagrees with the displayed value (never the wrong sticker)", () => {
    expect(officialBadge("fhrs_5_en-gb", { kind: "score", score: 4 })).toBeNull();
    expect(officialBadge("fhrs_exempt_en-gb", { kind: "score", score: 5 })).toBeNull();
  });

  it("returns null for keys we ship no artwork for (Welsh, Scotland's FHIS, unknown, awaiting publication)", () => {
    expect(officialBadge("fhrs_5_cy-gb", { kind: "score", score: 5 })).toBeNull();
    expect(officialBadge("fhis_pass_en-gb", { kind: "none" })).toBeNull();
    expect(officialBadge("fhrs_awaitingpublication_en-gb", { kind: "awaiting" })).toBeNull();
    expect(officialBadge("something_new", { kind: "score", score: 5 })).toBeNull();
  });

  it("never derives a key: a missing key means no official badge (the UI falls back to its own mark)", () => {
    expect(officialBadge(null, { kind: "score", score: 5 })).toBeNull();
    expect(officialBadge(undefined, { kind: "exempt" })).toBeNull();
    expect(officialBadge("  ", { kind: "score", score: 5 })).toBeNull();
  });

  it("is tolerant of case/whitespace in the key, and 'none' never gets a badge", () => {
    expect(officialBadge(" FHRS_5_EN-GB ", { kind: "score", score: 5 })?.assetId).toBe("fhrs_5_en-gb");
    expect(officialBadge("fhrs_5_en-gb", { kind: "none" })).toBeNull();
    expect(ratingAlt({ kind: "none" })).toBeNull();
  });

  it("ships exactly the keys present in the live NI register (2026-09-16)", () => {
    expect([...FHRS_BADGE_KEYS].sort()).toEqual([
      "fhrs_0_en-gb",
      "fhrs_1_en-gb",
      "fhrs_2_en-gb",
      "fhrs_3_en-gb",
      "fhrs_4_en-gb",
      "fhrs_5_en-gb",
      "fhrs_awaitinginspection_en-gb",
      "fhrs_exempt_en-gb",
    ]);
  });
});

describe("FSA_ATTRIBUTION", () => {
  it("carries the mandatory OGL attribution + source", () => {
    expect(FSA_ATTRIBUTION.text).toMatch(/Open Government Licence/i);
    expect(FSA_ATTRIBUTION.licenceUrl).toMatch(/open-government-licence/);
    expect(FSA_ATTRIBUTION.source).toBe("Food Standards Agency");
  });
});

describe("parseFsaEstablishment", () => {
  it("normalises a raw FSA record (address join, geocode, date trim)", () => {
    const rec = {
      FHRSID: "123456",
      BusinessName: "Verbatim Cafe",
      BusinessType: "Restaurant/Cafe/Canteen",
      AddressLine1: "12 High St",
      AddressLine2: "",
      AddressLine3: "Belfast",
      AddressLine4: null,
      PostCode: "BT1 1AA",
      RatingValue: "5",
      RatingKey: "fhrs_5_en-gb",
      RatingDate: "2026-01-15T00:00:00",
      LocalAuthorityName: "Belfast",
      Geocode: { Longitude: "-5.93", Latitude: "54.59" },
    };
    expect(parseFsaEstablishment(rec)).toEqual({
      fhrsid: "123456",
      businessName: "Verbatim Cafe",
      businessType: "Restaurant/Cafe/Canteen",
      address: "12 High St, Belfast",
      postcode: "BT1 1AA",
      ratingValue: "5",
      ratingKey: "fhrs_5_en-gb",
      ratingDate: "2026-01-15",
      localAuthority: "Belfast",
      lat: 54.59,
      lng: -5.93,
      raw: rec,
    });
  });

  it("returns null without a usable FHRSID (the upsert key)", () => {
    expect(parseFsaEstablishment({ BusinessName: "No id" })).toBeNull();
    expect(parseFsaEstablishment(null)).toBeNull();
  });

  it("keeps a non-numeric rating verbatim (display is decided later, not here)", () => {
    const p = parseFsaEstablishment({ FHRSID: "9", BusinessName: "New", RatingValue: "AwaitingInspection" });
    expect(p?.ratingValue).toBe("AwaitingInspection");
    expect(p?.ratingDate).toBeNull();
  });
});
