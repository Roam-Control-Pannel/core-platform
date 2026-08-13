/**
 * reingest-food-to-go.mjs — one-off/maintenance sweep that (re)fills the Food to Go storefront's
 * open-mode supply across the Northern Ireland towns, INCLUDING already-populated ones.
 *
 * WHY THIS EXISTS: the storefront only auto-triggers the open-mode ingest when a town has ZERO
 * food-to-go venues near the point (StorefrontHome). So when we widen what counts as food-to-go
 * (e.g. adding meal_takeaway/sandwich_shop/deli to the core taxonomy), towns that already hold a
 * few café-only venues never re-trigger and stay thin forever — Belfast is the canonical case.
 * This script forces a fresh pull per town so the new supply lands. ingestFoodToGo consults no
 * freshness cache (only the global daily budget), so it fetches regardless of existing coverage;
 * upserts are idempotent on (source, source_ref) and claimed venues stay frozen, so re-running is
 * safe and cheap.
 *
 * COVERAGE: one searchNearby point covers only a ~2.5 km-radius disk (the ingest radius), which
 * is fine for a small town but under-covers a city. So the big towns get a small GRID of points
 * (below), while the rest are a single civic-centre point. The point list mirrors apps/web NI_PLACES.
 *
 * COST: the open-mode ingest fans out one paid searchNearby PER food-to-go type (~12), so each
 * point is ~12 paid Places calls. The whole sweep is a few hundred calls — comfortably under the
 * 2000/day global budget (PLACES_DAILY_FETCH_BUDGET). We send NO client-IP header, so the per-IP
 * rate limit is skipped and ONLY the global budget gates the sweep (the intended admin posture);
 * a budget denial stops the run cleanly and reports what remains.
 *
 * AUTH: this hits the API's internal `places.ingestFoodToGo` procedure directly (the same surface
 * the web /api/ingest-food-to-go route uses) with the x-internal-call secret — server-to-server,
 * never reachable from a browser. It is dev/ops tooling: dependency-free (Node 18+ global fetch),
 * and self-hiding without the secret.
 *
 * RUN (from the repo root, with the root .env loaded into the shell — e.g. via `set -a; . .env`):
 *   node scripts/reingest-food-to-go.mjs                 # sweep every NI town
 *   node scripts/reingest-food-to-go.mjs --dry-run       # print the plan + est. cost, call nothing
 *   node scripts/reingest-food-to-go.mjs --town=Belfast  # one town (repeat/comma for several)
 *
 * ENV:
 *   INTERNAL_CALL_SECRET   (required) — the x-internal-call secret (same var the web route reads)
 *   NEXT_PUBLIC_API_URL    API origin (default http://localhost:8787; prod = the deployed API)
 *   F2G_RADIUS_M           per-point ingest radius in metres (default 2500)
 */

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const SECRET = process.env.INTERNAL_CALL_SECRET;
const RADIUS_M = clampInt(Number(process.env.F2G_RADIUS_M ?? "2500"), 100, 50_000, 2500);

// Estimate only, for the dry-run cost preview. Keep in step with @roam/core/f2g
// FOOD_TO_GO_SEARCH_TYPES (one paid searchNearby per entry). Not load-bearing.
const TYPES_PER_POINT = 12;

/**
 * NI town centres to seed (mirrors apps/web/src/lib/ni.ts NI_PLACES). `grid` gives the bigger
 * built-up areas a lattice of points so the ~2.5 km disks tile the town instead of one disk in the
 * middle: `rings` = how many steps out from the centre in each direction (a (2·rings+1)² lattice),
 * `stepKm` = spacing between points. Small towns omit `grid` and seed a single centre point.
 */
const TOWNS = [
  { name: "Belfast", lat: 54.5973, lng: -5.9301, grid: { rings: 1, stepKm: 3.0 } }, // 3×3 ≈ 11 km span
  { name: "Derry/Londonderry", lat: 54.9966, lng: -7.3086, grid: { rings: 1, stepKm: 2.5 } }, // 3×3 ≈ 9 km
  { name: "Lisburn", lat: 54.5162, lng: -6.0581 },
  { name: "Newry", lat: 54.1751, lng: -6.3402 },
  { name: "Bangor", lat: 54.6538, lng: -5.6683 },
  { name: "Ballymena", lat: 54.8642, lng: -6.2792 },
  { name: "Coleraine", lat: 55.1333, lng: -6.6681 },
  { name: "Armagh", lat: 54.3503, lng: -6.6528 },
  { name: "Omagh", lat: 54.5977, lng: -7.3097 },
  { name: "Enniskillen", lat: 54.3446, lng: -7.6316 },
];

/** NI bounding box (mirrors ni.ts NI_BOUNDS) — skip any grid point that lands outside it. */
const NI_BOUNDS = { minLat: 54.0, maxLat: 55.45, minLng: -8.3, maxLng: -5.3 };
const inNI = (lat, lng) =>
  lat >= NI_BOUNDS.minLat && lat <= NI_BOUNDS.maxLat && lng >= NI_BOUNDS.minLng && lng <= NI_BOUNDS.maxLng;

function clampInt(n, lo, hi, dflt) {
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** Expand a town into the list of {lat,lng} points to seed (single centre, or its grid lattice). */
function pointsFor(town) {
  if (!town.grid) return [{ lat: town.lat, lng: town.lng }];
  const { rings, stepKm } = town.grid;
  const dLat = 1 / 110.574; // deg latitude per km
  const dLng = 1 / (111.320 * Math.cos((town.lat * Math.PI) / 180)); // deg longitude per km at this lat
  const pts = [];
  for (let i = -rings; i <= rings; i++) {
    for (let j = -rings; j <= rings; j++) {
      const lat = town.lat + i * stepKm * dLat;
      const lng = town.lng + j * stepKm * dLng;
      if (inNI(lat, lng)) pts.push({ lat: round5(lat), lng: round5(lng) });
    }
  }
  return pts;
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;

/**
 * Fire one places.ingestFoodToGo call via the API's internal tRPC surface. Hand-builds the tRPC v11
 * httpBatchLink wire format (no data transformer configured, so the body is the raw input keyed by
 * batch index): POST /trpc/<path>?batch=1 with body {"0": <input>} → response [{result:{data}}].
 * No x-roam-client-ip header, so ctx.clientKey is null and only the global budget applies.
 * Retries transient network/5xx failures with a short backoff.
 */
async function ingestPoint(lat, lng) {
  const url = `${API_URL}/trpc/places.ingestFoodToGo?batch=1`;
  const body = JSON.stringify({ 0: { lat, lng, radiusMetres: RADIUS_M } });
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-call": SECRET },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      const entry = Array.isArray(parsed) ? parsed[0] : parsed;
      if (entry?.error) {
        throw new Error(entry.error?.json?.message ?? entry.error?.message ?? JSON.stringify(entry.error).slice(0, 200));
      }
      return entry?.result?.data ?? entry?.result ?? entry;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(attempt * 1000);
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { dryRun: false, towns: null };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--town=")) {
      const wanted = a.slice("--town=".length).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      out.towns = new Set(wanted);
    }
  }
  return out;
}

async function main() {
  const { dryRun, towns } = parseArgs(process.argv.slice(2));

  if (!SECRET && !dryRun) {
    console.error(
      "✗ INTERNAL_CALL_SECRET not set. This script calls the API's internal ingest surface.\n" +
        "  Load the root .env first, e.g.:  set -a; . ./.env; set +a\n" +
        "  Then:  node scripts/reingest-food-to-go.mjs\n" +
        "  (Or preview without calling anything:  node scripts/reingest-food-to-go.mjs --dry-run)",
    );
    process.exit(1);
  }

  const selected = TOWNS.filter((t) => !towns || towns.has(t.name.toLowerCase()));
  if (selected.length === 0) {
    console.error(`✗ No towns matched --town=${[...(towns ?? [])].join(",")}. Known: ${TOWNS.map((t) => t.name).join(", ")}`);
    process.exit(1);
  }

  const plan = selected.map((t) => ({ town: t, points: pointsFor(t) }));
  const totalPoints = plan.reduce((n, p) => n + p.points.length, 0);

  console.log(`Food to Go reingest sweep → ${API_URL}`);
  console.log(`  radius ${RADIUS_M} m · ${selected.length} town(s) · ${totalPoints} point(s) · ~${totalPoints * TYPES_PER_POINT} paid Places calls (est.)`);
  if (dryRun) {
    for (const { town, points } of plan) {
      console.log(`  • ${town.name}: ${points.length} point(s)${town.grid ? ` (grid ${town.grid.rings}×, step ${town.grid.stepKm} km)` : ""}`);
      for (const p of points) console.log(`      ${p.lat}, ${p.lng}`);
    }
    console.log("Dry run — nothing was called.");
    return;
  }

  const totals = { inserted: 0, fetched: 0, photos: 0, claimedSkipped: 0, points: 0, gated: false };
  outer: for (const { town, points } of plan) {
    let tInserted = 0;
    let tFetched = 0;
    for (const p of points) {
      let data;
      try {
        data = await ingestPoint(p.lat, p.lng);
      } catch (e) {
        console.warn(`  ! ${town.name} (${p.lat},${p.lng}) failed: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      totals.points++;
      tInserted += data?.inserted ?? 0;
      tFetched += data?.fetched ?? 0;
      totals.inserted += data?.inserted ?? 0;
      totals.fetched += data?.fetched ?? 0;
      totals.photos += data?.photosUpserted ?? 0;
      totals.claimedSkipped += data?.claimedSkipped ?? 0;
      if (data?.reason === "budget-exhausted" || data?.reason === "rate-limited") {
        totals.gated = true;
        console.warn(`  ⚠ ${town.name}: supply gated (${data.reason}) — daily budget reached, stopping the sweep.`);
        break outer;
      }
      await sleep(250); // gentle pacing between points
    }
    console.log(`  • ${town.name}: +${tInserted} inserted (${tFetched} fetched across ${points.length} point(s))`);
  }

  console.log(
    `Done. ${totals.inserted} venues inserted, ${totals.fetched} fetched, ${totals.photos} photos, ` +
      `${totals.claimedSkipped} claimed-skipped across ${totals.points} point(s).` +
      (totals.gated ? " NOTE: stopped early on the daily budget — re-run tomorrow to finish." : ""),
  );
}

main().catch((e) => {
  console.error("✗ Sweep failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
