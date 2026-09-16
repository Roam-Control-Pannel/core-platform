import { describe, it, expect } from "vitest";
import {
  normaliseBusinessName,
  nameSimilarity,
  coreNameTokens,
  tokenContainment,
  extractPostcode,
  postcodeAgreement,
  scoreMatch,
  resolveCandidates,
  MATCH_THRESHOLDS,
  type MatchParty,
} from "./index.js";

describe("normaliseBusinessName", () => {
  it("lowercases, expands &, drops apostrophes/periods, strips legal suffixes and 'the'", () => {
    expect(normaliseBusinessName("Mario's Pizzeria Ltd")).toBe("marios pizzeria");
    expect(normaliseBusinessName("The Fish & Chip Co. LIMITED")).toBe("fish and chip co");
    expect(normaliseBusinessName("St. Mary's Bakery")).toBe("st marys bakery");
  });

  it("does NOT over-strip (a 'co' inside a word survives)", () => {
    expect(normaliseBusinessName("Co-op Food")).toBe("co op food");
    expect(normaliseBusinessName("Costa Coffee")).toBe("costa coffee");
  });

  it("returns '' for empty/garbage", () => {
    expect(normaliseBusinessName("")).toBe("");
    expect(normaliseBusinessName("   ")).toBe("");
    expect(normaliseBusinessName(null)).toBe("");
    expect(normaliseBusinessName("!!!")).toBe("");
  });
});

describe("nameSimilarity", () => {
  it("is 1 for names that normalise identically, regardless of formatting", () => {
    expect(nameSimilarity("Mario's Pizzeria", "MARIOS pizzeria")).toBe(1);
    expect(nameSimilarity("Fish & Chips", "Fish and Chips")).toBe(1);
  });

  it("scores close variants high and unrelated names low", () => {
    expect(nameSimilarity("The Fish & Chip Company", "Fish and Chips")).toBeGreaterThan(0.5);
    expect(nameSimilarity("Joe's Barbers", "Belfast Print Studio")).toBeLessThan(0.3);
  });

  it("never falsely matches on empty input", () => {
    expect(nameSimilarity("", "")).toBe(0);
    expect(nameSimilarity("Greggs", "")).toBe(0);
    expect(nameSimilarity(null, "Greggs")).toBe(0);
  });
});

describe("coreNameTokens / tokenContainment / nameSimilarityInContext", () => {
  it("strips locality tokens that occur in either party's address (no hardcoded town list)", () => {
    expect(coreNameTokens("Cape Cod Ballymena", ["12 Broughshane St, Ballymena BT42 3AU"])).toEqual(["cape", "cod"]);
    expect(coreNameTokens("Domino's Pizza - Bangor - Abbey Street (NI)", ["Abbey Street, Bangor BT20 4JB"])).toEqual([
      "dominos",
      "pizza",
    ]);
    expect(coreNameTokens("Subway Lisnagelvin", [null, "Lisnagelvin Shopping Centre, Derry BT47 6DF"])).toEqual(["subway"]);
  });

  it("strips generic descriptors but never empties a real name", () => {
    expect(coreNameTokens("Starbucks Coffee Company")).toEqual(["starbucks"]);
    expect(coreNameTokens("The Belfry Delicatessen")).toEqual(["belfry"]);
    expect(coreNameTokens("The Coffee Shop")).toEqual(["coffee", "shop"]); // fallback: descriptors kept
  });

  it("containment: identical → 1, contained + discriminating → 0.9, disjoint → 0, a lone short token → 0", () => {
    expect(tokenContainment(["cape", "cod"], ["cape", "cod"])).toBe(1);
    expect(tokenContainment(["quirky", "cricketer"], ["quirky", "cricketer", "dock"])).toBe(0.9);
    expect(tokenContainment(["kfc"], ["kfc", "omniplex"])).toBe(0.9);
    expect(tokenContainment(["sweet", "treats"], ["corner"])).toBe(0);
    expect(tokenContainment(["b5"], ["b5", "grill"])).toBe(0);
  });

  it("accepts the real-world variants the plain Dice rejected (same full postcode)", () => {
    const pairs: [string, string, string][] = [
      ["Cape Cod Ballymena", "Cape Cod", "Broughshane St, Ballymena BT42 3AU"],
      ["SmashnBird - (Botanic Avenue)", "Smash n Bird", "Botanic Avenue, Belfast BT7 1JR"],
      ["Cafollas TakeAway - Armagh", "CAFOLLAS FAST FOOD", "Armagh BT61 7LJ"],
      ["Starbucks Coffee Company", "Starbucks", "Belfast BT14 7EN"],
      ["The Belfry Delicatessen", "The Belfry Deli", "Coleraine BT52 1DS"],
      ["Subway", "Subway Lisnagelvin", "Lisnagelvin, Derry BT47 6DF"],
      ["The Crown Liquor Saloon", "Crown Bar", "Great Victoria St, Belfast BT2 7BA"],
      ["THE QUIRKY CRICKETER", "The Quirky Cricketer Coffee Dock", "Lisburn BT27 4AF"],
    ];
    for (const [roam, fsa, address] of pairs) {
      const r = resolveCandidates(
        { name: fsa, postcode: extractPostcode(address), address },
        [{ id: "v", name: roam, postcode: extractPostcode(address), address }],
      );
      expect(r.decision, `${roam} ↔ ${fsa}`).toBe("accept");
    }
  });

  it("still rejects unrelated names at the same postcode (fail-closed)", () => {
    const address = "Belfast BT9 7HN";
    const pairs: [string, string][] = [
      ["shake it milksake and dessert bar", "Greggs PLC"],
      ["Cafe Connect @ LPCCC", "LAGAN VALLEY HOSPITAL"],
      ["Sweet Treats", "The Corner Shop"],
      ["Domino's Pizza - Belfast", "Greens Pizza"],
    ];
    for (const [roam, fsa] of pairs) {
      const r = resolveCandidates(
        { name: fsa, postcode: "BT9 7HN", address },
        [{ id: "v", name: roam, postcode: "BT9 7HN", address }],
      );
      expect(r.decision, `${roam} ↔ ${fsa}`).not.toBe("accept");
    }
  });

  it("a chain's two branches on one postcode STILL go to review (ambiguity margin untouched)", () => {
    const r = resolveCandidates(
      { name: "Subway", postcode: "BT11 9AE", address: "Kennedy Centre, Belfast BT11 9AE" },
      [
        { id: "s1", name: "Subway", postcode: "BT11 9AE", address: "Kennedy Centre, Belfast BT11 9AE" },
        { id: "s2", name: "Subway Kennedy Centre", postcode: "BT11 9AE", address: "Kennedy Centre, Belfast BT11 9AE" },
      ],
    );
    expect(r.decision).toBe("review");
  });

  it("never lifts a strong name past accept without full-postcode agreement", () => {
    const r = resolveCandidates(
      { name: "Cape Cod", postcode: "BT42 3AU", address: "Ballymena BT42 3AU" },
      [{ id: "v", name: "Cape Cod Ballymena", postcode: "BT42 9ZZ", address: "Ballymena BT42 9ZZ" }],
    );
    expect(r.decision).toBe("review");
  });
});

describe("extractPostcode", () => {
  it("pulls a normalised postcode out of a free-text address", () => {
    expect(extractPostcode("123 High Street, Belfast, BT1 1AA")).toBe("BT1 1AA");
    expect(extractPostcode("Unit 4, Derry BT476XX")).toBe("BT47 6XX");
  });

  it("returns '' when the address carries no recognisable postcode", () => {
    expect(extractPostcode("123 High Street, Belfast")).toBe("");
    expect(extractPostcode("")).toBe("");
    expect(extractPostcode(null)).toBe("");
  });
});

describe("postcodeAgreement", () => {
  it("classifies full / outward / none (and treats missing as none)", () => {
    expect(postcodeAgreement("BT1 1AA", "bt11aa")).toBe("full");
    expect(postcodeAgreement("BT1 1AA", "BT1 2BB")).toBe("outward");
    expect(postcodeAgreement("BT1 1AA", "BT9 9ZZ")).toBe("none");
    expect(postcodeAgreement("BT1 1AA", null)).toBe("none");
    expect(postcodeAgreement(null, null)).toBe("none");
  });
});

describe("scoreMatch — name carries the signal, postcode lifts it (fail-closed)", () => {
  it("a name-only match (no postcode agreement) CANNOT reach the accept threshold", () => {
    const s = scoreMatch(
      { name: "Ivy Belfast", postcode: "BT1 1AA" },
      { name: "Ivy Belfast", postcode: "BT9 9ZZ" },
    );
    expect(s.nameScore).toBe(1);
    expect(s.postcode).toBe("none");
    expect(s.score).toBeLessThan(MATCH_THRESHOLDS.accept); // 1*0.8 + 0 = 0.8
    expect(s.score).toBeGreaterThanOrEqual(MATCH_THRESHOLDS.review);
  });

  it("full postcode + strong name reaches accept", () => {
    const s = scoreMatch(
      { name: "Mario's Pizzeria", postcode: "BT1 1AA" },
      { name: "Marios Pizzeria", postcode: "BT1 1AA" },
    );
    expect(s.score).toBeGreaterThanOrEqual(MATCH_THRESHOLDS.accept);
  });
});

describe("resolveCandidates — accept / review / reject", () => {
  const target: MatchParty = { name: "Mario's Pizzeria", postcode: "BT1 1AA" };

  it("accepts a single clear match", () => {
    const r = resolveCandidates(target, [
      { id: "v1", name: "Marios Pizzeria", postcode: "BT1 1AA" },
      { id: "v2", name: "Belfast Print Studio", postcode: "BT5 5XX" },
    ]);
    expect(r.decision).toBe("accept");
    expect(r.best?.candidate.id).toBe("v1");
  });

  it("sends an AMBIGUOUS chain (two branches on one postcode) to review, never auto-accept", () => {
    const r = resolveCandidates(
      { name: "Greggs", postcode: "BT1 1AA" },
      [
        { id: "g1", name: "Greggs", postcode: "BT1 1AA" },
        { id: "g2", name: "Greggs", postcode: "BT1 1AA" },
      ],
    );
    expect(r.decision).toBe("review");
    expect(r.best).not.toBeNull();
    expect(r.runnerUp).not.toBeNull();
  });

  it("sends a strong name with a MISMATCHED postcode to review (not accept)", () => {
    const r = resolveCandidates(
      { name: "The Ivy", postcode: "BT1 1AA" },
      [{ id: "v9", name: "The Ivy", postcode: "BT99 9ZZ" }],
    );
    expect(r.decision).toBe("review");
  });

  it("rejects when the best candidate is weak", () => {
    const r = resolveCandidates(target, [
      { id: "x1", name: "Belfast Print Studio", postcode: "BT5 5XX" },
    ]);
    expect(r.decision).toBe("reject");
  });

  it("rejects (no crash) when there are no candidates — a member with no venue in its postcode", () => {
    const r = resolveCandidates(target, []);
    expect(r.decision).toBe("reject");
    expect(r.best).toBeNull();
    expect(r.ranked).toHaveLength(0);
  });

  it("ranks candidates highest-first", () => {
    const r = resolveCandidates(target, [
      { id: "weak", name: "Totally Different", postcode: "BT5 5XX" },
      { id: "strong", name: "Marios Pizzeria", postcode: "BT1 1AA" },
    ]);
    expect(r.ranked[0]!.candidate.id).toBe("strong");
    expect(r.ranked[1]!.candidate.id).toBe("weak");
    expect(r.ranked[0]!.score).toBeGreaterThan(r.ranked[1]!.score);
  });
});
