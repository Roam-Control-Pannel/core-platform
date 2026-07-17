/**
 * Search router — one public "global" endpoint that powers the site-wide search bar. It fans out,
 * in parallel, across every public entity (people, businesses, events, Town Hall, marketplace) and
 * returns compact, grouped, url-carrying results for the typeahead + /search page.
 *
 * Local-first: when the caller passes their browsing origin (lat/lng), businesses ride the
 * distance-ordered venues_search_by_name RPC (30 km) so nearby places rank first; without an origin
 * it falls back to a plain name ILIKE. Every source is independently fault-tolerant — one slow or
 * failing source degrades to [] rather than failing the whole search. Reads are anonymous over
 * world-readable tables (RLS already hides unapproved/non-live rows), so no auth is required.
 *
 * The entity tables aren't in the generated DB types, so the client is loose-typed per call (same
 * idiom as townHall/seo); every resolver returns INLINE shapes so no named type leaks into AppRouter.
 */
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { upcomingOrClause } from "../events.js";
import {
  sanitizeQuery,
  shapePerson,
  shapeVenue,
  shapeEvent,
  shapeTopic,
  shapeListing,
  shapePlan,
  shapeDeal,
  type PersonRow,
  type EventRow,
  type TopicRow,
  type ListingRow,
  type PlanRow,
  type DealRow,
} from "../search.js";

type LooseDb = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: (fn: string, args: Record<string, unknown>) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const EMPTY = { people: [], venues: [], events: [], topics: [], listings: [], plans: [], deals: [] };

export const searchRouter = router({
  /** Public: site-wide search across people, businesses, events, Town Hall and the marketplace. */
  global: publicProcedure
    .input(
      z.object({
        q: z.string().trim().min(2).max(80),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
        limitPer: z.number().int().min(1).max(12).default(6),
      }),
    )
    .query(async ({ ctx, input }) => {
      const term = sanitizeQuery(input.q);
      if (term.length < 2) return { query: "", ...EMPTY };
      const like = `%${term}%`;
      const n = input.limitPer;
      const db = ctx.db as unknown as LooseDb;
      const hasOrigin = input.lat != null && input.lng != null;

      const people = (async () => {
        const { data } = (await db
          .from("profiles")
          .select("id, handle, display_name, avatar_url")
          .or(`display_name.ilike.${like},handle.ilike.${like}`)
          .limit(n)) as { data: PersonRow[] | null };
        return (data ?? []).map(shapePerson);
      })();

      const venues = (async () => {
        if (hasOrigin) {
          const { data } = (await db.rpc("venues_search_by_name", {
            q: term,
            origin_lat: input.lat,
            origin_lng: input.lng,
            max_results: n * 2,
          })) as { data: { id: string; name: string; category: string | null; rating: number | null; business_status: string | null; distance_m: number | null }[] | null };
          return (data ?? [])
            .filter((v) => v.business_status !== "CLOSED_PERMANENTLY")
            .slice(0, n)
            .map((v) => shapeVenue({ id: v.id, name: v.name, slug: null, category: v.category, rating: v.rating, distance_m: v.distance_m }));
        }
        const { data } = (await db
          .from("venues")
          .select("id, name, slug, category, rating, business_status")
          .ilike("name", like)
          .limit(n * 2)) as { data: { id: string; name: string; slug: string | null; category: string | null; rating: number | null; business_status: string | null }[] | null };
        return (data ?? [])
          .filter((v) => v.business_status !== "CLOSED_PERMANENTLY")
          .slice(0, n)
          .map((v) => shapeVenue(v));
      })();

      const events = (async () => {
        const { data } = (await db
          .from("events")
          .select("id, title, starts_at, locality_label, venue_id, location_name")
          .ilike("title", like)
          .eq("status", "published")
          .or(upcomingOrClause(new Date().toISOString()))
          .order("starts_at", { ascending: true })
          .limit(n)) as { data: EventRow[] | null };
        return (data ?? []).map(shapeEvent);
      })();

      const topics = (async () => {
        const { data } = (await db
          .from("town_hall_topics")
          .select("id, slug, locality, locality_label, title")
          .ilike("title", like)
          .order("last_activity_at", { ascending: false })
          .limit(n)) as { data: TopicRow[] | null };
        return (data ?? []).map(shapeTopic);
      })();

      const listings = (async () => {
        const { data } = (await db
          .from("market_listings")
          .select("id, title, price_pence, mode, locality")
          .ilike("title", like)
          .eq("status", "live")
          .order("created_at", { ascending: false })
          .limit(n)) as { data: ListingRow[] | null };
        return (data ?? []).map(shapeListing);
      })();

      // Plans are member-only under RLS, so this returns the caller's OWN matching plans (and none
      // for anonymous callers) — a safe "find my plan" search, never other people's private plans.
      const plans = (async () => {
        const { data } = (await db
          .from("plans")
          .select("id, title")
          .ilike("title", like)
          .order("created_at", { ascending: false })
          .limit(n)) as { data: PlanRow[] | null };
        return (data ?? []).map(shapePlan);
      })();

      // Deals are public; RLS already limits reads to active, in-window rows.
      const deals = (async () => {
        const { data } = (await db
          .from("awin_deals")
          .select("id, title, advertiser_name")
          .ilike("title", like)
          .order("created_at", { ascending: false })
          .limit(n)) as { data: DealRow[] | null };
        return (data ?? []).map(shapeDeal);
      })();

      // Each source is independently fault-tolerant: a failure degrades that group to [].
      const [p, v, e, t, l, pl, d] = await Promise.all([
        people.catch(() => []),
        venues.catch(() => []),
        events.catch(() => []),
        topics.catch(() => []),
        listings.catch(() => []),
        plans.catch(() => []),
        deals.catch(() => []),
      ]);
      return { query: term, people: p, venues: v, events: e, topics: t, listings: l, plans: pl, deals: d };
    }),
});
