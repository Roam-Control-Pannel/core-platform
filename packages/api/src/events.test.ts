import { describe, it, expect } from "vitest";
import {
  EVENT_CATEGORIES,
  one,
  shapeAuthor,
  shapeVenue,
  shapeEvent,
  orNull,
  upcomingOrClause,
  eventHasPlace,
  endsBeforeStarts,
  type RawEvent,
} from "./events.js";

/**
 * Unit tests for the PURE events helpers: category vocabulary, raw→API row shaping (author/venue
 * embed flattening included), the trim-to-null normaliser, the "upcoming" PostgREST filter clause,
 * and the two create-time validation rules. The friend-agnostic public read boundary is SQL (RLS +
 * events_near, 0099); here we lock the router-side logic that shapes rows and guards writes.
 */

const RAW: RawEvent = {
  id: "e1",
  locality: "darlington",
  locality_label: "Darlington",
  title: "Friday Night Quiz",
  description: "Teams of up to 6.",
  category: "community",
  starts_at: "2026-08-01T19:00:00.000Z",
  ends_at: "2026-08-01T22:00:00.000Z",
  venue_id: "v1",
  location_name: null,
  lat: 54.52,
  lng: -1.55,
  url: "https://example.com/quiz",
  cover_image_url: null,
  interested_count: 4,
  status: "published",
  created_at: "2026-07-17T12:00:00.000Z",
  author: { id: "u1", handle: "alex", display_name: "Alex R", avatar_url: null },
  venue: { id: "v1", name: "The Dog & Duck", slug: "the-dog-and-duck" },
};

describe("EVENT_CATEGORIES", () => {
  it("is the fixed 10-value vocabulary (mirrors the DB check)", () => {
    expect(EVENT_CATEGORIES).toHaveLength(10);
    expect(EVENT_CATEGORIES).toContain("music");
    expect(EVENT_CATEGORIES).toContain("market_fair");
    expect(EVENT_CATEGORIES).toContain("other");
  });
});

describe("one", () => {
  it("returns the first element of an array embed", () => {
    expect(one([{ id: "a" }, { id: "b" }])).toEqual({ id: "a" });
  });
  it("passes an object embed through, and null stays null", () => {
    expect(one({ id: "a" })).toEqual({ id: "a" });
    expect(one(null)).toBeNull();
    expect(one([])).toBeNull();
  });
});

describe("shapeAuthor", () => {
  it("maps snake_case → camelCase, tolerating the array embed form", () => {
    expect(shapeAuthor([{ id: "u1", handle: "alex", display_name: "Alex R", avatar_url: "x" }])).toEqual({
      id: "u1", handle: "alex", displayName: "Alex R", avatarUrl: "x",
    });
  });
  it("all-null for a deleted author", () => {
    expect(shapeAuthor(null)).toEqual({ id: null, handle: null, displayName: null, avatarUrl: null });
  });
});

describe("shapeVenue", () => {
  it("maps an attached venue", () => {
    expect(shapeVenue({ id: "v1", name: "The Dog & Duck", slug: "the-dog-and-duck" })).toEqual({
      id: "v1", name: "The Dog & Duck", slug: "the-dog-and-duck",
    });
  });
  it("null when there's no venue (free-text location event)", () => {
    expect(shapeVenue(null)).toBeNull();
    expect(shapeVenue({ id: null, name: null, slug: null })).toBeNull();
  });
});

describe("shapeEvent", () => {
  it("produces the inline public shape with viewer state and embeds", () => {
    const e = shapeEvent(RAW, true);
    expect(e.id).toBe("e1");
    expect(e.localityLabel).toBe("Darlington");
    expect(e.startsAt).toBe("2026-08-01T19:00:00.000Z");
    expect(e.interestedCount).toBe(4);
    expect(e.viewerInterested).toBe(true);
    expect(e.author.handle).toBe("alex");
    expect(e.venue).toEqual({ id: "v1", name: "The Dog & Duck", slug: "the-dog-and-duck" });
  });
  it("carries a free-text location and null venue through", () => {
    const e = shapeEvent({ ...RAW, venue_id: null, venue: null, location_name: "Market Square" }, false);
    expect(e.venue).toBeNull();
    expect(e.locationName).toBe("Market Square");
    expect(e.viewerInterested).toBe(false);
  });
});

describe("orNull", () => {
  it("trims, and empties/whitespace/null/undefined → null", () => {
    expect(orNull("  hi  ")).toBe("hi");
    expect(orNull("   ")).toBeNull();
    expect(orNull("")).toBeNull();
    expect(orNull(null)).toBeNull();
    expect(orNull(undefined)).toBeNull();
  });
});

describe("upcomingOrClause", () => {
  it("keeps still-running events and no-end future events, at a fixed now", () => {
    const now = "2026-07-17T12:00:00.000Z";
    expect(upcomingOrClause(now)).toBe(
      "ends_at.gte.2026-07-17T12:00:00.000Z,and(ends_at.is.null,starts_at.gte.2026-07-17T12:00:00.000Z)",
    );
  });
});

describe("eventHasPlace", () => {
  it("true with a venue id, or a non-empty location name", () => {
    expect(eventHasPlace("v1", null)).toBe(true);
    expect(eventHasPlace(undefined, "Market Square")).toBe(true);
  });
  it("false with neither (empty/whitespace location counts as none)", () => {
    expect(eventHasPlace(undefined, undefined)).toBe(false);
    expect(eventHasPlace(null, "   ")).toBe(false);
  });
});

describe("endsBeforeStarts", () => {
  it("true only when an end is strictly before the start", () => {
    expect(endsBeforeStarts("2026-08-01T20:00:00Z", "2026-08-01T19:00:00Z")).toBe(true);
    expect(endsBeforeStarts("2026-08-01T19:00:00Z", "2026-08-01T22:00:00Z")).toBe(false);
    expect(endsBeforeStarts("2026-08-01T19:00:00Z", null)).toBe(false);
    expect(endsBeforeStarts("2026-08-01T19:00:00Z", undefined)).toBe(false);
  });
});
