/**
 * transit-recon.mjs — Phase-0 data recon for the Translink/EFA integration.
 *
 * WHY: our redesign roadmap has three "gated" features (fares £, accessibility/low-floor, live
 * vehicle tracking). Public docs already answer two — Translink NI publishes no vehicle-GPS feed,
 * and fares live in the mLink app, not the open API. This script settles the LAST unknown:
 * does a live Departure-Monitor / Trip payload carry ACCESSIBILITY (low-floor / wheelchair) fields
 * we could surface? It also greps for fare/vehicle fields so the finding is definitive, not assumed.
 *
 * It is dev-only tooling: dependency-free (Node 18+ global fetch), read-only, and self-hiding
 * without a key. It mirrors the exact request the production client sends (packages/api/src/transit/
 * client.ts) so what it sees is what we'd get, then also tries a "rich" trip that opts INTO EFA's
 * fare + accessibility modules — so we learn whether the data is absent, or merely not requested.
 *
 * RUN (on Railway shell, or locally with the key):
 *   TRANSLINK_API_KEY=xxxxx node scripts/transit-recon.mjs
 * Optional overrides:
 *   TRANSLINK_API_BASE   (default the documented https Ext_API endpoint)
 *   TRANSLINK_AUTH_MODE  header|query   (default header, name X-API-TOKEN — same as prod)
 *   RECON_LAT / RECON_LNG   start point (default Belfast City Hall)
 */

const BASE =
  process.env.TRANSLINK_API_BASE?.replace(/\/?$/, "/") ??
  "https://opendata.translinkniplanner.co.uk/Ext_API/";
const KEY = process.env.TRANSLINK_API_KEY;
const AUTH_MODE = process.env.TRANSLINK_AUTH_MODE === "query" ? "query" : "header";
const AUTH_NAME =
  AUTH_MODE === "query"
    ? process.env.TRANSLINK_AUTH_PARAM ?? "key"
    : process.env.TRANSLINK_AUTH_HEADER ?? "X-API-TOKEN";

const LAT = Number(process.env.RECON_LAT ?? "54.5966"); // Belfast City Hall
const LNG = Number(process.env.RECON_LNG ?? "-5.9301");
const WGS84 = "WGS84[DD.DDDDD]";

if (!KEY) {
  console.error("✗ TRANSLINK_API_KEY not set. Run: TRANSLINK_API_KEY=xxx node scripts/transit-recon.mjs");
  process.exit(1);
}

/** One authed EFA GET → parsed JSON (mirrors the production client's auth injection). */
async function efa(endpoint, params) {
  const qs = new URLSearchParams(params);
  const headers = { accept: "application/json" };
  if (AUTH_MODE === "query") qs.set(AUTH_NAME, KEY);
  else headers[AUTH_NAME] = KEY;
  const url = `${BASE}${endpoint}?${qs.toString()}`;
  const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`${endpoint} → ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Keys that would light up each gated feature. Case-insensitive substring match on JSON keys. */
const PROBES = {
  accessibility: /wheelchair|lowfloor|low_floor|lowplatform|accessib|niveau|barrierfree|elevator|escalator|impair/i,
  fare: /\bfare|ticket|tariff|price|\bcost\b|zone/i,
  vehicle: /vehicle|avms|realtimetripid|\bbearing\b|gps|\block\b|occup|position/i,
  stage: /\bstage\b|farestage|fare_stage/i,
};

/** Walk a JSON tree, collecting every distinct key path whose leaf key matches a probe. */
function scan(json, probe) {
  const hits = new Set();
  const visit = (node, path) => {
    if (Array.isArray(node)) return node.slice(0, 3).forEach((v) => visit(v, `${path}[]`));
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (probe.test(k)) hits.add(`${path}.${k} = ${JSON.stringify(v)?.slice(0, 80)}`);
        visit(v, `${path}.${k}`);
      }
    }
  };
  visit(json, "");
  return [...hits];
}

function report(label, json) {
  console.log(`\n══════════ ${label} ══════════`);
  for (const [gate, probe] of Object.entries(PROBES)) {
    const hits = scan(json, probe);
    if (hits.length === 0) {
      console.log(`  ${gate.padEnd(14)} — none found`);
    } else {
      console.log(`  ${gate.padEnd(14)} — ${hits.length} hit(s):`);
      hits.slice(0, 8).forEach((h) => console.log(`      ${h}`));
    }
  }
}

/** Pretty-print one representative record so we can eyeball the real shape. */
function sample(label, obj) {
  if (!obj) return console.log(`\n${label}: (none)`);
  console.log(`\n${label} (first record, full shape):`);
  console.log(JSON.stringify(obj, null, 2).slice(0, 2500));
}

async function main() {
  console.log(`Translink recon → base=${BASE} auth=${AUTH_MODE}:${AUTH_NAME} from=${LAT},${LNG}`);

  // 1. Nearest stop (mirrors fetchNearestStops).
  const coord = await efa("XML_COORD_REQUEST", {
    ext_macro: "coord", outputFormat: "rapidJSON",
    coord: `${LNG}:${LAT}:${WGS84}`, inclFilter: "1", type_1: "STOP", radius_1: "800", max: "5",
  });
  const loc = (coord.locations ?? [])[0];
  const stopId = loc?.properties?.stopID ?? loc?.id;
  console.log(`\nNearest stop: ${loc?.disassembledName ?? loc?.name ?? "?"} (id=${stopId})`);
  if (!stopId) throw new Error("no stop found near the recon point");

  // 2. Departure board — production params (mirrors fetchDepartures).
  const dm = await efa("XML_DM_REQUEST", {
    ext_macro: "dm", outputFormat: "rapidJSON", type_dm: "any", name_dm: String(stopId), limit: "12",
  });
  report("DEPARTURE-MONITOR (production params)", dm);
  sample("stopEvent", (dm.stopEvents ?? [])[0]);

  // 3. Trip — production params (mirrors fetchTrip).
  const tripBase = {
    outputFormat: "rapidJSON", coordOutputFormat: WGS84,
    type_origin: "coord", name_origin: `${LNG}:${LAT}:${WGS84}`,
    type_destination: "coord", name_destination: `-5.8890:54.6079:${WGS84}`, // Titanic Quarter
    calcNumberOfTrips: "4", useRealtime: "1", ptOptionsActive: "1",
  };
  const trip = await efa("XML_TRIP_REQUEST2", tripBase);
  report("TRIP (production params)", trip);
  const firstLeg = (trip.journeys ?? trip.trips ?? [])[0]?.legs?.find((l) => l?.transportation);
  sample("trip transit leg", firstLeg);

  // 4. Trip — RICH params: opt into EFA's accessibility + fare modules to see if more surfaces.
  const tripRich = await efa("XML_TRIP_REQUEST2", {
    ...tripBase,
    imparedOptionsActive: "1", lowPlatformVhcl: "1", wheelchair: "1", // accessibility opt-ins
    calculateFare: "1", tariffCalculation: "1", // fare opt-ins (names vary by EFA build)
  });
  report("TRIP (rich: accessibility + fare opt-ins)", tripRich);

  console.log(`
──────────────────────────────────────────────────────────
READ THE RESULTS:
  • accessibility hits  → we CAN show low-floor/step-free (Phase 3 unblocks). Note the exact key path.
  • fare hits           → the open API returns fares after all (unexpected — flag it).
  • vehicle hits        → some vehicle/occupancy data exists (worth a look).
  • all "none found"     → confirms: build Phases 1–2; fares/tracking need a Translink conversation.
──────────────────────────────────────────────────────────`);
}

main().catch((e) => {
  console.error("\n✗ recon failed:", e.message);
  process.exit(1);
});
