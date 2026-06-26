/**
 * One-time photo backfill runner (thin shell over backfill/photos.ts).
 *
 * Pulls Google Places photos for every `google_places`, UNCLAIMED venue that has a place id
 * (source_ref) but no photo rows yet — the venues whose category was ingested before photo
 * support existed, which the live freshness guard will never re-fetch. See backfill/photos.ts
 * for the why.
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
 * Each venue costs ONE Place Details call (field mask id,photos). The run is idempotent
 * (upsert_venue_photos is replace-all and skips claimed venues), so it is safe to re-run.
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
 * The photoless target set: google_places + unclaimed (owner_id null) + has a source_ref +
 * no photo rows of any kind. Computed with two reads (RLS bypassed under the service role):
 * all candidates, minus the venue ids that already have any photo.
 */
async function listPhotolessVenues(db: RoamClient): Promise<PhotolessVenue[]> {
  const { data: candidates, error: cErr } = await db
    .from("venues")
    .select("id, name, source_ref")
    .eq("source", "google_places")
    .is("owner_id", null)
    .not("source_ref", "is", null);
  if (cErr) throw new Error(`Listing venues failed: ${cErr.message}`);

  // venue_photos (0019) isn't in the generated DB types yet — read it through a narrow
  // loose accessor, same idiom as LooseRpc for the un-generated functions.
  const looseFrom = (db as unknown as {
    from: (t: string) => {
      select: (c: string) => Promise<{
        data: { venue_id: string }[] | null;
        error: { message: string } | null;
      }>;
    };
  }).from;
  const { data: withPhotos, error: pErr } = await looseFrom("venue_photos").select("venue_id");
  if (pErr) throw new Error(`Listing existing photos failed: ${pErr.message}`);

  const have = new Set((withPhotos ?? []).map((r) => r.venue_id));
  return (candidates ?? [])
    .filter((v) => v.source_ref && !have.has(v.id as string))
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

  console.log(
    `\nPhoto backfill — ${dryRun ? "DRY RUN (no writes)" : "LIVE"}` +
      `${limit !== undefined ? `, limit ${limit}` : ""}, delay ${delayMs}ms\n`,
  );

  const photoless = await listPhotolessVenues(db);
  console.log(`Found ${photoless.length} photoless google_places venue(s).\n`);
  if (photoless.length === 0) {
    console.log("Nothing to backfill. Done.");
    return;
  }

  const result = await backfillVenuePhotosCore(
    photoless,
    {
      getDetails: (placeId) => getPlaceDetails(placeId, apiKey),
      upsertVenuePhotos: async (payload: BackfillPhotoEntry[]) => {
        const { data, error } = await rpc("upsert_venue_photos", { payload });
        if (error) throw new Error(`upsert_venue_photos failed: ${error.message}`);
        return typeof data === "number" ? data : Number(data ?? 0);
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
  console.log(`venues w/ photos:    ${result.venuesWithPhotos}`);
  console.log(`venues w/o photos:   ${result.venuesWithoutPhotos} (keep default cover)`);
  console.log(`photo rows upserted: ${result.photosUpserted}${dryRun ? " (dry run — none written)" : ""}`);
  console.log("─────────────────────────\n");
}

main().catch((e) => {
  console.error("\nBackfill failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
