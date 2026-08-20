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
import { getMarket, marketForCoords, normalizeCountryCode } from "@roam/core/markets";

/** A cached search result — the SAME inline shape the resolver returns (kept in lockstep). */
type CachedSearch = {
  results: { id: string; name: string; hint?: string; lat: number; lng: number }[];
  expires: number;
};

const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000; // a day — geocodes don't move
const MAX_CACHE_ENTRIES = 500; // soft bound; cleared wholesale when exceeded
const geocodeCache = new Map<string, CachedSearch>();

export const geoRouter = router({
  /** Public: geocode a town name or postcode to selectable place centres (cached).
   *  `region` fences results to a channel's area (e.g. "ni" for the Food to Go storefront) so
   *  only Northern Ireland places come back; omitted for Roam's worldwide search. */
  search: publicProcedure
    .input(z.object({ q: z.string().trim().min(2).max(120), region: z.enum(["ni"]).optional() }))
    .query(async ({ input }) => {
      // Region is part of the cache key: an "ni"-fenced result set must never satisfy an
      // unfenced query (or another region), and vice versa.
      const key = `${input.region ?? "all"}:${input.q.toLowerCase().replace(/\s+/g, " ").trim()}`;
      const cached = geocodeCache.get(key);
      if (cached && cached.expires > Date.now()) return cached.results;

      let results: CachedSearch["results"];
      try {
        const raw = await geocodeSearch(input.q, undefined, input.region ? { region: input.region } : {});
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

  /**
   * Public: resolve a visitor's MARKET (country) from an ISO country code and/or a coordinate.
   * Prefers the ISO code (from the host edge headers); falls back to a bounding-box match on the
   * coordinate. `known:false` means we don't operate a registered market there yet — the caller
   * should show the seeding / pioneer experience (never UK content), NOT a default-market fallback.
   *
   * Return is inline-typed (not @roam/core's `Market`) so the inferred AppRouter output stays
   * portable — same rule as `search` above (a named core type would leak a non-portable path).
   */
  market: publicProcedure
    .input(
      z.object({
        country: z.string().trim().length(2).optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
      }),
    )
    .query(({ input }) => {
      const m =
        getMarket(input.country) ??
        (input.lat != null && input.lng != null ? marketForCoords(input.lat, input.lng) : undefined);
      const countryCode = normalizeCountryCode(input.country) ?? m?.code ?? null;

      // One uniform, inline shape for both known and unknown markets (nullable metadata), so the
      // client reads a single descriptor and branches on `known`.
      const out: {
        known: boolean;
        countryCode: string | null;
        name: string | null;
        currency: string | null;
        units: "metric" | "imperial";
        status: "live" | "seeding";
        defaultPlace: { name: string; hint?: string; lat: number; lng: number } | null;
      } = {
        known: m !== undefined,
        countryCode,
        name: m?.name ?? null,
        currency: m?.currency ?? null,
        units: m?.units ?? "metric",
        status: m?.status ?? "seeding",
        defaultPlace: null,
      };
      if (m) {
        const place: { name: string; hint?: string; lat: number; lng: number } = {
          name: m.defaultPlace.name,
          lat: m.defaultPlace.lat,
          lng: m.defaultPlace.lng,
        };
        if (m.defaultPlace.hint !== undefined) place.hint = m.defaultPlace.hint;
        out.defaultPlace = place;
      }
      return out;
    }),
});
