/**
 * suggestions core — the template generator is the engine behind the dashboard's "Suggested for
 * you" panel, so lock its contract: it never exceeds the discount cap, features the business's own
 * subjects, ranks offer ideas by engagement, and always returns some post starters.
 */
import { describe, it, expect } from "vitest";
import { generateSuggestions, discountSubjects, type SuggestionInput } from "./index.js";

const base: SuggestionInput = {
  discountCapPct: 30,
  offerTypes: ["percent_off", "two_for_one", "free_item"],
  productNotes: "weekday lunch mains, first coffee",
  engagement: [],
  dayName: "Friday",
};

describe("discountSubjects", () => {
  it("splits a note into trimmed subjects", () => {
    expect(discountSubjects("weekday lunch, first coffee; haircuts")).toEqual([
      "weekday lunch",
      "first coffee",
      "haircuts",
    ]);
  });
  it("is empty for blank/absent notes", () => {
    expect(discountSubjects(null)).toEqual([]);
    expect(discountSubjects("")).toEqual([]);
  });
});

describe("generateSuggestions", () => {
  it("returns offer + post ideas", () => {
    const s = generateSuggestions(base);
    expect(s.some((x) => x.kind === "offer")).toBe(true);
    expect(s.some((x) => x.kind === "post")).toBe(true);
    expect(s.length).toBeGreaterThanOrEqual(3);
  });

  it("never suggests a discount above the cap", () => {
    const capped = generateSuggestions({ ...base, discountCapPct: 10 });
    for (const x of capped) {
      if (x.suggestedDiscountPct != null) expect(x.suggestedDiscountPct).toBeLessThanOrEqual(10);
    }
  });

  it("features the business's first discount subject in the copy", () => {
    const s = generateSuggestions(base);
    expect(s.some((x) => x.title.includes("weekday lunch mains") || x.body.includes("weekday lunch mains"))).toBe(true);
  });

  it("ranks the best-engaging theme first among offers", () => {
    const s = generateSuggestions({
      ...base,
      engagement: [
        { offerType: "free_item", saves: 50, redemptions: 20 },
        { offerType: "percent_off", saves: 1, redemptions: 0 },
      ],
    });
    const firstOffer = s.find((x) => x.kind === "offer");
    expect(firstOffer?.offerType).toBe("free_item");
  });

  it("falls back to defaults when prefs are empty (still useful)", () => {
    const s = generateSuggestions({ discountCapPct: null, offerTypes: [], productNotes: null, engagement: [], dayName: "Monday" });
    expect(s.length).toBeGreaterThanOrEqual(3);
    // percent_off default gets the 20% default, within the default cap.
    const pct = s.find((x) => x.offerType === "percent_off");
    expect(pct?.suggestedDiscountPct).toBe(20);
  });

  it("de-dupes repeated preferred types", () => {
    const s = generateSuggestions({ ...base, offerTypes: ["two_for_one", "two_for_one", "percent_off"] });
    const offerIds = s.filter((x) => x.kind === "offer").map((x) => x.id);
    expect(new Set(offerIds).size).toBe(offerIds.length);
  });
});
