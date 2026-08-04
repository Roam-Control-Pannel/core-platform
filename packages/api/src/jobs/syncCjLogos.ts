/**
 * CJ advertiser-logo sync — the companion to syncCjOffers. Collects the distinct advertisers that
 * appear in cj_deals, looks up each one's brand logo via the CJ Advertiser Lookup API, and upserts
 * the result into cj_advertisers. The deals router then attaches those logos to CJ deal cards at read
 * time (as image_url), so a card shows the merchant's real logo instead of the generic category icon.
 *
 * WHY a separate store + job (not cj_deals.image_url): the offers sync upserts whole cj_deals rows
 * every run and would clobber a backfilled logo. Keyed by advertiser, a logo is looked up ONCE and
 * survives every offers sync. This job is safe to run on its own cadence (e.g. daily, after the
 * offers sync) and is fully idempotent (upsert-by-advertiser-id).
 *
 * Best-effort by design: a missing logo is never an error — the card keeps its icon fallback — so
 * this job can no-op or partially resolve without ever blanking the deals surface.
 *
 * RUNNABLE ENTRY at the bottom (guarded), for a manual run / cron; the primary trigger is the
 * internal /jobs/sync-cj-logos route (same internal-secret gate as the other sync routes).
 */
import { createServiceClient, type RoamClient } from "@roam/db";
import { retrieveAdvertiserLogos } from "../cj/advertisers.js";
import type { CjConfig } from "../cj/client.js";

export interface CjLogoSyncResult {
  /** Distinct advertisers found in cj_deals. */
  advertisers: number;
  /** Advertisers the Lookup API resolved. */
  resolved: number;
  /** Rows upserted into cj_advertisers that carry a logo url. */
  withLogos: number;
}

// cj_deals / cj_advertisers aren't in the generated DB types until regenerated post-migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = { from: (t: string) => any };

/** Read the distinct advertiser ids present on active CJ deals — the set worth a logo. Paginates so
 *  the DISTINCT isn't bounded by a single-page row cap. */
async function distinctAdvertiserIds(db: LooseDb): Promise<string[]> {
  const ids = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = (await db
      .from("cj_deals")
      .select("advertiser_id")
      .eq("active", true)
      .range(from, from + PAGE - 1)) as { data: { advertiser_id: string | null }[] | null; error: { message: string } | null };
    if (error) throw new Error(`cj logos: reading advertisers failed: ${error.message}`);
    const rows = data ?? [];
    for (const r of rows) if (r.advertiser_id) ids.add(r.advertiser_id);
    if (rows.length < PAGE) break;
  }
  return [...ids];
}

export async function runCjLogoSync(
  service: RoamClient,
  cfg: CjConfig,
  log: (msg: string) => void = () => {},
): Promise<CjLogoSyncResult> {
  const db = service as unknown as LooseDb;

  const advertiserIds = await distinctAdvertiserIds(db);
  if (advertiserIds.length === 0) {
    log("cj logos: no active CJ advertisers — nothing to look up.");
    return { advertisers: 0, resolved: 0, withLogos: 0 };
  }

  const resolved = await retrieveAdvertiserLogos(cfg, advertiserIds, log);
  if (resolved.size === 0) {
    // Nothing came back (auth/quota/transient) — leave existing logos untouched, never blank them.
    log("cj logos: lookup returned nothing — leaving existing logos untouched.");
    return { advertisers: advertiserIds.length, resolved: 0, withLogos: 0 };
  }

  const runStamp = new Date().toISOString();
  const rows = [...resolved.values()].map((a) => ({
    advertiser_id: a.advertiserId,
    advertiser_name: a.advertiserName,
    logo_url: a.logoUrl,
    updated_at: runStamp,
  }));

  const { error: upErr } = await db.from("cj_advertisers").upsert(rows, { onConflict: "advertiser_id" });
  if (upErr) throw new Error(`cj logos upsert failed: ${upErr.message}`);

  const withLogos = rows.filter((r) => r.logo_url).length;
  log(`cj logos: upserted ${rows.length} advertiser(s), ${withLogos} with a logo.`);
  return { advertisers: advertiserIds.length, resolved: resolved.size, withLogos };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[@roam/api] Missing required env var ${name}. Refusing to run the CJ logo sync.`);
  return v;
}

/** Runner: build the service client + CJ config from host env, run the logo sync, log the tally. */
async function main(): Promise<void> {
  const service = createServiceClient({
    url: requireEnv("SUPABASE_URL"),
    serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  });
  const cfg: CjConfig = {
    token: requireEnv("CJ_API_TOKEN"),
    websiteId: requireEnv("CJ_WEBSITE_ID"),
    baseUrl: process.env.CJ_API_BASE ?? "https://link-search.api.cj.com",
    advertiserLookupBaseUrl: process.env.CJ_ADVERTISER_LOOKUP_BASE ?? "https://advertiser-lookup.api.cj.com",
    advertiserLookupCid: process.env.CJ_CID ?? null,
    advertiserIds: process.env.CJ_ADVERTISER_IDS ?? "joined",
    linkType: process.env.CJ_LINK_TYPE ?? null,
    promotionType: process.env.CJ_PROMOTION_TYPE ?? null,
    promotionalOnly: !(process.env.CJ_ALL_LINKS === "1" || process.env.CJ_ALL_LINKS === "true"),
    maxPerCategory: Number(process.env.CJ_MAX_PER_CATEGORY ?? "0") || 0,
    region: process.env.CJ_REGION ?? "GB",
    debug: process.env.CJ_DEBUG === "1" || process.env.CJ_DEBUG === "true",
  };
  const r = await runCjLogoSync(service, cfg, (m) => console.log(`  ${m}`));
  console.log(`\ncj logo sync: advertisers ${r.advertisers}, resolved ${r.resolved}, with logos ${r.withLogos}\n`);
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((e) => {
    console.error("\nCJ logo sync failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
