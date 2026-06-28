/**
 * Geo router — place search (geocoding) for the place switcher.
 *
 * One procedure: `search`. The web place switcher sends a typed query (town name or postcode)
 * and gets back selectable place centres. PUBLIC: browsing — and choosing where to browse —
 * needs no account, same posture as venues.near.
 *
 * COST/POLICY CONTROL: the upstream (Nominatim) is free but rate-limited by policy, so a
 * process cache fronts it — repeated/auto-complete queries for the same string resolve from
 * memory instead of re-hitting the provider. Geocodes are stable, so the TTL is long (a day).
 * The single-replica caveat is the same as venues' photo-url cache; move to a shared cache if
 * the api ever scales horizontally.
 *
 * RETURN TYPE: the resolver builds inline-typed objects (no named interface) so the inferred
 * AppRouter output is an anonymous structural type — same idiom as venues.near. A named result
 * type would leak through a non-portable @roam/api (or @roam/core) internal path (TS2883/4023).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc.js";
import { geocodeSearch } from "../geocode/client.js";

/** A cached search result — the SAME inline shape the resolver returns (kept in lockstep). */
type CachedSearch = {
  results: { id: string; name: string; hint?: string; lat: number; lng: number }[];
  expires: number;
};

const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000; // a day — geocodes don't move
const MAX_CACHE_ENTRIES = 500; // soft bound; cleared wholesale when exceeded
const geocodeCache = new Map<string, CachedSearch>();

export const geoRouter = router({
  /** Public: geocode a town name or postcode to selectable place centres (cached). */
  search: publicProcedure
    .input(z.object({ q: z.string().trim().min(2).max(120) }))
    .query(async ({ input }) => {
      const key = input.q.toLowerCase().replace(/\s+/g, " ").trim();
      const cached = geocodeCache.get(key);
      if (cached && cached.expires > Date.now()) return cached.results;

      let results: CachedSearch["results"];
      try {
        const raw = await geocodeSearch(input.q);
        results = raw.map((r) => {
          // Inline-typed object (not a named interface) keeps the inferred output structural.
          const place: { id: string; name: string; hint?: string; lat: number; lng: number } = {
            id: r.id,
            name: r.name,
            lat: r.lat,
            lng: r.lng,
          };
          if (r.hint !== undefined) place.hint = r.hint;
          return place;
        });
      } catch (e) {
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: e instanceof Error ? e.message : "Place search failed.",
        });
      }

      // Crude size bound: a wholesale clear is fine for a long-TTL, low-churn cache.
      if (geocodeCache.size >= MAX_CACHE_ENTRIES) geocodeCache.clear();
      geocodeCache.set(key, { results, expires: Date.now() + GEOCODE_TTL_MS });
      return results;
    }),
});
