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
 * PHASES: `--phase=1` (default) is the ten curated NI_PLACES towns above (26 points). `--phase=2` is
 * the DATA-DRIVEN fill-in — PHASE2_POINTS below — derived from the FSA hygiene-rating register
 * (fsa_establishments, geocoded by the FSA): a greedy 2.5 km disk cover of every NI takeaway/café
 * that no Phase 1 disk reaches (scripts/f2g-sweep-cover.sql). Phase 1 reaches 46% of NI's 4,846
 * FSA takeaways+cafés; Phase 2 reaches 76% of the rest. Phase 2 is 73 points ≈ 1,825 calls, so it
 * ships as two batches on separate days: `--phase=2a` (ranks 1–40, ~1,000 calls) and `--phase=2b`
 * (ranks 41–73, ~825 calls). See docs/f2g-reingest-sweep.md.
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
 *   node scripts/reingest-food-to-go.mjs                 # Phase 1: sweep every curated NI town
 *   node scripts/reingest-food-to-go.mjs --dry-run       # print the plan + est. cost, call nothing
 *   node scripts/reingest-food-to-go.mjs --town=Belfast  # one town (repeat/comma for several)
 *   node scripts/reingest-food-to-go.mjs --phase=2a      # Phase 2 batch A (ranks 1–40)
 *   node scripts/reingest-food-to-go.mjs --phase=2b      # Phase 2 batch B (ranks 41–73)
 *   node scripts/reingest-food-to-go.mjs --phase=2 --ranks=12-20   # any rank window
 *   node scripts/reingest-food-to-go.mjs --phase=2 --town=BT23     # Phase 2 by district / label
 *   (In the Railway API container: NEXT_PUBLIC_API_URL=http://127.0.0.1:$PORT and run it detached —
 *    `setsid nohup node scripts/reingest-food-to-go.mjs … > /tmp/reingest.log 2>&1 &` — the console
 *    drops during silent stretches and takes a foreground process with it.)
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
// 12 grab-and-go + 13 cuisine-takeaway leaves (added 2026-09, migration 0146).
const TYPES_PER_POINT = 25;

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

/**
 * Phase 2 — the data-driven fill-in. NOT hand-picked: each row is one output line of
 * scripts/f2g-sweep-cover.sql run on 2026-09-16 against the 16,949 NI FSA establishments (11
 * councils). The query marks every FSA takeaway/café inside a Phase 1 disk as covered, then greedily
 * picks the business location whose 2.5 km disk reaches the most still-uncovered businesses, until
 * the next disk would add < 8. `reach` = businesses that disk newly reached (the ranking key);
 * `name` = the modal FSA address line among them, verbatim (so an odd one like "Towns Parks" is
 * the register's wording — `district` is the reliable key); lat/lng = the chosen business's FSA
 * geocode. Re-derive (don't hand-edit) after each sweep: add the swept points to the query's
 * `phase1` list and it returns whatever is still uncovered.
 */
const PHASE2_POINTS = [
  { rank: 1,  name: "Lurgan",        district: "BT66", reach: 94, lat: 54.45743, lng: -6.35637 },
  { rank: 2,  name: "Newtownabbey",  district: "BT36", reach: 92, lat: 54.66782, lng: -5.93329 },
  { rank: 3,  name: "Newtownards",   district: "BT23", reach: 89, lat: 54.59649, lng: -5.68651 },
  { rank: 4,  name: "Portadown",     district: "BT62", reach: 85, lat: 54.4293,  lng: -6.43153 },
  { rank: 5,  name: "Cookstown",     district: "BT80", reach: 64, lat: 54.63424, lng: -6.74385 },
  { rank: 6,  name: "Banbridge",     district: "BT32", reach: 63, lat: 54.34702, lng: -6.27096 },
  { rank: 7,  name: "Towns Parks",   district: "BT41", reach: 62, lat: 54.71459, lng: -6.21979 },
  { rank: 8,  name: "Dungannon",     district: "BT70", reach: 60, lat: 54.50222, lng: -6.77254 },
  { rank: 9,  name: "Newcastle",     district: "BT33", reach: 60, lat: 54.21404, lng: -5.88704 },
  { rank: 10, name: "Carrickfergus", district: "BT38", reach: 59, lat: 54.71974, lng: -5.80443 },
  { rank: 11, name: "Portrush",      district: "BT56", reach: 51, lat: 55.20418, lng: -6.65244 },
  { rank: 12, name: "Belfast",       district: "BT17", reach: 48, lat: 54.54822, lng: -6.00754 },
  { rank: 13, name: "Larne",         district: "BT40", reach: 47, lat: 54.85854, lng: -5.83293 },
  { rank: 14, name: "Limavady",      district: "BT49", reach: 45, lat: 55.0537,  lng: -6.9462 },
  { rank: 15, name: "Magherafelt",   district: "BT45", reach: 43, lat: 54.75621, lng: -6.61173 },
  { rank: 16, name: "Strabane",      district: "BT82", reach: 42, lat: 54.8268,  lng: -7.46566 },
  { rank: 17, name: "Downpatrick",   district: "BT30", reach: 42, lat: 54.32633, lng: -5.71668 },
  { rank: 18, name: "Ballymoney",    district: "BT53", reach: 39, lat: 55.07042, lng: -6.50807 },
  { rank: 19, name: "Dundonald",     district: "BT16", reach: 38, lat: 54.59462, lng: -5.81138 },
  { rank: 20, name: "Holywood",      district: "BT18", reach: 35, lat: 54.64502, lng: -5.81611 },
  { rank: 21, name: "Ballycastle",   district: "BT54", reach: 31, lat: 55.20895, lng: -6.24747 },
  { rank: 22, name: "Ballynahinch",  district: "BT24", reach: 31, lat: 54.40058, lng: -5.89894 },
  { rank: 23, name: "Ballyclare",    district: "BT39", reach: 30, lat: 54.74287, lng: -6.00748 },
  { rank: 24, name: "Kilkeel",       district: "BT34", reach: 28, lat: 54.06313, lng: -6.00622 },
  { rank: 25, name: "Portstewart",   district: "BT55", reach: 27, lat: 55.18398, lng: -6.71844 },
  { rank: 26, name: "Donaghadee",    district: "BT21", reach: 27, lat: 54.65496, lng: -5.55394 },
  { rank: 27, name: "Warrenpoint",   district: "BT34", reach: 26, lat: 54.10029, lng: -6.25273 },
  { rank: 28, name: "Comber",        district: "BT23", reach: 24, lat: 54.56682, lng: -5.73614 },
  { rank: 29, name: "Hillsborough",  district: "BT26", reach: 22, lat: 54.47813, lng: -6.08413 },
  { rank: 30, name: "Bushmills",     district: "BT57", reach: 22, lat: 55.21581, lng: -6.53756 },
  { rank: 31, name: "Moira",         district: "BT67", reach: 20, lat: 54.48055, lng: -6.22671 },
  { rank: 32, name: "Castlewellan",  district: "BT31", reach: 19, lat: 54.25814, lng: -5.94055 },
  { rank: 33, name: "Crumlin",       district: "BT29", reach: 19, lat: 54.61173, lng: -6.22159 },
  { rank: 34, name: "Coalisland",    district: "BT71", reach: 19, lat: 54.5389,  lng: -6.70556 },
  { rank: 35, name: "Newtownabbey",  district: "BT36", reach: 19, lat: 54.69106, lng: -5.9792 },
  { rank: 36, name: "Newtownabbey",  district: "BT37", reach: 17, lat: 54.67759, lng: -5.89081 },
  { rank: 37, name: "Carryduff",     district: "BT8",  reach: 17, lat: 54.51527, lng: -5.88559 },
  { rank: 38, name: "Dromore",       district: "BT25", reach: 17, lat: 54.41479, lng: -6.14863 },
  { rank: 39, name: "Camlough",      district: "BT35", reach: 17, lat: 54.18521, lng: -6.39001 },
  { rank: 40, name: "Castlerock",    district: "BT51", reach: 16, lat: 55.16571, lng: -6.78752 },
  // ── batch B (ranks 41–73) ──
  { rank: 41, name: "Portaferry",    district: "BT22", reach: 16, lat: 54.37077, lng: -5.55588 },
  { rank: 42, name: "Maghera",       district: "BT46", reach: 15, lat: 54.84551, lng: -6.67262 },
  { rank: 43, name: "Dungiven",      district: "BT47", reach: 15, lat: 54.92702, lng: -6.92349 },
  { rank: 44, name: "Portglenone",   district: "BT44", reach: 15, lat: 54.87284, lng: -6.47821 },
  { rank: 45, name: "Lisnaskea",     district: "BT92", reach: 14, lat: 54.25152, lng: -7.44281 },
  { rank: 46, name: "Moy",           district: "BT71", reach: 14, lat: 54.44783, lng: -6.6952 },
  { rank: 47, name: "Castlederg",    district: "BT81", reach: 13, lat: 54.7089,  lng: -7.59365 },
  { rank: 48, name: "Belfast",       district: "BT29", reach: 12, lat: 54.66124, lng: -6.22549 },
  { rank: 49, name: "Cushendall",    district: "BT44", reach: 12, lat: 55.08068, lng: -6.06363 },
  { rank: 50, name: "Crossmaglen",   district: "BT35", reach: 12, lat: 54.08931, lng: -6.57935 },
  { rank: 51, name: "Tandragee",     district: "BT62", reach: 12, lat: 54.3638,  lng: -6.42275 },
  { rank: 52, name: "Whitehead",     district: "BT38", reach: 12, lat: 54.75981, lng: -5.71772 },
  { rank: 53, name: "Ballymena",     district: "BT42", reach: 11, lat: 54.8585,  lng: -6.32545 },
  { rank: 54, name: "Irvinestown",   district: "BT94", reach: 11, lat: 54.47221, lng: -7.63319 },
  { rank: 55, name: "Fivemiletown",  district: "BT75", reach: 11, lat: 54.37784, lng: -7.31579 },
  { rank: 56, name: "Keady",         district: "BT60", reach: 11, lat: 54.24914, lng: -6.70494 },
  { rank: 57, name: "Kilrea",        district: "BT51", reach: 11, lat: 54.95023, lng: -6.55562 },
  { rank: 58, name: "Broughshane",   district: "BT42", reach: 11, lat: 54.8889,  lng: -6.22006 },
  { rank: 59, name: "Aughnacloy",    district: "BT69", reach: 10, lat: 54.41444, lng: -6.97664 },
  { rank: 60, name: "Randalstown",   district: "BT41", reach: 10, lat: 54.74764, lng: -6.32192 },
  { rank: 61, name: "Rostrevor",     district: "BT34", reach: 9,  lat: 54.09475, lng: -6.1897 },
  { rank: 62, name: "Crossgar",      district: "BT30", reach: 9,  lat: 54.39619, lng: -5.76111 },
  { rank: 63, name: "Saintfield",    district: "BT24", reach: 9,  lat: 54.46046, lng: -5.83168 },
  { rank: 64, name: "Fintona",       district: "BT78", reach: 9,  lat: 54.49748, lng: -7.31818 },
  { rank: 65, name: "Ballykelly",    district: "BT49", reach: 9,  lat: 55.04626, lng: -7.04114 },
  { rank: 66, name: "Richhill",      district: "BT61", reach: 9,  lat: 54.37195, lng: -6.55036 },
  { rank: 67, name: "Dundrum",       district: "BT33", reach: 9,  lat: 54.27722, lng: -5.83668 },
  { rank: 68, name: "Garvagh",       district: "BT51", reach: 8,  lat: 54.99408, lng: -6.6931 },
  { rank: 69, name: "Markethill",    district: "BT60", reach: 8,  lat: 54.28098, lng: -6.52129 },
  { rank: 70, name: "Craigavon",     district: "BT64", reach: 8,  lat: 54.44586, lng: -6.39171 },
  { rank: 71, name: "Ballymena",     district: "BT44", reach: 8,  lat: 54.99353, lng: -5.98954 },
  { rank: 72, name: "Draperstown",   district: "BT45", reach: 8,  lat: 54.79271, lng: -6.78678 },
  { rank: 73, name: "Lurgan",        district: "BT66", reach: 8,  lat: 54.47254, lng: -6.32332 },
];

/** The two Phase 2 batches — each fits a day's budget with room left for the storefront's own ingest. */
const PHASE2_BATCHES = { "2a": [1, 40], "2b": [41, 73] };

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
  const out = { dryRun: false, towns: null, phase: "1", ranks: null };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--town=")) {
      const wanted = a.slice("--town=".length).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      out.towns = new Set(wanted);
    } else if (a.startsWith("--phase=")) {
      out.phase = a.slice("--phase=".length).trim().toLowerCase();
    } else if (a.startsWith("--ranks=")) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(a.slice("--ranks=".length).trim());
      if (!m) {
        console.error(`✗ --ranks expects N or A-B (e.g. --ranks=12-20), got "${a}"`);
        process.exit(1);
      }
      out.ranks = [Number(m[1]), Number(m[2] ?? m[1])];
    } else {
      console.error(`✗ Unknown argument "${a}". Known: --dry-run --town=… --phase=1|2|2a|2b --ranks=A-B`);
      process.exit(1);
    }
  }
  if (!["1", "2", "2a", "2b"].includes(out.phase)) {
    console.error(`✗ --phase must be 1, 2, 2a or 2b (got "${out.phase}")`);
    process.exit(1);
  }
  if (out.ranks && out.phase === "1") {
    console.error("✗ --ranks applies to Phase 2 only (add --phase=2)");
    process.exit(1);
  }
  return out;
}

/**
 * Resolve the CLI selection to sweep entries: `{ label, points, note }`. Phase 1 entries are the
 * curated towns (one or a grid of points each); Phase 2 entries are single FSA-derived points, one
 * per rank, filtered by batch / --ranks / --town (matching the label or the postcode district).
 */
function selectPlan({ phase, ranks, towns }) {
  if (phase === "1") {
    return TOWNS.filter((t) => !towns || towns.has(t.name.toLowerCase())).map((t) => ({
      label: t.name,
      points: pointsFor(t),
      note: t.grid ? ` (grid ${t.grid.rings}×, step ${t.grid.stepKm} km)` : "",
    }));
  }
  const [lo, hi] = ranks ?? PHASE2_BATCHES[phase] ?? [1, Number.MAX_SAFE_INTEGER];
  return PHASE2_POINTS.filter(
    (p) =>
      p.rank >= lo &&
      p.rank <= hi &&
      (!towns || towns.has(p.name.toLowerCase()) || towns.has(p.district.toLowerCase())),
  ).map((p) => ({
    label: `#${p.rank} ${p.name} (${p.district})`,
    points: [{ lat: p.lat, lng: p.lng }],
    note: ` — reaches ${p.reach} FSA takeaways/cafés`,
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { dryRun, towns, phase } = args;

  if (!SECRET && !dryRun) {
    console.error(
      "✗ INTERNAL_CALL_SECRET not set. This script calls the API's internal ingest surface.\n" +
        "  Load the root .env first, e.g.:  set -a; . ./.env; set +a\n" +
        "  Then:  node scripts/reingest-food-to-go.mjs\n" +
        "  (Or preview without calling anything:  node scripts/reingest-food-to-go.mjs --dry-run)",
    );
    process.exit(1);
  }

  const plan = selectPlan(args);
  if (plan.length === 0) {
    const known = phase === "1" ? TOWNS.map((t) => t.name) : PHASE2_POINTS.map((p) => `${p.name}/${p.district}`);
    console.error(`✗ Nothing matched the selection (phase ${phase}${towns ? `, --town=${[...towns].join(",")}` : ""}). Known: ${known.join(", ")}`);
    process.exit(1);
  }
  const totalPoints = plan.reduce((n, p) => n + p.points.length, 0);
  const unit = phase === "1" ? "town(s)" : "FSA-derived point(s)";

  console.log(`Food to Go reingest sweep → ${API_URL}   [phase ${phase}]`);
  console.log(`  radius ${RADIUS_M} m · ${plan.length} ${unit} · ${totalPoints} point(s) · ~${totalPoints * TYPES_PER_POINT} paid Places calls (est.)`);
  if (dryRun) {
    for (const { label, points, note } of plan) {
      console.log(`  • ${label}: ${points.length} point(s)${note}`);
      for (const p of points) console.log(`      ${p.lat}, ${p.lng}`);
    }
    console.log("Dry run — nothing was called.");
    return;
  }

  const totals = { inserted: 0, fetched: 0, photos: 0, claimedSkipped: 0, points: 0, gated: false };
  outer: for (const { label, points } of plan) {
    let tInserted = 0;
    let tFetched = 0;
    for (const p of points) {
      let data;
      try {
        data = await ingestPoint(p.lat, p.lng);
      } catch (e) {
        console.warn(`  ! ${label} (${p.lat},${p.lng}) failed: ${e instanceof Error ? e.message : String(e)}`);
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
        console.warn(`  ⚠ ${label}: supply gated (${data.reason}) — daily budget reached, stopping the sweep.`);
        break outer;
      }
      await sleep(250); // gentle pacing between points
    }
    console.log(`  • ${label}: +${tInserted} inserted (${tFetched} fetched across ${points.length} point(s))`);
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
