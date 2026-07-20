/**
 * Search — PURE helpers for the global search router. The router does the I/O (a parallel fan-out
 * of ILIKE reads + the venues_search_by_name RPC); everything here is a pure function of its
 * arguments so it's unit-testable: query sanitisation (the ILIKE-wildcard guard) and the raw→result
 * shaping (each entity to a compact, url-carrying result object the typeahead + /search page render).
 */

/**
 * Make a user's query safe for an ILIKE '%q%' filter: strip the wildcard/grouping characters that
 * would otherwise be interpreted (%, comma — a PostgREST .or() separator — parens, backslash),
 * collapse whitespace, trim. Returns "" when nothing usable remains (the router then returns empty).
 */
export function sanitizeQuery(q: string): string {
  return q.replace(/[%,()\\]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Split a (already-sanitised) query into meaningful search tokens: lower-cased words, dropping
 * grammatical stopwords + one-character noise. Powers token-AND venue matching so "the duke of
 * york belfast" becomes [duke, york, belfast] — each must appear in the venue's searchable text,
 * instead of the whole phrase having to be one literal substring of the name. Falls back to the
 * caller's behaviour when it returns [] (an all-stopword query).
 */
const SEARCH_STOPWORDS = new Set(["the", "and", "of", "a", "an", "at", "in", "on", "to", "for", "with"]);
export function searchTokens(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !SEARCH_STOPWORDS.has(t));
}

/* ── url builders (kept here so the API returns ready-to-link results) ────────────────────── */

export function personUrl(handle: string | null, id: string): string {
  return `/u/${handle ?? id}`;
}
export function venueUrl(slug: string | null, id: string): string {
  return `/venue/${slug ?? id}`;
}
export function eventUrl(id: string): string {
  return `/events/${id}`;
}
export function topicUrl(locality: string | null, slug: string | null, id: string): string {
  return locality && slug ? `/town-hall/${locality}/${slug}` : `/town-hall/${id}`;
}
export function listingUrl(id: string): string {
  return `/market/${id}`;
}
export function planUrl(id: string): string {
  return `/plans/${id}`;
}
export function dealUrl(id: string): string {
  return `/deals/${id}`;
}
/** A venue offer has no page of its own — it links to its venue (where offers are shown). */
export function offerUrl(venueSlug: string | null, venueId: string): string {
  return `/venue/${venueSlug ?? venueId}`;
}

/* ── raw row → result shapers (inline object literals; no named type leaks into AppRouter) ─── */

export interface PersonRow {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
}
export function shapePerson(r: PersonRow) {
  return {
    kind: "person" as const,
    id: r.id,
    handle: r.handle,
    name: r.display_name?.trim() || (r.handle ? `@${r.handle}` : "Someone"),
    avatarUrl: r.avatar_url,
    url: personUrl(r.handle, r.id),
  };
}

export interface VenueRow {
  id: string;
  name: string;
  slug: string | null;
  category: string | null;
  rating: number | null;
  distance_m?: number | null;
}
export function shapeVenue(r: VenueRow) {
  return {
    kind: "venue" as const,
    id: r.id,
    name: r.name,
    category: r.category,
    rating: r.rating,
    distanceM: r.distance_m ?? null,
    url: venueUrl(r.slug, r.id),
  };
}

export interface EventRow {
  id: string;
  title: string;
  starts_at: string;
  locality_label: string;
  venue_id: string | null;
  location_name: string | null;
}
export function shapeEvent(r: EventRow) {
  return {
    kind: "event" as const,
    id: r.id,
    title: r.title,
    startsAt: r.starts_at,
    localityLabel: r.locality_label,
    where: r.location_name ?? null,
    url: eventUrl(r.id),
  };
}

export interface TopicRow {
  id: string;
  slug: string | null;
  locality: string;
  locality_label: string;
  title: string;
}
export function shapeTopic(r: TopicRow) {
  return {
    kind: "topic" as const,
    id: r.id,
    title: r.title,
    localityLabel: r.locality_label,
    url: topicUrl(r.locality, r.slug, r.id),
  };
}

export interface ListingRow {
  id: string;
  title: string;
  price_pence: number | null;
  mode: string;
  locality: string | null;
}
export function shapeListing(r: ListingRow) {
  return {
    kind: "listing" as const,
    id: r.id,
    title: r.title,
    pricePence: r.price_pence,
    mode: r.mode,
    locality: r.locality,
    url: listingUrl(r.id),
  };
}

export interface PlanRow {
  id: string;
  title: string;
}
export function shapePlan(r: PlanRow) {
  return { kind: "plan" as const, id: r.id, title: r.title, url: planUrl(r.id) };
}

export interface DealRow {
  id: string;
  title: string;
  advertiser_name: string | null;
}
export function shapeDeal(r: DealRow) {
  return { kind: "deal" as const, id: r.id, title: r.title, merchant: r.advertiser_name ?? null, url: dealUrl(r.id) };
}

export interface OfferRow {
  offer_id: string;
  title: string;
  venue_id: string;
  venue_name: string | null;
  venue_slug: string | null;
  locality: string | null;
}
export function shapeOffer(r: OfferRow) {
  return {
    kind: "offer" as const,
    id: r.offer_id,
    title: r.title,
    venueName: r.venue_name,
    locality: r.locality,
    url: offerUrl(r.venue_slug, r.venue_id),
  };
}
