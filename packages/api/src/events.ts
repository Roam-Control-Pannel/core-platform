/**
 * Events — PURE helpers for the events router (0099_events.sql).
 *
 * The router itself does I/O (PostgREST + the events_near RPC); everything here is a pure function
 * of its arguments so it's unit-testable without a database: the category vocabulary, the raw→API
 * row shaping, the "trim to null" normaliser, the upcoming-events PostgREST filter clause, and the
 * "an event needs a place" rule. Kept in lockstep with the DB check constraints in 0099.
 */

/** The event categories — app-enforced vocabulary, mirrored by the DB check constraint. */
export const EVENT_CATEGORIES = [
  "music", "nightlife", "food_drink", "arts_culture", "sports_fitness",
  "community", "market_fair", "family", "learning", "other",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export interface AuthorEmbed {
  id: string | null;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
}
export interface VenueEmbed {
  id: string | null;
  name: string | null;
  slug: string | null;
}
export interface RawEvent {
  id: string;
  locality: string;
  locality_label: string;
  title: string;
  description: string | null;
  category: string | null;
  starts_at: string;
  ends_at: string | null;
  venue_id: string | null;
  location_name: string | null;
  lat: number | null;
  lng: number | null;
  url: string | null;
  cover_image_url: string | null;
  interested_count: number;
  status: string;
  created_at: string;
  author: AuthorEmbed | AuthorEmbed[] | null;
  venue: VenueEmbed | VenueEmbed[] | null;
}

/** PostgREST returns a to-one embed as an object, but tolerate an array form too. */
export function one<T>(a: T | T[] | null): T | null {
  return Array.isArray(a) ? a[0] ?? null : a;
}

export function shapeAuthor(a: AuthorEmbed | AuthorEmbed[] | null) {
  const author = one(a);
  return {
    id: author?.id ?? null,
    handle: author?.handle ?? null,
    displayName: author?.display_name ?? null,
    avatarUrl: author?.avatar_url ?? null,
  };
}

export function shapeVenue(v: VenueEmbed | VenueEmbed[] | null) {
  const venue = one(v);
  if (!venue?.id) return null;
  return { id: venue.id, name: venue.name ?? null, slug: venue.slug ?? null };
}

/** Raw DB row → the inline public event shape returned by the router. */
export function shapeEvent(e: RawEvent, viewerInterested: boolean) {
  return {
    id: e.id,
    locality: e.locality,
    localityLabel: e.locality_label,
    title: e.title,
    description: e.description,
    category: e.category,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    venueId: e.venue_id,
    locationName: e.location_name,
    lat: e.lat,
    lng: e.lng,
    url: e.url,
    coverImageUrl: e.cover_image_url,
    interestedCount: e.interested_count,
    status: e.status,
    createdAt: e.created_at,
    author: shapeAuthor(e.author),
    venue: shapeVenue(e.venue),
    viewerInterested,
  };
}

/** Trim to null so an empty optional field clears rather than stores "". */
export function orNull(s: string | undefined | null): string | null {
  const t = s?.trim();
  return t ? t : null;
}

/**
 * PostgREST .or() clause for "upcoming" events at a given now: still running (ends_at >= now) OR,
 * with no explicit end, not yet started (starts_at >= now). Ongoing multi-hour events stay listed.
 */
export function upcomingOrClause(nowIso: string): string {
  return `ends_at.gte.${nowIso},and(ends_at.is.null,starts_at.gte.${nowIso})`;
}

/** An event must be somewhere: a venue OR a free-text place name. */
export function eventHasPlace(venueId: string | undefined | null, locationName: string | undefined | null): boolean {
  return Boolean(venueId) || orNull(locationName) !== null;
}

/** True when ends is strictly before starts (both ISO strings) — an invalid window. */
export function endsBeforeStarts(startsAt: string, endsAt: string | undefined | null): boolean {
  return endsAt != null && endsAt < startsAt;
}
