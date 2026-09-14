/**
 * diagnose-photos.ts — pin WHY the F2G storefront's covers are blank (D2).
 *
 * A blank card falls back to the placeholder for one of two reasons, and both look identical on the
 * page — so this probes each layer against the LIVE data and prints a verdict + the right fix:
 *
 *   Layer A — MISSING ROWS: the venue has no venue_photos row, so venues_food_to_go_near returns a
 *             null cover_photo_id. Cause: never photo-ingested (or claimed with no owner upload).
 *             Fix: reingest (scripts/reingest-food-to-go.mjs) or `pnpm --filter @roam/api backfill:photos`.
 *   Layer B — RESOLVE FAILING: rows exist, but the read-time Places Photo Media call fails (bad key,
 *             billing/quota, stale ref, or egress). Fix: the Places key/billing/quota — no data change.
 *
 * It reads the SAME rows the storefront shows (the venues_food_to_go_near RPC, called with the legacy
 * 4-arg signature so it works whether or not 0145 is applied) and then live-resolves a real photo ref.
 *
 * Read-only: no writes. Must run where SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + the Core Places key
 * exist AND egress to places.googleapis.com is allowed (the deployed API env, or a dev box).
 *
 * RUN (from repo root):
 *   pnpm --filter @roam/api diagnose:photos                          # Belfast origin (default)
 *   pnpm --filter @roam/api diagnose:photos -- --lat=54.99 --lng=-7.32   # e.g. Derry~Londonderry
 */
import { createServiceClient } from "@roam/db";
import { buildPhotoMediaRequestUrl } from "../src/routers/venues.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (use the Core project's .env — never a DDS key).`);
  return v;
}

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(hit.indexOf("=") + 1);
}

/** rpc / from widened: venues_food_to_go_near + venue_photos aren't in the generated DB types. */
type LooseRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
/* eslint-disable @typescript-eslint/no-explicit-any */
type LooseFrom = { from: (t: string) => any };

async function main(): Promise<void> {
  const url = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const apiKey = requireEnv("GOOGLE_PLACES_API_KEY_CORE");
  const lat = Number(arg("lat") ?? "54.5973");
  const lng = Number(arg("lng") ?? "-5.9301");

  const db = createServiceClient({ url, serviceRoleKey });
  const rpc = db.rpc.bind(db) as unknown as LooseRpc;
  const looseDb = db as unknown as LooseFrom;

  console.log(`\nF2G cover diagnostic — origin (${lat}, ${lng})\n`);

  // ── Layer A: cover coverage over the storefront's actual venue set ─────────────────────────────
  const { data, error } = await rpc("venues_food_to_go_near", {
    origin_lat: lat,
    origin_lng: lng,
    page_size: 100,
    page_offset: 0,
  });
  if (error) throw new Error(`venues_food_to_go_near failed: ${error.message}`);
  const rows = (data ?? []) as { id: string; owner_id: string | null; cover_photo_id: string | null }[];
  const total = rows.length;
  const withCover = rows.filter((r) => r.cover_photo_id).length;
  const nullCover = total - withCover;
  const nullClaimed = rows.filter((r) => !r.cover_photo_id && r.owner_id).length;
  const nullUnclaimed = nullCover - nullClaimed;

  if (total === 0) {
    console.log("No F2G-eligible venues near this origin — check the coordinates, or that supply is ingested here.");
    return;
  }
  console.log("── Layer A · cover-photo coverage (venues_food_to_go_near) ──");
  console.log(`  venues near origin:        ${total}`);
  console.log(`  with a cover photo row:    ${withCover}`);
  console.log(`  NO cover (placeholder):    ${nullCover}  (unclaimed ${nullUnclaimed}, claimed ${nullClaimed})`);

  // ── Layer B: a live resolve of a real google_places photo ref ──────────────────────────────────
  console.log("\n── Layer B · live Places Photo Media resolve ──");
  const { data: photos } = await looseDb
    .from("venue_photos")
    .select("id, venue_id, places_photo_ref")
    .eq("source", "google_places")
    .not("places_photo_ref", "is", null)
    .limit(3);
  const sample = (photos ?? []) as { id: string; venue_id: string; places_photo_ref: string }[];

  let resolveOk = 0;
  let lastStatus = "";
  if (sample.length === 0) {
    console.log("  no google_places photo rows exist at all → nothing to resolve (points to Layer A).");
  } else {
    for (const p of sample) {
      try {
        const res = await fetch(buildPhotoMediaRequestUrl(p.places_photo_ref, apiKey, 400));
        if (!res.ok) {
          lastStatus = `HTTP ${res.status} ${res.statusText}`;
          console.log(`  ✗ venue ${p.venue_id}: ${lastStatus}`);
          continue;
        }
        const json = (await res.json()) as { photoUri?: string };
        if (json.photoUri) {
          resolveOk++;
          console.log(`  ✓ venue ${p.venue_id}: resolved to a photo URL`);
        } else {
          lastStatus = "200 but no photoUri";
          console.log(`  ✗ venue ${p.venue_id}: ${lastStatus}`);
        }
      } catch (e) {
        lastStatus = e instanceof Error ? e.message : "fetch error";
        console.log(`  ✗ venue ${p.venue_id}: ${lastStatus}`);
      }
    }
  }

  // ── Verdict ────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── Verdict ──");
  if (sample.length > 0 && resolveOk === 0) {
    console.log(`  LAYER B (resolve failing): photo refs exist but every resolve failed (${lastStatus}).`);
    console.log("  → Fix the read side: check GOOGLE_PLACES_API_KEY_CORE authorization, Google billing,");
    console.log("    Places Photo Media quota (429), and egress to places.googleapis.com. No data change.");
  } else if (nullUnclaimed > 0) {
    console.log(`  LAYER A (missing rows): ${nullUnclaimed} unclaimed venue(s) here have no photo rows.`);
    console.log("  → Repopulate: scripts/reingest-food-to-go.mjs (deployed-API path, re-fetches even");
    console.log("    populated towns) or `pnpm --filter @roam/api backfill:photos` (direct DB, unclaimed).");
    if (nullClaimed > 0) console.log(`  Note: ${nullClaimed} CLAIMED venue(s) are blank by design (owner uploads only).`);
  } else if (resolveOk > 0) {
    console.log("  HEALTHY: resolves work and every unclaimed venue here has a cover row.");
    if (nullClaimed > 0) console.log(`  (${nullClaimed} claimed venue(s) show the placeholder by design — owner uploads only.)`);
  } else {
    console.log("  Inconclusive — re-run against a busier origin (more venues) to get a sample.");
  }
  console.log("");
}
/* eslint-enable @typescript-eslint/no-explicit-any */

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
