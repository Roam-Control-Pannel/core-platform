/**
 * offers core — the offer-theme taxonomy is a small shared contract (the API validates against it,
 * the web mirrors it), so lock down its shape and the coercion helpers that keep unknown/legacy
 * values from leaking into analytics as anything other than "other".
 */
import { describe, it, expect } from "vitest";
import {
  OFFER_TYPES,
  OFFER_TYPE_LABELS,
  isOfferType,
  normaliseOfferType,
  offerTypeLabel,
  offerTypeUsesPercent,
} from "./index.js";

describe("offer types", () => {
  it("every type has a label", () => {
    for (const t of OFFER_TYPES) {
      expect(OFFER_TYPE_LABELS[t]).toBeTruthy();
    }
    expect(Object.keys(OFFER_TYPE_LABELS)).toHaveLength(OFFER_TYPES.length);
  });

  it("includes 'other' as the fallback and the theme set is unique", () => {
    expect(OFFER_TYPES).toContain("other");
    expect(new Set(OFFER_TYPES).size).toBe(OFFER_TYPES.length);
  });

  it("isOfferType recognises canonical values only", () => {
    expect(isOfferType("two_for_one")).toBe(true);
    expect(isOfferType("bogof")).toBe(true);
    expect(isOfferType("nonsense")).toBe(false);
    expect(isOfferType(null)).toBe(false);
    expect(isOfferType(undefined)).toBe(false);
  });

  it("normaliseOfferType coerces unknown/absent to 'other'", () => {
    expect(normaliseOfferType("percent_off")).toBe("percent_off");
    expect(normaliseOfferType("legacy_kind")).toBe("other");
    expect(normaliseOfferType(null)).toBe("other");
    expect(normaliseOfferType(undefined)).toBe("other");
  });

  it("offerTypeLabel labels canonical + coerces unknowns", () => {
    expect(offerTypeLabel("two_for_one")).toBe("2-for-1");
    expect(offerTypeLabel("???")).toBe("Other");
  });

  it("only percent_off uses a percentage discount", () => {
    expect(offerTypeUsesPercent("percent_off")).toBe(true);
    expect(offerTypeUsesPercent("bogof")).toBe(false);
    expect(offerTypeUsesPercent(null)).toBe(false);
  });
});
