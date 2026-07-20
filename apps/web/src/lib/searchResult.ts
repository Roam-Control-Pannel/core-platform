/**
 * Search result shapes + label helpers, shared by the TopBar typeahead (GlobalSearch) and the
 * /search results page (SearchResults). Mirrors the inline shapes returned by search.global; the
 * label/secondary helpers keep both surfaces rendering each result kind identically.
 */

export interface SearchPerson {
  kind: "person";
  id: string;
  handle: string | null;
  name: string;
  avatarUrl: string | null;
  url: string;
}
export interface SearchVenue {
  kind: "venue";
  id: string;
  name: string;
  category: string | null;
  rating: number | null;
  distanceM: number | null;
  url: string;
}
export interface SearchEvent {
  kind: "event";
  id: string;
  title: string;
  startsAt: string;
  localityLabel: string;
  where: string | null;
  url: string;
}
export interface SearchTopic {
  kind: "topic";
  id: string;
  title: string;
  localityLabel: string;
  url: string;
}
export interface SearchListing {
  kind: "listing";
  id: string;
  title: string;
  pricePence: number | null;
  mode: string;
  locality: string | null;
  url: string;
}

export interface SearchPlan {
  kind: "plan";
  id: string;
  title: string;
  url: string;
}
export interface SearchDeal {
  kind: "deal";
  id: string;
  title: string;
  merchant: string | null;
  url: string;
}
export interface SearchOffer {
  kind: "offer";
  id: string;
  title: string;
  venueName: string | null;
  locality: string | null;
  url: string;
}

export interface SearchResultsData {
  query: string;
  people: SearchPerson[];
  venues: SearchVenue[];
  events: SearchEvent[];
  topics: SearchTopic[];
  listings: SearchListing[];
  plans: SearchPlan[];
  offers: SearchOffer[];
  deals: SearchDeal[];
}

export const EMPTY_RESULTS: SearchResultsData = { query: "", people: [], venues: [], events: [], topics: [], listings: [], plans: [], offers: [], deals: [] };

/** Total hits across all groups (drives the "no results" state + the tab counts). */
export function totalCount(r: SearchResultsData): number {
  return (
    r.people.length + r.venues.length + r.events.length + r.topics.length +
    r.listings.length + r.plans.length + r.offers.length + r.deals.length
  );
}

/** "£120" / "Free" / "Swap" — the marketplace price word. */
export function listingPrice(pricePence: number | null, mode: string): string {
  if (mode === "free") return "Free";
  if (mode === "swap") return "Swap";
  return pricePence != null ? `£${(pricePence / 100).toFixed(pricePence % 100 === 0 ? 0 : 2)}` : "For sale";
}

/** Rounded distance for a venue result: "320 m" / "2.4 km". Null when unknown (non-local search). */
export function distanceLabel(distanceM: number | null): string | null {
  if (distanceM == null) return null;
  return distanceM < 1000 ? `${Math.round(distanceM)} m` : `${(distanceM / 1000).toFixed(1)} km`;
}
