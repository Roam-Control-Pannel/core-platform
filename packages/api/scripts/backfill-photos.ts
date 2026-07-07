/**
 * One-time venue backfill runner (thin shell over backfill/photos.ts).
 *
 * For every `google_places`, UNCLAIMED venue with a place id (source_ref), pulls a single
 * Place Details call and (a) refreshes the card fields added after ingest — rating, rating
 * count, price level, primary type label, business status — and (b) upserts its photos. The
 * live freshness guard would skip a normal re-ingest, so existing venues need this pass.
 *
 * RUN (from repo root, with the Core project's keys in .env — same .env the api dev server
 * uses; NEVER a DDS key):
 *
 *   pnpm --filter @roam/api backfill:photos -- --dry-run        # preview, writes nothing
 *   pnpm --filter @roam/api backfill:photos -- --limit=5        # do the first 5 only
 *   pnpm --filter @roam/api backfill:photos                     # the real run (all)
 *
 * Flags:
 *   --dry-run        fetch + map but do not write
 *   --limit=N        process at most N venues (cost guard / smoke test)
 *   --delay=MS       wait MS between Place Details calls (default 120)
 *
 * Each venue costs ONE Place Details call. The run is idempotent (field update is a plain
 * overwrite; upsert_venue_photos is replace-all and skips claimed venues), so it's safe to
 * re-run. NOTE: requires migration 0026 (the new columns) to be applied first.
 */
import { createServiceClient, type RoamClient } from "@roam/db";
import { getPlaceDetails } from "../src/places/client.js";
import {
  backfillVenuePhotosCore,
  type BackfillPhotoEntry,
  type PhotolessVenue,
} from "../src/backfill/photos.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Populate it from the RoamLocal Core Project ` +
        `(.env at repo root) — never from a DDS key.`,
    );
  }
  return v;
}

function parseFlags(argv: string[]): { dryRun: boolean; limit?: number; delayMs: number } {
  let dryRun = false;
  let limit: number | undefined;
  let delayMs = 120;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--limit=")) limit = Number(a.slice("--limit=".length));
    else if (a.startsWith("--delay=")) delayMs = Number(a.slice("--delay=".length));
  }
  return limit === undefined ? { dryRun, delayMs } : { dryRun, limit, delayMs };
}

/**
 * The backfill target set: every UNCLAIMED google_places venue with a source_ref. We hit
 * all of them (not just photoless ones) because the new card fields (rating count, price,
 * type label, business status) were added after every venue was ingested, so all need the
 * refresh; the photo upsert is replace-all and idempotent, so re-touching the few that
 * already have photos is harmless. Claimed venues are excluded — their Places-derived
 * facts are frozen (owner_id is null filter), same as everywhere else.
 */
async function listBackfillVenues(db: RoamClient): Promise<PhotolessVenue[]> {
  const { data: candidates, error: cErr } = await db
    .from("venues")
    .select("id, name, source_ref")
    .eq("source", "google_places")
    .is("owner_id", null)
    .not("source_ref", "is", null);
  if (cErr) throw new Error(`Listing venues failed: ${cErr.message}`);

  return (candidates ?? [])
    .filter((v) => v.source_ref)
    .map((v) => ({
      id: v.id as string,
      source_ref: v.source_ref as string,
      name: (v.name as string | null) ?? undefined,
    }));
}

/** rpc widened: upsert_venue_photos (0020) isn't in the generated DB types. Same idiom as the routers. */
type LooseRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

async function main(): Promise<void> {
  const { dryRun, limit, delayMs } = parseFlags(process.argv.slice(2));

  const url = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const apiKey = requireEnv("GOOGLE_PLACES_API_KEY_CORE");

  const db = createServiceClient({ url, serviceRoleKey });
  const rpc = db.rpc.bind(db) as unknown as LooseRpc;

  // venues' new card columns (0026) aren't in the generated DB types yet — update them
  // through a narrow loose view of the SAME client. NB: keep this as a cast of `db` and call
  // `looseDb.from(...)` — pulling `.from` off into a bare variable detaches it from its
  // receiver and supabase-js crashes on `this.rest`.
  const looseDb = db as unknown as {
    from: (t: string) => {
      update: (vals: Record<string, unknown>) => {
        eq: (col: string, val: string) => Promise<{ error: { message: string } | null }>;
      };
    };
  };

  console.log(
    `\nVenue backfill (photos + card fields) — ${dryRun ? "DRY RUN (no writes)" : "LIVE"}` +
      `${limit !== undefined ? `, limit ${limit}` : ""}, delay ${delayMs}ms\n`,
  );

  const targets = await listBackfillVenues(db);
  console.log(`Found ${targets.length} unclaimed google_places venue(s) to backfill.\n`);
  if (targets.length === 0) {
    console.log("Nothing to backfill. Done.");
    return;
  }

  const result = await backfillVenuePhotosCore(
    targets,
    {
      getDetails: (placeId) => getPlaceDetails(placeId, apiKey),
      upsertVenuePhotos: async (payload: BackfillPhotoEntry[]) => {
        const { data, error } = await rpc("upsert_venue_photos", { payload });
        if (error) throw new Error(`upsert_venue_photos failed: ${error.message}`);
        return typeof data === "number" ? data : Number(data ?? 0);
      },
      updateVenueFields: async (venueId, fields, rich) => {
        const { error } = await looseDb
          .from("venues")
          .update({
            rating: fields.rating,
            rating_count: fields.rating_count,
            price_level: fields.price_level,
            primary_type_label: fields.primary_type_label,
            business_status: fields.business_status,
            // Rich facts (0065) — written as Google returns them (this path only touches
            // unclaimed google_places venues, so the row stays canonical to the source).
            phone: rich.phone,
            website_url: rich.website_url,
            price_range: rich.price_range,
            attributes: rich.attributes,
          })
          .eq("id", venueId);
        if (error) throw new Error(`venue field update failed: ${error.message}`);
      },
      log: (msg) => console.log(msg),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    limit === undefined ? { dryRun, delayMs } : { dryRun, delayMs, limit },
  );

  console.log("\n──────── summary ────────");
  console.log(`considered:          ${result.considered}`);
  console.log(`details fetched:     ${result.fetched}`);
  console.log(`fetch failures:      ${result.failed}`);
  console.log(`card fields updated: ${result.enriched}${dryRun ? " (dry run — none written)" : ""}`);
  console.log(`venues w/ photos:    ${result.venuesWithPhotos}`);
  console.log(`venues w/o photos:   ${result.venuesWithoutPhotos} (keep default cover)`);
  console.log(`photo rows upserted: ${result.photosUpserted}${dryRun ? " (dry run — none written)" : ""}`);
  console.log("─────────────────────────\n");
}

main().catch((e) => {
  console.error("\nBackfill failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
