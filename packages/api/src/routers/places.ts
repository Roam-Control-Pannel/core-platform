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
import { searchNearby as defaultSearchNearby, type FetchImpl } from "../places/client.js";

/**
 * The staleness window (30 days, the Places New ToS content-cache ceiling) lives INSIDE
 * count_fresh_places_venues, not here — passing an interval across PostgREST RPC
 * resolution fails, and the window is a fixed policy constant, not a per-call input.
 */

/** Default search radius in metres (urban high-street scale). Tunable per call. */
const DEFAULT_RADIUS_M = 1500;

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
}

/** The tally returned by an ingest run. Internal — NOT exported, so its name never
 *  leaks into the AppRouter inferred type that client packages consume (TS2883). */
type IngestResult = {
  skipped: boolean;
  reason: "fresh-coverage" | "no-matching-places" | "ingested";
  freshCount: number;
  fetched: number;
  inserted: number;
  claimedSkipped: number;
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
  // (1) Freshness check — skip the paid call if we already have fresh coverage.
  const { data: freshData, error: freshErr } = await rpc("count_fresh_places_venues", {
    lat: args.lat,
    lng: args.lng,
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
    };
  }

  // (2) Fetch from Places (New).
  const results = await searchNearby(
    {
      lat: args.lat,
      lng: args.lng,
      includedTypes: corePlaces.categoryToPlacesTypes(args.category),
      radiusMetres: args.radiusMetres,
      maxResultCount: MAX_RESULTS,
    },
    apiKey,
  );

  // Map through the PURE core helpers; drop nulls and category-mismatches.
  const rows = results
    .filter((p) => corePlaces.classifyPlaceTypes(p.types ?? []) === args.category)
    .map((p) => corePlaces.placeToVenueRow(p, args.category))
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) {
    return {
      skipped: false,
      reason: "no-matching-places",
      freshCount: 0,
      fetched: results.length,
      inserted: 0,
      claimedSkipped: 0,
    };
  }

  // (3) One batch upsert. Idempotent on (source, source_ref); claimed rows frozen.
  const { data: upsertData, error: upsertErr } = await rpc("upsert_place_venues", {
    places: rows,
  });
  if (upsertErr) throw new Error(`Venue upsert failed: ${upsertErr.message}`);

  const upserted = (upsertData ?? []) as UpsertRow[];
  const claimedSkipped = upserted.filter((r) => r.out_was_claimed).length;

  return {
    skipped: false,
    reason: "ingested",
    freshCount: 0,
    fetched: results.length,
    inserted: upserted.length - claimedSkipped,
    claimedSkipped,
  };
}

/** Seam for the production fetcher. */
const productionSearchNearby: SearchNearbyFn = defaultSearchNearby;

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
        });
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Ingestion failed.",
        });
      }
    }),
});
