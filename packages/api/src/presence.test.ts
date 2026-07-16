import { describe, it, expect } from "vitest";
import {
  normaliseNote,
  buildPresenceRow,
  isLive,
  NOTE_MAX,
  DEFAULT_TTL_HOURS,
  type PresenceRow,
} from "./presence.js";

/**
 * Unit tests for the PURE presence rules: note normalisation, the clear-vs-set row shape (with an
 * injected clock so expiry maths is deterministic), and the "is this status still live?" gate. The
 * friend-only boundary itself is SQL (RLS + friends_availability definer, migration 0092) and is
 * proven live; here we lock the router-side logic that shapes and expires a status.
 */

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const HOUR = 3_600_000;

describe("normaliseNote", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normaliseNote("  Free   for\ta coffee  ")).toBe("Free for a coffee");
  });
  it("empty / whitespace / null / undefined → null", () => {
    expect(normaliseNote("   ")).toBeNull();
    expect(normaliseNote("")).toBeNull();
    expect(normaliseNote(null)).toBeNull();
    expect(normaliseNote(undefined)).toBeNull();
  });
  it("caps at NOTE_MAX characters", () => {
    expect(normaliseNote("x".repeat(NOTE_MAX + 40))).toHaveLength(NOTE_MAX);
  });
});

describe("buildPresenceRow — setting a status", () => {
  it("stamps expiry = now + default ttl when no ttl given", () => {
    const row = buildPresenceRow("u1", { availability: "free_to_meet", note: "Coffee?" }, NOW);
    expect(row.profile_id).toBe("u1");
    expect(row.availability).toBe("free_to_meet");
    expect(row.note).toBe("Coffee?");
    expect(row.expires_at).toBe(new Date(NOW + DEFAULT_TTL_HOURS * HOUR).toISOString());
    expect(row.updated_at).toBe(new Date(NOW).toISOString());
  });
  it("honours an explicit ttlHours", () => {
    const row = buildPresenceRow("u1", { availability: "out_and_about", ttlHours: 2 }, NOW);
    expect(row.expires_at).toBe(new Date(NOW + 2 * HOUR).toISOString());
  });
  it("normalises the note (empty → null)", () => {
    const row = buildPresenceRow("u1", { availability: "heads_down", note: "   " }, NOW);
    expect(row.note).toBeNull();
  });
});

describe("buildPresenceRow — clearing a status", () => {
  it("null availability nulls note AND expiry regardless of inputs", () => {
    const row = buildPresenceRow("u1", { availability: null, note: "still here", ttlHours: 9 }, NOW);
    expect(row.availability).toBeNull();
    expect(row.note).toBeNull();
    expect(row.expires_at).toBeNull();
    expect(row.updated_at).toBe(new Date(NOW).toISOString());
  });
});

describe("isLive", () => {
  const live: PresenceRow = {
    profile_id: "u1",
    availability: "free_to_meet",
    note: null,
    expires_at: new Date(NOW + HOUR).toISOString(),
    updated_at: new Date(NOW).toISOString(),
  };
  it("true while set and expiry is in the future", () => {
    expect(isLive(live, NOW)).toBe(true);
  });
  it("false once expiry has elapsed", () => {
    expect(isLive(live, NOW + 2 * HOUR)).toBe(false);
  });
  it("false exactly at expiry (boundary is not live)", () => {
    expect(isLive(live, NOW + HOUR)).toBe(false);
  });
  it("false when availability is null (cleared), even with a future expiry", () => {
    expect(isLive({ ...live, availability: null }, NOW)).toBe(false);
  });
  it("true when set with no expiry at all", () => {
    expect(isLive({ ...live, expires_at: null }, NOW)).toBe(true);
  });
});
