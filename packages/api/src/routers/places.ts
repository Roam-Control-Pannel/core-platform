/**
 * Places router — on-demand venue supply from Google Places (New).
 *
 * One procedure: ingestCategory. A category-pill tap (server-side, via the consumer
 * web backend or an edge function) asks "fill venues for this category near here".
 *
 * WHY internalProcedure: there is deliberately no user/anon insert path on venues
 * (only venues_read SELECT + venues_owner_update for owners). Venue SUPPLY is a
 * server-to-server action that needs the service client (RLS-bypass), and paid Places
 * calls must not be triggerable directly by anonymous users. So this gate requires the
 * x-internal-call secret and uses ctx.service — same posture as venues.approveClaim.
 *
 * ARCHITECTURE — pure core, thin shell (same principle as @roam/core vs the routers):
 * the orchestration (freshness check -> conditional fetch -> classify/filter -> upsert)
 * is the PURE function ingestCategoryCore, which takes its two collaborators (an rpc
 * caller and a Places fetcher) as plain arguments. No tRPC, no middleware, no client
 * construction — so it is fully unit-testable in CI with both collaborators faked. The
 * procedure is a thin wrapper that resolves ctx.service.rpc + the env key and delegates.
 * The internalProcedure middleware REBUILDS ctx.service (escalateToService), so a fake
 * service cannot be injected through context — extracting the core is what makes this
 * testable without a live DB. The real rpc calls are proven live once.
 *
 * THE FLOW (cost-controlled, on-demand-with-cache):
 *   1. Freshness check: count_fresh_places_venues — fresh google_places venues of this
 *      category within radius? If yes, SKIP the paid fetch (the cost control).
 *   2. Otherwise searchNearby (Places New), map each result through the PURE core
 *      helpers (placeToVenueRow + classifyPlaceTypes), DROP nulls and category
 *      mismatches, then upsert_place_venues in one batch RPC.
 *   3. Return a tally: skipped | fetched | inserted | claimedSkipped.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { places as corePlaces } from "@roam/core";
import { router, internalProcedure } from "../trpc.js";
import {
  searchNearby as defaultSearchNearby,
  searchText as defaultSearchText,
  getPlaceDetails as defaultGetPlaceDetails,
  getPlaceReviews as defaultGetPlaceReviews,
  type FetchImpl,
} from "../places/client.js";

/**
 * The staleness window (30 days, the Places New ToS content-cache ceiling) lives INSIDE
 * count_fresh_places_venues, not here — passing an interval across PostgREST RPC
 * resolution fails, and the window is a fixed policy constant, not a per-call input.
 */

/** Default search radius in metres (urban high-street scale). Tunable per call. */
const DEFAULT_RADIUS_M = 1500;

/**
 * The starter category set pulled when a user lands on a FRESH location (the demand-driven
 * "discover this area" path, ingestArea). A curated few — not all nine — so a brand-new place
 * populates meaningfully without 9× the Places cost; the remaining categories still ingest
 * on-demand when their pill is tapped. Each still passes the per-category freshness + budget
 * + rate-limit guards, so a covered area or an exhausted budget pays nothing here.
 */
const STARTER_CATEGORIES: readonly corePlaces.CategoryId[] = ["Food & Drink", "Entertainment & Recreation", "Shopping"];

/** Places caps searchNearby at 20 results per call; we request a sensible page. */
const MAX_RESULTS = 20;

/** The nine canonical category groups, as a Zod enum sourced from core's taxonomy. */
const categoryEnum = z.enum(
  corePlaces.CATEGORIES as unknown as [string, ...string[]],
);

/** A widened rpc() surface — the 0016 functions aren't in generated DB types. Same idiom as venues. */
export type LooseRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;

/** Row shape returned by upsert_place_venues (migration 0016). Keep in sync with the function. */
interface UpsertRow {
  out_id: string;
  out_source_ref: string;
  out_was_claimed: boolean;
}

/** A Places fetcher with the searchNearby signature — injected so tests fake it. */
export type SearchNearbyFn = (
  params: Parameters<typeof defaultSearchNearby>[0],
  apiKey: string,
  fetchImpl?: FetchImpl,
) => Promise<corePlaces.PlaceResult[]>;

/** Inputs to the pure orchestration (already validated by the procedure's Zod schema). */
export interface IngestArgs {
  lat: number;
  lng: number;
  category: corePlaces.CategoryId;
  radiusMetres: number;
  /**
   * Opaque per-client key (the forwarded browser IP) for the per-client fetch limit, or
   * null when none was forwarded (e.g. local dev) — then only the global budget applies.
   * NOT a procedure input: it comes from the request context, so a caller can't spoof it.
   */
  clientKey: string | null;
}

/** The tally returned by an ingest run. Internal — NOT exported, so its name never
 *  leaks into the AppRouter inferred type that client packages consume (TS2883). */
type IngestResult = {
  skipped: boolean;
  reason:
    | "fresh-coverage"
    | "no-matching-places"
    | "ingested"
    | "budget-exhausted"
    | "rate-limited";
  freshCount: number;
  fetched: number;
  inserted: number;
  claimedSkipped: number;
  photosUpserted: number;
}

/** One element of the upsert_venue_photos payload: a venue and its mapped photo rows. */
interface PhotoPayloadEntry {
  venue_id: string;
  photos: (corePlaces.PlacePhoto & { position: number })[];
}

/**
 * PURE orchestration. Takes its collaborators explicitly: rpc (the service client's
 * rpc, bound) and searchNearby (the Places fetcher). No tRPC, no client building, no
 * middleware — unit-testable in CI with both faked. Throws a plain Error on an rpc
 * failure; the procedure maps it to a TRPCError.
 */
export async function ingestCategoryCore(
  rpc: LooseRpc,
  searchNearby: SearchNearbyFn,
  apiKey: string,
  args: IngestArgs,
): Promise<IngestResult> {
  // (0) SPATIAL cost bound: snap the query point to the ingest grid, used for BOTH the
  // freshness check and the searchNearby centre. Two requests in the same cell collapse to
  // one point, so jittered/enumerated coordinates hit the freshness cache instead of paying
  // for a fetch. The snapped centre stays well within the search radius (see core comment).
  const snapped = corePlaces.snapToIngestGrid(args.lat, args.lng);

  // (1) Freshness check — skip the paid call if we already have fresh coverage.
  const { data: freshData, error: freshErr } = await rpc("count_fresh_places_venues", {
    lat: snapped.lat,
    lng: snapped.lng,
    radius_m: args.radiusMetres,
    cat: args.category,
  });
  if (freshErr) throw new Error(`Freshness check failed: ${freshErr.message}`);

  const freshCount = typeof freshData === "number" ? freshData : Number(freshData ?? 0);
  if (freshCount > 0) {
    return {
      skipped: true,
      reason: "fresh-coverage",
      freshCount,
      fetched: 0,
      inserted: 0,
      claimedSkipped: 0,
      photosUpserted: 0,
    };
  }

  // (1b) VOLUME cost bound: claim one unit of the global daily budget AND the per-client
  // window BEFORE paying for the fetch. This runs only on a freshness MISS, so one claim ==
  // one intended paid call. A denial is non-fatal: we return a skipped result and the caller
  // reads whatever supply already exists (browsing is never blocked on supply).
  const { data: quotaData, error: quotaErr } = await rpc("claim_places_fetch_quota", {
    p_client_key: args.clientKey,
    p_daily_cap: corePlaces.PLACES_DAILY_FETCH_BUDGET,
    p_client_cap: corePlaces.PLACES_CLIENT_FETCH_LIMIT,
    p_client_window_secs: corePlaces.PLACES_CLIENT_WINDOW_SECS,
  });
  if (quotaErr) throw new Error(`Fetch-quota check failed: ${quotaErr.message}`);
  // The function returns a single-row table -> PostgREST yields an array of one row.
  const quota = (Array.isArray(quotaData) ? quotaData[0] : quotaData) as
    | { allowed?: boolean; reason?: string }
    | undefined;
  if (!quota?.allowed) {
    return {
      skipped: true,
      reason: quota?.reason === "client-rate" ? "rate-limited" : "budget-exhausted",
      freshCount: 0,
      fetched: 0,
      inserted: 0,
      claimedSkipped: 0,
      photosUpserted: 0,
    };
  }

  // (2) Fetch from Places (New).
  const results = await searchNearby(
    {
      lat: snapped.lat,
      lng: snapped.lng,
      includedTypes: corePlaces.categoryToPlacesTypes(args.category),
      radiusMetres: args.radiusMetres,
      maxResultCount: MAX_RESULTS,
    },
    apiKey,
  );

  // Keep each result paired with the venue row it produces, so the raw PlaceResult
  // (which carries photos) survives to the photo-write step. Venue-row logic unchanged:
  // classify -> placeToVenueRow -> drop nulls/mismatches.
  const matched: { place: corePlaces.PlaceResult; row: corePlaces.VenueRowFromPlace }[] =
    [];
  for (const p of results) {
    if (corePlaces.classifyPlaceTypes(p.types ?? []) !== args.category) continue;
    const row = corePlaces.placeToVenueRow(p, args.category);
    if (row === null) continue;
    matched.push({ place: p, row });
  }

  const rows = matched.map((m) => m.row);

  if (rows.length === 0) {
    return {
      skipped: false,
      reason: "no-matching-places",
      freshCount: 0,
      fetched: results.length,
      inserted: 0,
      claimedSkipped: 0,
      photosUpserted: 0,
    };
  }

  // (3) One batch upsert. Idempotent on (source, source_ref); claimed rows frozen.
  const { data: upsertData, error: upsertErr } = await rpc("upsert_place_venues", {
    places: rows,
  });
  if (upsertErr) throw new Error(`Venue upsert failed: ${upsertErr.message}`);

  const upserted = (upsertData ?? []) as UpsertRow[];
  const claimedSkipped = upserted.filter((r) => r.out_was_claimed).length;

  // (4) Photos (google_places provenance). Map source_ref -> venue_id for venues that
  // were upserted AND are NOT claimed (claimed venues' photos stay frozen, parity with
  // claimed hours). Map each matched result's raw photos through the pure core helper,
  // stamping array order as `position`. One batch replace-all RPC.
  const unclaimedVenueId = new Map<string, string>();
  for (const u of upserted) {
    if (!u.out_was_claimed) unclaimedVenueId.set(u.out_source_ref, u.out_id);
  }

  const photoPayload: PhotoPayloadEntry[] = [];
  for (const m of matched) {
    const venueId = unclaimedVenueId.get(m.place.id);
    if (!venueId) continue; // claimed or not upserted — photos frozen/absent
    const photos = corePlaces
      .placePhotos(m.place)
      .map((ph, i) => ({ ...ph, position: i }));
    photoPayload.push({ venue_id: venueId, photos });
  }

  let photosUpserted = 0;
  if (photoPayload.length > 0) {
    const { data: photoData, error: photoErr } = await rpc("upsert_venue_photos", {
      payload: photoPayload,
    });
    if (photoErr) throw new Error(`Photo upsert failed: ${photoErr.message}`);
    photosUpserted = typeof photoData === "number" ? photoData : Number(photoData ?? 0);
  }

  return {
    skipped: false,
    reason: "ingested",
    freshCount: 0,
    fetched: results.length,
    inserted: upserted.length - claimedSkipped,
    claimedSkipped,
    photosUpserted,
  };
}

/** Seam for the production fetcher. */
const productionSearchNearby: SearchNearbyFn = defaultSearchNearby;

/* ── Text search (find a venue by name, then ingest it) ──────────────────────────────────── */

/** A Places text-search fetcher with the searchText signature — injected so tests fake it. */
export type SearchTextFn = (
  params: Parameters<typeof defaultSearchText>[0],
  apiKey: string,
  fetchImpl?: FetchImpl,
) => Promise<corePlaces.PlaceResult[]>;

const productionSearchText: SearchTextFn = defaultSearchText;

/** Bias radius for text search — wide, because the town-centre geocode is approximate and a
 *  named venue a few miles off-centre must still be found (locationBias ranks nearby first). */
const TEXT_SEARCH_BIAS_M = 25_000;

export interface TextSearchArgs {
  query: string;
  lat: number;
  lng: number;
  clientKey: string | null;
}

type TextSearchResult = {
  ingested: number;
  skipped: boolean;
  reason: "ingested" | "no-matching-places" | "budget-exhausted" | "rate-limited";
};

/**
 * PURE orchestration for the text-search fall-through: claim budget, fetch Places Text Search
 * for the typed query, classify + map each result to a venue row, upsert (+ photos). Same
 * collaborators-injected, tRPC-free shape as ingestCategoryCore, so it unit-tests with fakes.
 *
 * NB: there is no freshness/grid cache here (a free-text query doesn't map to a spatial cell) —
 * the DB-first check lives in the PROCEDURE (it reads venues_search_by_name and only calls this
 * when the DB has no name match), so reaching this function already means an intended paid call.
 * The budget + per-client rate claim is still enforced here as the hard wallet backstop.
 */
export async function ingestTextSearchCore(
  rpc: LooseRpc,
  searchText: SearchTextFn,
  apiKey: string,
  args: TextSearchArgs,
): Promise<TextSearchResult> {
  const { data: quotaData, error: quotaErr } = await rpc("claim_places_fetch_quota", {
    p_client_key: args.clientKey,
    p_daily_cap: corePlaces.PLACES_DAILY_FETCH_BUDGET,
    p_client_cap: corePlaces.PLACES_CLIENT_FETCH_LIMIT,
    p_client_window_secs: corePlaces.PLACES_CLIENT_WINDOW_SECS,
  });
  if (quotaErr) throw new Error(`Fetch-quota check failed: ${quotaErr.message}`);
  const quota = (Array.isArray(quotaData) ? quotaData[0] : quotaData) as
    | { allowed?: boolean; reason?: string }
    | undefined;
  if (!quota?.allowed) {
    return { ingested: 0, skipped: true, reason: quota?.reason === "client-rate" ? "rate-limited" : "budget-exhausted" };
  }

  const results = await searchText(
    { textQuery: args.query, lat: args.lat, lng: args.lng, radiusMetres: TEXT_SEARCH_BIAS_M, maxResultCount: MAX_RESULTS },
    apiKey,
  );

  // Classify each result to a category (drop unclassifiable), then map to a venue row.
  const matched: { place: corePlaces.PlaceResult; row: corePlaces.VenueRowFromPlace }[] = [];
  for (const p of results) {
    const category = corePlaces.classifyPlaceTypes(p.types ?? []);
    if (category === null) continue;
    const row = corePlaces.placeToVenueRow(p, category);
    if (row === null) continue;
    matched.push({ place: p, row });
  }
  if (matched.length === 0) return { ingested: 0, skipped: false, reason: "no-matching-places" };

  const { data: upsertData, error: upsertErr } = await rpc("upsert_place_venues", {
    places: matched.map((m) => m.row),
  });
  if (upsertErr) throw new Error(`Venue upsert failed: ${upsertErr.message}`);
  const upserted = (upsertData ?? []) as UpsertRow[];

  // Photos for the unclaimed upserts (claimed venues' photos stay frozen), same as category ingest.
  const unclaimedVenueId = new Map<string, string>();
  for (const u of upserted) if (!u.out_was_claimed) unclaimedVenueId.set(u.out_source_ref, u.out_id);
  const photoPayload: PhotoPayloadEntry[] = [];
  for (const m of matched) {
    const venueId = unclaimedVenueId.get(m.place.id);
    if (!venueId) continue;
    photoPayload.push({ venue_id: venueId, photos: corePlaces.placePhotos(m.place).map((ph, i) => ({ ...ph, position: i })) });
  }
  if (photoPayload.length > 0) {
    const { error: photoErr } = await rpc("upsert_venue_photos", { payload: photoPayload });
    if (photoErr) throw new Error(`Photo upsert failed: ${photoErr.message}`);
  }

  return { ingested: upserted.length, skipped: false, reason: "ingested" };
}

/* ── On-demand venue enrichment (fetch the rich Place Details facts) ──────────────────────── */

/** A Place Details fetcher with getPlaceDetails' signature — injected so tests fake it. */
export type GetDetailsFn = (
  placeId: string,
  apiKey: string,
  fetchImpl?: FetchImpl,
) => Promise<corePlaces.PlaceResult>;

const productionGetDetails: GetDetailsFn = defaultGetPlaceDetails;

export interface EnrichArgs {
  /** The venue row's id — the write target. */
  venueId: string;
  /** The venue's Places id (venues.source_ref) — the Details lookup key. */
  placeId: string;
  clientKey: string | null;
}

type EnrichResult = {
  enriched: boolean;
  reason: "enriched" | "budget-exhausted" | "rate-limited";
  /** The rich facts written (so the caller can hand them straight back to the client), or null. */
  fields:
    | {
        phone: string | null;
        website_url: string | null;
        price_range: corePlaces.PlaceRichFields["price_range"];
        attributes: corePlaces.PlaceRichFields["attributes"];
      }
    | null;
};

/**
 * PURE orchestration for on-demand enrichment: claim the DETAILS budget, pull one Place Details
 * for the venue's place id, extract the rich facts (phone/website/price range/attributes), and
 * write them via apply_venue_details (which no-ops if the venue got claimed or was enriched in
 * the meantime). Same collaborators-injected, tRPC-free shape as the ingest cores, so it
 * unit-tests with fakes. The ELIGIBILITY check (google_places, unclaimed, never enriched) lives
 * in the PROCEDURE — reaching this function already means an intended paid Details call, so the
 * budget claim here is the hard wallet backstop.
 */
export async function enrichVenueCore(
  rpc: LooseRpc,
  getDetails: GetDetailsFn,
  apiKey: string,
  args: EnrichArgs,
): Promise<EnrichResult> {
  const { data: quotaData, error: quotaErr } = await rpc("claim_places_detail_quota", {
    p_client_key: args.clientKey,
    p_daily_cap: corePlaces.PLACES_DETAILS_DAILY_BUDGET,
    p_client_cap: corePlaces.PLACES_CLIENT_FETCH_LIMIT,
    p_client_window_secs: corePlaces.PLACES_CLIENT_WINDOW_SECS,
  });
  if (quotaErr) throw new Error(`Detail-quota check failed: ${quotaErr.message}`);
  const quota = (Array.isArray(quotaData) ? quotaData[0] : quotaData) as
    | { allowed?: boolean; reason?: string }
    | undefined;
  if (!quota?.allowed) {
    return { enriched: false, reason: quota?.reason === "client-rate" ? "rate-limited" : "budget-exhausted", fields: null };
  }

  const place = await getDetails(args.placeId, apiKey);
  const rich = corePlaces.placeRichFields(place);

  const { error: writeErr } = await rpc("apply_venue_details", {
    p_venue_id: args.venueId,
    p_phone: rich.phone,
    p_website: rich.website_url,
    p_price_range: rich.price_range,
    p_attributes: rich.attributes,
  });
  if (writeErr) throw new Error(`Venue detail write failed: ${writeErr.message}`);

  return {
    enriched: true,
    reason: "enriched",
    fields: {
      phone: rich.phone,
      website_url: rich.website_url,
      price_range: rich.price_range,
      attributes: rich.attributes,
    },
  };
}

export const placesRouter = router({
  /**
   * Internal: fill venues for a category near a point, on demand, deduped.
   * Thin wrapper — resolves the service rpc + env key and delegates to the pure core.
   */
  ingestCategory: internalProcedure
    .input(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        category: categoryEnum,
        radiusMetres: z.number().int().min(100).max(50_000).default(DEFAULT_RADIUS_M),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rpc = ctx.service.rpc.bind(ctx.service) as unknown as LooseRpc;
      try {
        return await ingestCategoryCore(rpc, productionSearchNearby, ctx.env.places.apiKey, {
          lat: input.lat,
          lng: input.lng,
          category: input.category as corePlaces.CategoryId,
          radiusMetres: input.radiusMetres,
          // From context (the web route forwards the browser IP), never client input.
          clientKey: ctx.clientKey,
        });
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Ingestion failed.",
        });
      }
    }),

  /**
   * Internal: "discover this area" — the demand-driven pull when a user lands on a FRESH
   * location (sparse/empty coverage). Ingests the STARTER_CATEGORIES for the point under the
   * same freshness + budget + rate-limit guards (each category claims its own budget unit only
   * on a freshness miss). One category failing does not abort the rest. Returns an aggregate
   * tally the web uses to decide whether to re-read or surface "we're expanding".
   */
  ingestArea: internalProcedure
    .input(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radiusMetres: z.number().int().min(100).max(50_000).default(DEFAULT_RADIUS_M),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rpc = ctx.service.rpc.bind(ctx.service) as unknown as LooseRpc;
      let inserted = 0;
      let budgetExhausted = false;
      let rateLimited = false;
      for (const category of STARTER_CATEGORIES) {
        try {
          const tally = await ingestCategoryCore(rpc, productionSearchNearby, ctx.env.places.apiKey, {
            lat: input.lat,
            lng: input.lng,
            category,
            radiusMetres: input.radiusMetres,
            clientKey: ctx.clientKey,
          });
          inserted += tally.inserted ?? 0;
          if (tally.reason === "budget-exhausted") budgetExhausted = true;
          if (tally.reason === "rate-limited") rateLimited = true;
        } catch {
          // One category's transport/HTTP failure shouldn't sink the whole area pull.
        }
        // Stop early if we've hit a hard cap — no point paying for the rest of the set.
        if (budgetExhausted || rateLimited) break;
      }
      return { inserted, budgetExhausted, rateLimited };
    }),

  /**
   * Internal: find a venue by NAME and make sure it exists in Roam. Powers the Explore search
   * box's "we don't have it — find it on Google" fall-through.
   *
   * DB-FIRST, so a repeat search (or any venue already stored) costs NOTHING: read
   * venues_search_by_name; if it returns rows, hand them straight back. Only when the DB has no
   * name match do we pay for a Places Text Search (ingestTextSearchCore, budget-guarded), then
   * re-read and return the freshly-ingested rows. Either way the client receives the same card
   * shape as venues.near, so it renders identically.
   */
  searchText: internalProcedure
    .input(
      z.object({
        q: z.string().trim().min(2).max(120),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rpc = ctx.service.rpc.bind(ctx.service) as unknown as LooseRpc;
      const readByName = async () => {
        const { data, error } = await rpc("venues_search_by_name", {
          q: input.q,
          lat: input.lat,
          lng: input.lng,
          max_results: 20,
        });
        if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Name search failed: ${error.message}` });
        return ((data ?? []) as VenuesNearRow[]).map(toVenueCard);
      };

      // 1. Already in the DB? Return it — no paid call.
      const existing = await readByName();
      if (existing.length > 0) return { venues: existing, source: "db" as const };

      // 2. Ask Google, ingest, re-read.
      let reason: TextSearchResult["reason"] = "no-matching-places";
      try {
        const result = await ingestTextSearchCore(rpc, productionSearchText, ctx.env.places.apiKey, {
          query: input.q,
          lat: input.lat,
          lng: input.lng,
          clientKey: ctx.clientKey,
        });
        reason = result.reason;
      } catch (e) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e instanceof Error ? e.message : "Search failed." });
      }
      const found = reason === "ingested" ? await readByName() : [];
      return { venues: found, source: "google" as const, reason };
    }),

  /**
   * Internal: enrich ONE venue with the rich Places Details facts (phone, website, price range,
   * amenity attributes), on demand when its profile is opened. Powers the /api/enrich-venue hop.
   *
   * ELIGIBILITY gate here (no paid call unless all hold): the venue is google_places (has a
   * place id), still UNCLAIMED (owner-authored data is never overwritten), and has NEVER been
   * enriched (details_fetched_at is null — so we ask Google exactly once per venue, even if it
   * turns out to have no Atmosphere facts). An ineligible venue returns immediately, no fetch.
   * Only a genuinely-eligible venue reaches enrichVenueCore, which claims the Details budget
   * before paying. Returns the written fields so the client can show them without a re-read.
   */
  enrichVenue: internalProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rpc = ctx.service.rpc.bind(ctx.service) as unknown as LooseRpc;
      // Loose read: details_fetched_at (0080) isn't in the generated DB types yet.
      const svc = ctx.service as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (col: string, v: string) => {
              maybeSingle: () => Promise<{ data: VenueEligibilityRow | null; error: { message: string } | null }>;
            };
          };
        };
      };
      const { data: v, error } = await svc
        .from("venues")
        .select("source, source_ref, owner_id, details_fetched_at")
        .eq("id", input.venueId)
        .maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Venue read failed: ${error.message}` });

      if (!v || v.source !== "google_places" || v.owner_id !== null || !v.source_ref || v.details_fetched_at !== null) {
        return { enriched: false as const, reason: "not-eligible" as const, fields: null };
      }

      try {
        return await enrichVenueCore(rpc, productionGetDetails, ctx.env.places.apiKey, {
          venueId: input.venueId,
          placeId: v.source_ref,
          clientKey: ctx.clientKey,
        });
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Enrichment failed.",
        });
      }
    }),

  /**
   * Internal: a venue's up-to-5 Google reviews, fetched live and returned for read-only display
   * WITH attribution (never persisted). Reached via the /api/google-reviews hop, on explicit user
   * action, so paid Details calls stay off the anonymous path and behind the shared Details wallet
   * + the 12h process cache. Always returns the write-a-review deep link for a Google venue, even
   * when the paid fetch is capped or fails.
   */
  googleReviews: internalProcedure
    .input(z.object({ venueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rpc = ctx.service.rpc.bind(ctx.service) as unknown as LooseRpc;
      const svc = ctx.service as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (col: string, v: string) => {
              maybeSingle: () => Promise<{ data: { source: string | null; source_ref: string | null } | null; error: { message: string } | null }>;
            };
          };
        };
      };
      const { data: v, error } = await svc.from("venues").select("source, source_ref").eq("id", input.venueId).maybeSingle();
      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Venue read failed: ${error.message}` });

      if (!v || v.source !== "google_places" || !v.source_ref) {
        return { available: false as const, reviews: [], writeReviewUrl: null, googleMapsUri: null };
      }
      const placeId = v.source_ref;
      const writeReviewUrl = `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
      try {
        const res = await googleReviewsCore(rpc, productionGetReviews, ctx.env.places.apiKey, { placeId, clientKey: ctx.clientKey });
        // Map to an INLINE-typed shape (not the named GoogleReview) so the inferred AppRouter
        // output stays structural/portable — same idiom as geo.search (avoids TS2883).
        const reviews = res.reviews.map((r) => ({
          id: r.id,
          authorName: r.authorName,
          authorPhotoUri: r.authorPhotoUri,
          authorUri: r.authorUri,
          rating: r.rating,
          text: r.text,
          relativeTime: r.relativeTime,
        }));
        return { available: true as const, reviews, googleMapsUri: res.googleMapsUri, writeReviewUrl };
      } catch {
        // Budget-capped or the Details call failed — still hand back the write-a-review link.
        return { available: true as const, reviews: [], googleMapsUri: null, writeReviewUrl };
      }
    }),
});

/** The eligibility columns read before an enrichment (loose — details_fetched_at is new). */
interface VenueEligibilityRow {
  source: string | null;
  source_ref: string | null;
  owner_id: string | null;
  details_fetched_at: string | null;
}

/* ── Google reviews (read-only display) ────────────────────────────────────────────────────────
 * Google's up-to-5 reviews, fetched LIVE per view and shown with attribution. Unlike the
 * enrichment facts, review CONTENT is never persisted (Google Maps Platform terms), so this path
 * is a fetch-on-demand with a short process cache (below) — not a DB write. Same paid Details
 * (Atmosphere) tier + budget wallet as enrichment, and internal-only (the web reaches it via the
 * /api/google-reviews hop) so anonymous users can't trigger paid calls directly. */

/** A Place reviews fetcher with getPlaceReviews' signature — injected so tests fake it. */
export type GetReviewsFn = (placeId: string, apiKey: string) => Promise<corePlaces.PlaceResult>;
const productionGetReviews: GetReviewsFn = defaultGetPlaceReviews;

/** Process cache for a place's reviews — shown fresh but change slowly, so a short TTL bounds the
 *  paid calls WITHOUT persisting content. Single-replica caveat as the geocode cache. */
const reviewsCache = new Map<string, { reviews: corePlaces.GoogleReview[]; googleMapsUri: string | null; expires: number }>();
const REVIEWS_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const REVIEWS_CACHE_MAX = 1000;

export interface GoogleReviewsArgs {
  placeId: string;
  clientKey: string | null;
}

/**
 * PURE orchestration for the reviews fetch: serve from the process cache, else claim the DETAILS
 * budget (the same spend ceiling as enrichment) and pull the place's reviews live, mapping via the
 * pure parser. Throws on budget denial or transport failure so the caller degrades to just the
 * write-a-review link. Collaborators injected (rpc, getReviews) so it unit-tests with fakes.
 */
export async function googleReviewsCore(
  rpc: LooseRpc,
  getReviews: GetReviewsFn,
  apiKey: string,
  args: GoogleReviewsArgs,
): Promise<{ reviews: corePlaces.GoogleReview[]; googleMapsUri: string | null }> {
  const cached = reviewsCache.get(args.placeId);
  if (cached && cached.expires > Date.now()) {
    return { reviews: cached.reviews, googleMapsUri: cached.googleMapsUri };
  }

  const { data: quotaData, error: quotaErr } = await rpc("claim_places_detail_quota", {
    p_client_key: args.clientKey,
    p_daily_cap: corePlaces.PLACES_DETAILS_DAILY_BUDGET,
    p_client_cap: corePlaces.PLACES_CLIENT_FETCH_LIMIT,
    p_client_window_secs: corePlaces.PLACES_CLIENT_WINDOW_SECS,
  });
  if (quotaErr) throw new Error(`Detail-quota check failed: ${quotaErr.message}`);
  const quota = (Array.isArray(quotaData) ? quotaData[0] : quotaData) as { allowed?: boolean } | undefined;
  if (!quota?.allowed) throw new Error("reviews-budget-exhausted");

  const place = await getReviews(args.placeId, apiKey);
  const reviews = corePlaces.parsePlaceReviews(place, 5);
  const googleMapsUri = typeof place.googleMapsUri === "string" ? place.googleMapsUri : null;

  if (reviewsCache.size >= REVIEWS_CACHE_MAX) reviewsCache.clear();
  reviewsCache.set(args.placeId, { reviews, googleMapsUri, expires: Date.now() + REVIEWS_TTL_MS });
  return { reviews, googleMapsUri };
}

/** The venues_near / venues_search_by_name row shape, and its projection to a venue card. */
interface VenuesNearRow {
  id: string;
  name: string;
  owner_id: string | null;
  status: string;
  category: string | null;
  categories: string[] | null;
  rating: number | null;
  rating_count: number | null;
  price_level: string | null;
  primary_type_label: string | null;
  business_status: string | null;
  distance_m: number | null;
  lat_out: number | null;
  lng_out: number | null;
  cover_photo_id: string | null;
}

function toVenueCard(v: VenuesNearRow) {
  return {
    id: v.id,
    name: v.name,
    claimed: v.owner_id !== null,
    status: v.status,
    category: v.category,
    categories: v.categories,
    rating: v.rating,
    ratingCount: v.rating_count,
    priceLevel: v.price_level,
    primaryTypeLabel: v.primary_type_label,
    businessStatus: v.business_status,
    distanceM: v.distance_m,
    lat: v.lat_out,
    lng: v.lng_out,
    coverPhotoId: v.cover_photo_id,
  };
}
