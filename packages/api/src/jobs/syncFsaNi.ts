/**
 * FSA NI hygiene sync (C1). Nightly job that pulls the 11 NI local authorities' food-hygiene ratings
 * into `fsa_establishments` and matches each to a Roam venue (writing `external_refs` dataset='fsa'),
 * so the venue page can show the official badge.
 *
 * Shape mirrors deliverOwnerDigest / syncAwinOffers: a pure `runFsaSync(service, cfg, log)` + a guarded
 * `main()`. Trigger: the internal `/jobs/sync-fsa-ni` route (pg_cron) or `pnpm --filter @roam/api
 * sync-fsa-ni`. DORMANT when `FSA_NI_AUTHORITY_IDS` is unset (cfg null → the route returns "unconfigured").
 *
 * Matching reuses the B2 engine exactly (postcode-block + name score via @roam/core/matching), and the
 * B3 discipline: it NEVER overwrites a human `method='manual'` correction, and it skips establishments
 * already linked (bounding nightly work to new/unmatched ones). An empty pull is treated as "no change"
 * (an FSA outage can never blank the corpus).
 */
import { createServiceClient, type RoamClient } from "@roam/db";
import { matching, membership } from "@roam/core";
import { loadFsaConfig, fetchAuthorityEstablishments, type FsaConfig, type ParsedFsaEstablishment } from "../fsa/client.js";

export interface FsaSyncResult {
  authorities: number; // NI councils pulled
  fetched: number; // establishments returned + parsed
  upserted: number; // rows written to fsa_establishments
  matched: number; // NEW venue↔fsa links written this run
  status: "ok" | "unconfigured";
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = { from: (t: string) => any };
const loose = (c: RoamClient) => c as unknown as Loose;

const CHUNK = 500; // upsert / scan page size (cap-proof)
const CANDIDATE_BLOCK_LIMIT = 60; // venues fetched per establishment (postcode-blocked)

/** fhrsids already linked to a venue (external_refs dataset='fsa'), paged past the 1000-row cap. */
async function alreadyLinkedFhrsids(client: RoamClient): Promise<Set<string>> {
  const set = new Set<string>();
  let from = 0;
  for (;;) {
    const { data, error } = await loose(client)
      .from("external_refs")
      .select("external_id")
      .eq("dataset", "fsa")
      .eq("entity_type", "venue")
      .range(from, from + CHUNK - 1);
    if (error) throw new Error(`fsa sync: linked-refs read failed: ${error.message}`);
    const rows = (data ?? []) as { external_id: string }[];
    for (const r of rows) set.add(String(r.external_id));
    if (rows.length < CHUNK) break;
    from += rows.length;
  }
  return set;
}

/** Candidate venues for an establishment, blocked by the postcode outward code (as importRoster does). */
async function candidateVenues(client: RoamClient, postcode: string): Promise<{ id: string; name: string; postcode: string }[]> {
  const outward = membership.outwardCode(postcode);
  if (!outward) return [];
  const pat = `%${outward.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { data, error } = await loose(client)
    .from("venues")
    .select("id, name, address")
    .ilike("address", pat)
    .not("business_status", "eq", "CLOSED_PERMANENTLY")
    .limit(CANDIDATE_BLOCK_LIMIT);
  if (error) throw new Error(`fsa sync: candidate read failed: ${error.message}`);
  return ((data ?? []) as any[]).map((v) => ({
    id: String(v.id),
    name: String(v.name ?? ""),
    postcode: matching.extractPostcode(v.address),
  }));
}

/** Whether a human has already fixed this venue's FSA match — never overwrite a manual correction. */
async function venueHasManualFsaRef(client: RoamClient, venueId: string): Promise<boolean> {
  const { data } = await loose(client)
    .from("external_refs")
    .select("method")
    .eq("entity_type", "venue")
    .eq("entity_id", venueId)
    .eq("dataset", "fsa")
    .maybeSingle();
  return (data as { method?: string } | null)?.method === "manual";
}

export async function runFsaSync(
  service: RoamClient,
  cfg: FsaConfig | null,
  log: (msg: string) => void = () => {},
): Promise<FsaSyncResult> {
  if (!cfg) {
    log("fsa sync: unconfigured (FSA_NI_AUTHORITY_IDS unset) — nothing pulled.");
    return { authorities: 0, fetched: 0, upserted: 0, matched: 0, status: "unconfigured" };
  }

  // 1) Pull every NI authority (best-effort per authority).
  const all: ParsedFsaEstablishment[] = [];
  for (const authorityId of cfg.authorityIds) {
    const rows = await fetchAuthorityEstablishments(cfg, authorityId, log);
    log(`fsa sync: authority ${authorityId} → ${rows.length} establishments`);
    all.push(...rows);
  }
  if (all.length === 0) {
    // Never treat a total blank as "delete everything" — an outage is "no change".
    log("fsa sync: no establishments returned — leaving the corpus untouched.");
    return { authorities: cfg.authorityIds.length, fetched: 0, upserted: 0, matched: 0, status: "ok" };
  }

  // 2) Upsert the corpus on fhrsid, chunked.
  const nowIso = new Date().toISOString();
  let upserted = 0;
  for (let i = 0; i < all.length; i += CHUNK) {
    const slice = all.slice(i, i + CHUNK).map((e) => ({
      fhrsid: e.fhrsid,
      business_name: e.businessName,
      business_type: e.businessType,
      address: e.address,
      postcode: e.postcode,
      rating_value: e.ratingValue,
      rating_key: e.ratingKey,
      rating_date: e.ratingDate,
      local_authority: e.localAuthority,
      lat: e.lat,
      lng: e.lng,
      raw: e.raw,
      synced_at: nowIso,
    }));
    const { error } = await loose(service)
      .from("fsa_establishments")
      .upsert(slice, { onConflict: "fhrsid", ignoreDuplicates: false });
    if (error) throw new Error(`fsa sync: upsert failed: ${error.message}`);
    upserted += slice.length;
  }

  // 3) Match NEW establishments (those not already linked) to venues, reusing the B2 engine.
  const linked = await alreadyLinkedFhrsids(service);
  let matched = 0;
  for (const e of all) {
    if (!e.postcode) continue; // no block key → can't match
    if (linked.has(e.fhrsid)) continue; // already linked to a venue
    const cands = await candidateVenues(service, e.postcode);
    if (cands.length === 0) continue;
    const res = matching.resolveCandidates({ name: e.businessName, postcode: e.postcode }, cands);
    if (res.decision !== "accept" || !res.best) continue;
    const venue = res.best.candidate;
    if (await venueHasManualFsaRef(service, venue.id)) continue; // human correction is permanent
    const { error } = await loose(service)
      .from("external_refs")
      .upsert(
        {
          entity_type: "venue",
          entity_id: venue.id,
          dataset: "fsa",
          external_id: e.fhrsid,
          method: "auto",
          score: Number(res.best.score.toFixed(3)),
        },
        { onConflict: "entity_type,entity_id,dataset", ignoreDuplicates: false },
      );
    if (error) throw new Error(`fsa sync: external_ref write failed: ${error.message}`);
    matched++;
  }

  log(`fsa sync: ${upserted} upserted, ${matched} newly matched across ${cfg.authorityIds.length} authorities.`);
  return { authorities: cfg.authorityIds.length, fetched: all.length, upserted, matched, status: "ok" };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const service = createServiceClient({
    url: requireEnv("SUPABASE_URL"),
    serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  });
  console.log(`\n🍽️  FSA NI hygiene sync — ${new Date().toISOString()}\n`);
  const r = await runFsaSync(service, loadFsaConfig(), (m) => console.log(`  ${m}`));
  console.log("\n──────── summary ────────");
  console.log(`status:      ${r.status}`);
  console.log(`authorities: ${r.authorities}`);
  console.log(`fetched:     ${r.fetched}`);
  console.log(`upserted:    ${r.upserted}`);
  console.log(`matched:     ${r.matched}`);
  console.log("─────────────────────────\n");
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((e) => {
    console.error("\nFSA sync failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
