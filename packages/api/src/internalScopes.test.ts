import { describe, it, expect } from "vitest";
import { isAllowedForScope, WEB_INTERNAL_SCOPE } from "./internalScopes.js";

describe("internal-call scopes", () => {
  it("no scope (no valid secret) may call nothing", () => {
    expect(isAllowedForScope(null, "places.ingestFoodToGo")).toBe(false);
  });

  it("the full scope may call anything", () => {
    for (const p of ["moderation.setUserBanned", "credits.grant", "places.ingestFoodToGo", "whatever.x"]) {
      expect(isAllowedForScope("full", p)).toBe(true);
    }
  });

  it("the web scope may call exactly the web routes' procedures and nothing privileged", () => {
    for (const p of WEB_INTERNAL_SCOPE) expect(isAllowedForScope("web", p)).toBe(true);
    for (const p of ["moderation.setUserBanned", "moderation.approveClaim", "credits.grant", "venues.ownerPhotoUrl", "adminActions.setMemberStatus"]) {
      expect(isAllowedForScope("web", p)).toBe(false);
    }
    expect(isAllowedForScope("web", undefined)).toBe(false);
  });

  it("pins the web scope to the ten procedures the web's route handlers call", () => {
    expect([...WEB_INTERNAL_SCOPE].sort()).toEqual([
      "marketing.syncNewUser",
      "places.enrichVenue",
      "places.googleReviews",
      "places.ingestArea",
      "places.ingestCategory",
      "places.ingestFoodToGo",
      "places.searchText",
      "transit.nearbyDepartures",
      "transit.planTrip",
      "transit.searchStops",
    ]);
  });
});
