import { describe, it, expect } from "vitest";
import {
  sanitizeQuery,
  personUrl,
  venueUrl,
  eventUrl,
  topicUrl,
  listingUrl,
  shapePerson,
  shapeVenue,
  shapeEvent,
  shapeTopic,
  shapeListing,
  shapePlan,
  shapeDeal,
  planUrl,
  dealUrl,
} from "./search.js";

/**
 * Unit tests for the PURE search helpers: the ILIKE-wildcard sanitiser (the injection guard the
 * fan-out relies on), the url builders, and the raw→result shaping. The fan-out itself is I/O over
 * world-readable tables (RLS hides unapproved/non-live rows); here we lock the pure surface.
 */

describe("sanitizeQuery", () => {
  it("strips ILIKE/or() wildcards and grouping chars", () => {
    expect(sanitizeQuery("100%")).toBe("100");
    expect(sanitizeQuery("a,b(c)\\d")).toBe("a b c d");
  });
  it("collapses whitespace and trims", () => {
    expect(sanitizeQuery("  the   dog  inn ")).toBe("the dog inn");
  });
  it("empties to '' when nothing usable remains", () => {
    expect(sanitizeQuery("%%%")).toBe("");
    expect(sanitizeQuery("   ")).toBe("");
  });
});

describe("url builders", () => {
  it("prefer the slug/handle, fall back to id", () => {
    expect(personUrl("alex", "u1")).toBe("/u/alex");
    expect(personUrl(null, "u1")).toBe("/u/u1");
    expect(venueUrl("the-dog-inn", "v1")).toBe("/venue/the-dog-inn");
    expect(venueUrl(null, "v1")).toBe("/venue/v1");
    expect(eventUrl("e1")).toBe("/events/e1");
    expect(listingUrl("l1")).toBe("/market/l1");
  });
  it("topic url uses the nested locality/slug path, else the id fallback", () => {
    expect(topicUrl("darlington", "best-coffee", "t1")).toBe("/town-hall/darlington/best-coffee");
    expect(topicUrl("darlington", null, "t1")).toBe("/town-hall/t1");
    expect(topicUrl(null, "best-coffee", "t1")).toBe("/town-hall/t1");
  });
});

describe("shapePerson", () => {
  it("name falls back display name → @handle → Someone", () => {
    expect(shapePerson({ id: "u1", handle: "alex", display_name: "Alex R", avatar_url: null }).name).toBe("Alex R");
    expect(shapePerson({ id: "u1", handle: "alex", display_name: "  ", avatar_url: null }).name).toBe("@alex");
    expect(shapePerson({ id: "u1", handle: null, display_name: null, avatar_url: null }).name).toBe("Someone");
  });
  it("carries the kind discriminator + url", () => {
    const p = shapePerson({ id: "u1", handle: "alex", display_name: "Alex", avatar_url: "x" });
    expect(p.kind).toBe("person");
    expect(p.url).toBe("/u/alex");
  });
});

describe("shapeVenue / shapeEvent / shapeTopic / shapeListing", () => {
  it("venue keeps distance + resolves url via slug", () => {
    const v = shapeVenue({ id: "v1", name: "The Dog", slug: "the-dog", category: "Food & Drink", rating: 4.5, distance_m: 320 });
    expect(v).toMatchObject({ kind: "venue", name: "The Dog", distanceM: 320, url: "/venue/the-dog" });
  });
  it("event carries start + locality + where", () => {
    const e = shapeEvent({ id: "e1", title: "Quiz", starts_at: "2026-08-01T19:00:00Z", locality_label: "Darlington", venue_id: null, location_name: "Market Sq" });
    expect(e).toMatchObject({ kind: "event", title: "Quiz", localityLabel: "Darlington", where: "Market Sq", url: "/events/e1" });
  });
  it("topic builds the nested url", () => {
    const t = shapeTopic({ id: "t1", slug: "best-coffee", locality: "durham", locality_label: "Durham", title: "Best coffee?" });
    expect(t).toMatchObject({ kind: "topic", title: "Best coffee?", url: "/town-hall/durham/best-coffee" });
  });
  it("listing carries price + mode", () => {
    const l = shapeListing({ id: "l1", title: "Bike", price_pence: 12000, mode: "sell", locality: "Durham" });
    expect(l).toMatchObject({ kind: "listing", title: "Bike", pricePence: 12000, mode: "sell", url: "/market/l1" });
  });
  it("plan + deal shape with their urls", () => {
    expect(planUrl("pl1")).toBe("/plans/pl1");
    expect(dealUrl("d1")).toBe("/deals/d1");
    expect(shapePlan({ id: "pl1", title: "Weekend trip" })).toMatchObject({ kind: "plan", title: "Weekend trip", url: "/plans/pl1" });
    expect(shapeDeal({ id: "d1", title: "20% off", advertiser_name: "Acme" })).toMatchObject({ kind: "deal", title: "20% off", merchant: "Acme", url: "/deals/d1" });
  });
});
