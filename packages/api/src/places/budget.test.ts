import { describe, it, expect } from "vitest";
import { places as corePlaces } from "@roam/core";
import { envPosInt, resolvePlacesPolicy } from "./budget.js";

describe("envPosInt", () => {
  it("falls back for unset / blank / non-integer / non-positive", () => {
    expect(envPosInt(undefined, 2000)).toBe(2000);
    expect(envPosInt("", 2000)).toBe(2000);
    expect(envPosInt("   ", 2000)).toBe(2000);
    expect(envPosInt("abc", 2000)).toBe(2000);
    expect(envPosInt("1.5", 2000)).toBe(2000); // must be an integer
    expect(envPosInt("0", 2000)).toBe(2000); // never disables a cost bound
    expect(envPosInt("-5", 2000)).toBe(2000);
  });
  it("accepts a positive-integer override (whitespace tolerated)", () => {
    expect(envPosInt("5000", 2000)).toBe(5000);
    expect(envPosInt(" 100 ", 2000)).toBe(100);
  });
});

describe("resolvePlacesPolicy", () => {
  it("defaults to the @roam/core constants with an empty env", () => {
    const p = resolvePlacesPolicy({});
    expect(p.dailyFetchBudget).toBe(corePlaces.PLACES_DAILY_FETCH_BUDGET);
    expect(p.detailsDailyBudget).toBe(corePlaces.PLACES_DETAILS_DAILY_BUDGET);
    expect(p.clientFetchLimit).toBe(corePlaces.PLACES_CLIENT_FETCH_LIMIT);
    expect(p.clientWindowSecs).toBe(corePlaces.PLACES_CLIENT_WINDOW_SECS);
  });
  it("applies valid overrides and ignores invalid ones", () => {
    const p = resolvePlacesPolicy({
      PLACES_DAILY_FETCH_BUDGET: "9000",
      PLACES_DETAILS_DAILY_BUDGET: "0", // invalid → default
      PLACES_CLIENT_FETCH_LIMIT: "120",
    } as NodeJS.ProcessEnv);
    expect(p.dailyFetchBudget).toBe(9000);
    expect(p.detailsDailyBudget).toBe(corePlaces.PLACES_DETAILS_DAILY_BUDGET);
    expect(p.clientFetchLimit).toBe(120);
    expect(p.clientWindowSecs).toBe(corePlaces.PLACES_CLIENT_WINDOW_SECS);
  });
});
