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
import { reportJobFailure } from "../observability/ops.js";
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
const CANDIDATE_BLOCK_LIMIT = 2000; // max candidate venues read per postcode block (BT1 is the largest)

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

type Candidate = { id: string; name: string; postcode: string; address: string | null };

/**
 * ALL candidate venues in one postcode outward-code block (e.g. "BT1"), paged past the row cap.
 * Called ONCE per block, not once per establishment: the matching phase groups establishments by
 * outward code first, so a run costs one read per block (a few hundred for NI) instead of one per
 * establishment (~17k) — the difference between a sub-minute run and a 25-minute one, and what
 * lets the nightly cron finish inside a console/cron timeout.
 */
async function candidateVenuesInBlock(client: RoamClient, outward: string): Promise<Candidate[]> {
  const pat = `%${outward.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const out: Candidate[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await loose(client)
      .from("venues")
      .select("id, name, address")
      .ilike("address", pat)
      .not("business_status", "eq", "CLOSED_PERMANENTLY")
      .range(from, from + CHUNK - 1);
    if (error) throw new Error(`fsa sync: candidate read failed: ${error.message}`);
    const rows = (data ?? []) as any[];
    for (const v of rows) {
      out.push({
        id: String(v.id),
        name: String(v.name ?? ""),
        postcode: matching.extractPostcode(v.address),
        address: v.address == null ? null : String(v.address),
      });
    }
    if (rows.length < CHUNK || out.length >= CANDIDATE_BLOCK_LIMIT) break;
    from += rows.length;
  }
  return out;
}

/**
 * Venues a human has DECIDED about, read ONCE per run into a set so the rule costs no per-match
 * round-trip: those with a manual link (method='manual' — never overwrite a correction) and those a
 * reviewer dismissed or unlinked (fsa_match_dismissals, 0148 — never put a removed/wrong link back).
 */
async function humanDecidedVenueIds(client: RoamClient): Promise<Set<string>> {
  const set = new Set<string>();
  let from = 0;
  for (;;) {
    const { data, error } = await loose(client)
      .from("external_refs")
      .select("entity_id")
      .eq("dataset", "fsa")
      .eq("entity_type", "venue")
      .eq("method", "manual")
      .range(from, from + CHUNK - 1);
    if (error) throw new Error(`fsa sync: manual-refs read failed: ${error.message}`);
    const rows = (data ?? []) as { entity_id: string }[];
    for (const r of rows) set.add(String(r.entity_id));
    if (rows.length < CHUNK) break;
    from += rows.length;
  }
  from = 0;
  for (;;) {
    const { data, error } = await loose(client)
      .from("fsa_match_dismissals")
      .select("venue_id")
      .range(from, from + CHUNK - 1);
    if (error) throw new Error(`fsa sync: dismissals read failed: ${error.message}`);
    const rows = (data ?? []) as { venue_id: string }[];
    for (const r of rows) set.add(String(r.venue_id));
    if (rows.length < CHUNK) break;
    from += rows.length;
  }
  return set;
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
    log(`fsa sync: upserted ${upserted}/${all.length}`);
  }

  // 3) Match NEW establishments (those not already linked) to venues, reusing the B2 engine —
  //    BATCHED by postcode outward code: one candidate read per block, all of that block's
  //    establishments scored against it. Same engine, same accept threshold, same decisions.
  const linked = await alreadyLinkedFhrsids(service);
  const manual = await humanDecidedVenueIds(service);
  const blocks = new Map<string, ParsedFsaEstablishment[]>();
  for (const e of all) {
    if (!e.postcode) continue; // no block key → can't match
    if (linked.has(e.fhrsid)) continue; // already linked to a venue
    const outward = membership.outwardCode(e.postcode);
    if (!outward) continue;
    const list = blocks.get(outward);
    if (list) list.push(e);
    else blocks.set(outward, [e]);
  }
  log(`fsa sync: matching ${[...blocks.values()].reduce((n, l) => n + l.length, 0)} unlinked establishments across ${blocks.size} postcode blocks`);

  let matched = 0;
  let blocksDone = 0;
  const claimed = new Set<string>(); // a venue links to ONE establishment per run (first accept wins)
  let pendingRefs: Record<string, unknown>[] = [];
  const flushRefs = async () => {
    if (pendingRefs.length === 0) return;
    const batch = pendingRefs;
    pendingRefs = [];
    const { error } = await loose(service)
      .from("external_refs")
      .upsert(batch, { onConflict: "entity_type,entity_id,dataset", ignoreDuplicates: false });
    if (error) throw new Error(`fsa sync: external_ref write failed: ${error.message}`);
  };

  for (const [outward, ests] of blocks) {
    const cands = await candidateVenuesInBlock(service, outward);
    blocksDone++;
    if (cands.length > 0) {
      for (const e of ests) {
        // Addresses on both sides let the engine strip locality tokens ("Cape Cod Ballymena" ↔ "Cape Cod").
        const res = matching.resolveCandidates({ name: e.businessName, postcode: e.postcode, address: e.address }, cands);
        if (res.decision !== "accept" || !res.best) continue;
        const venue = res.best.candidate;
        if (manual.has(venue.id)) continue; // a human decided (manual link or dismissal) — permanent
        if (claimed.has(venue.id)) continue; // already matched this run
        claimed.add(venue.id);
        pendingRefs.push({
          entity_type: "venue",
          entity_id: venue.id,
          dataset: "fsa",
          external_id: e.fhrsid,
          method: "auto",
          score: Number(res.best.score.toFixed(3)),
        });
        matched++;
        if (pendingRefs.length >= CHUNK) await flushRefs();
      }
    }
    if (blocksDone % 50 === 0 || blocksDone === blocks.size) {
      log(`fsa sync: blocks ${blocksDone}/${blocks.size} · matched ${matched} so far`);
    }
  }
  await flushRefs();

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
  main().catch(async (e) => {
    await reportJobFailure("fsa-sync", e);
    process.exitCode = 1;
  });
}
