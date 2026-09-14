import { describe, it, expect } from "vitest";
import {
  isDisplayableRating,
  ratingBadge,
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

describe("ratingBadge", () => {
  it("gives a self-hosted asset id + accessible alt for each score", () => {
    expect(ratingBadge(5)).toEqual({ assetId: "fhrs-5", alt: "Food Hygiene Rating: 5 out of 5" });
    expect(ratingBadge(0)).toEqual({ assetId: "fhrs-0", alt: "Food Hygiene Rating: 0 out of 5" });
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
