/**
 * refresh-photos.ts — refresh EXPIRED Google photo references, platform-wide (bulk heal / cron).
 *
 * WHY: Places (New) photo references expire. When they do, every Google-sourced cover on every
 * surface (roam-local.com Explore, the F2G storefront, venue detail heroes) falls back to the
 * placeholder at once, while the rows, the key and billing are all fine — Google answers the
 * media call with 400 INVALID_ARGUMENT "…retrieve it from Places API endpoints" (Sep 2026).
 *
 * The read path self-heals venue-by-venue as pages are viewed (routers/venues + photos/refresh).
 * THIS is the bulk counterpart: one cheap photo-only Place Details call per venue
 * (getPlacePhotos, the `id,photos` Essentials-tier mask — NOT the Enterprise+Atmosphere backfill
 * mask), replaced through the policy RPC refresh_venue_google_photos (0147):
 *   unclaimed → replace-all · claimed with no owner uploads → refresh its EXISTING Google rows
 *   (never adds) · any venue with an owner library → untouched (and never even listed here, so no
 *   call is spent on it). Targets come from list_google_photo_venues (0147): never-refreshed
 *   first, then least-recently refreshed — so a capped run always touches the stalest venues,
 *   which makes it safe to run on a schedule (a Railway cron, like owner-digest) with --limit.
 *
 * Read the tally: "with photos" = refreshed with a fresh set; "no photos" = Google now returns
 * none, so the venue's dead rows were cleared (it keeps the default cover, correctly).
 *
 * RUN (repo root; env from ../../.env if present, else the shell — e.g. a Railway console):
 *   pnpm --filter @roam/api refresh:photos -- --dry-run --limit=3     # smoke: 3 calls, no writes
 *   pnpm --filter @roam/api refresh:photos -- --limit=500             # a capped (cron-sized) pass
 *   pnpm --filter @roam/api refresh:photos -- --venue=<uuid>          # one venue (targeted repair)
 *   pnpm --filter @roam/api refresh:photos                            # everything refreshable
 *
 * Flags:
 *   --dry-run        fetch + map but write nothing (still makes the Details calls)
 *   --limit=N        at most N venues this run (default: all, capped at 5000 by the RPC)
 *   --delay=MS       pause between Details calls (default 120)
 *   --venue=UUID     only this venue
 *
 * Idempotent: replace-all per venue, policy-guarded in the DB, safe to re-run.
 */
import { createServiceClient } from "@roam/db";
import { getPlacePhotos } from "../src/places/client.js";
import { backfillVenuePhotosCore, type BackfillPhotoEntry, type PhotolessVenue } from "../src/backfill/photos.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (use the Core project's env — never a DDS key).`);
  return v;
}

function parseFlags(argv: string[]): { dryRun: boolean; limit?: number; delayMs: number; venue?: string } {
  let dryRun = false;
  let limit: number | undefined;
  let delayMs = 120;
  let venue: string | undefined;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--limit=")) limit = Number(a.slice("--limit=".length));
    else if (a.startsWith("--delay=")) delayMs = Number(a.slice("--delay=".length));
    else if (a.startsWith("--venue=")) venue = a.slice("--venue=".length).trim();
  }
  return {
    dryRun,
    delayMs,
    ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    ...(venue ? { venue } : {}),
  };
}

/** rpc widened: the 0147 functions aren't in the generated DB types. Same idiom as the routers. */
type LooseRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

type RefreshTarget = {
  id: string;
  name: string | null;
  source_ref: string;
  google_photos_refreshed_at: string | null;
};

async function main(): Promise<void> {
  const { dryRun, limit, delayMs, venue } = parseFlags(process.argv.slice(2));

  const url = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const apiKey = requireEnv("GOOGLE_PLACES_API_KEY_CORE");

  const db = createServiceClient({ url, serviceRoleKey });
  const rpc = db.rpc.bind(db) as unknown as LooseRpc;

  console.log(
    `\nGoogle photo-ref refresh — ${dryRun ? "DRY RUN (no writes)" : "LIVE"}` +
      `${limit !== undefined ? `, limit ${limit}` : ""}${venue ? `, venue ${venue}` : ""}, delay ${delayMs}ms\n`,
  );

  const { data, error } = await rpc("list_google_photo_venues", {
    p_limit: limit ?? 5000,
    p_venue_id: venue ?? null,
  });
  if (error) throw new Error(`list_google_photo_venues failed: ${error.message}`);
  const rows = (data ?? []) as RefreshTarget[];
  const targets: PhotolessVenue[] = rows.map((r) => ({
    id: r.id,
    source_ref: r.source_ref,
    name: r.name ?? undefined,
  }));
  const neverRefreshed = rows.filter((r) => !r.google_photos_refreshed_at).length;
  console.log(
    `Found ${targets.length} refreshable venue(s) (${neverRefreshed} never refreshed) — stalest first.` +
      ` Each costs ONE photo-only Place Details call.\n`,
  );
  if (targets.length === 0) {
    console.log("Nothing to refresh. Done.");
    return;
  }

  const result = await backfillVenuePhotosCore(
    targets,
    {
      getDetails: (placeId) => getPlacePhotos(placeId, apiKey),
      upsertVenuePhotos: async (payload: BackfillPhotoEntry[]) => {
        const { data: inserted, error: rpcErr } = await rpc("refresh_venue_google_photos", { payload });
        if (rpcErr) throw new Error(`refresh_venue_google_photos failed: ${rpcErr.message}`);
        return typeof inserted === "number" ? inserted : Number(inserted ?? 0);
      },
      log: (m) => console.log(m),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    { dryRun, delayMs, includeEmpty: true, ...(limit !== undefined ? { limit } : {}) },
  );

  console.log(
    `\nDone. considered ${result.considered} · fetched ${result.fetched} · failed ${result.failed}` +
      ` · with photos ${result.venuesWithPhotos} · no photos (rows cleared) ${result.venuesWithoutPhotos}` +
      ` · photo rows written ${result.photosUpserted}${dryRun ? " (dry run: 0 by design)" : ""}\n`,
  );
  if (result.failed > 0) {
    console.log("Some Details calls failed (see FAILED lines above) — those venues were skipped and will be");
    console.log("listed first again next run (still never/least-recently refreshed).\n");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
