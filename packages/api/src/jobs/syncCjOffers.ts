/**
 * CJ Link Search sync — pulls promotional links for the publisher's joined advertisers from the CJ
 * Link Search API into cj_deals, so the public Deals surface reads them from our own DB rather than
 * hitting CJ per view (the API is throttled to 25 req/min). Upsert-by-link-id, then retire any
 * previously-active ingested deal that wasn't in this run. Mirrors the Awin sync (syncAwinOffers)
 * exactly — a second network behind the same store shape.
 *
 * Retire strategy: every upserted row is stamped with a single `runStamp`; afterwards we deactivate
 * active, API-sourced rows whose `updated_at` is older than this run — i.e. links that vanished from
 * the feed. This never touches hand-seeded rows (cj_link_id null), and we SKIP deactivation entirely
 * when the pull returned nothing, so an API hiccup can never blank the whole surface.
 *
 * RUNNABLE ENTRY at the bottom (guarded), for a manual run / Railway cron; the primary trigger is the
 * internal /jobs/sync-cj-offers route (same internal-secret gate as the Awin route).
 */
import { createServiceClient, type RoamClient } from "@roam/db";
import { retrieveDeals, type CjConfig } from "../cj/client.js";

export interface CjSyncResult {
  /** Links returned by the API that mapped cleanly. */
  fetched: number;
  /** Rows upserted into cj_deals. */
  upserted: number;
  /** Previously-active ingested deals retired (no longer in the feed). */
  deactivated: number;
}

// cj_deals isn't in the generated DB types until regenerated post-migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = { from: (t: string) => any };

export async function runCjOffersSync(
  service: RoamClient,
  cfg: CjConfig,
  log: (msg: string) => void = () => {},
): Promise<CjSyncResult> {
  const deals = await retrieveDeals(cfg, log);
  if (deals.length === 0) {
    // Never blanket-deactivate on an empty pull — treat it as "no change" (could be a transient miss).
    log("cj: no deals returned — leaving existing deals untouched.");
    return { fetched: 0, upserted: 0, deactivated: 0 };
  }

  const db = service as unknown as LooseDb;
  const runStamp = new Date().toISOString();
  const rows = deals.map((d) => ({
    cj_link_id: d.linkId,
    advertiser_id: d.advertiserId,
    advertiser_name: d.advertiserName,
    title: d.title,
    description: d.description,
    kind: d.kind,
    voucher_code: d.voucherCode,
    destination_url: d.destinationUrl,
    image_url: d.imageUrl,
    category: d.category,
    region: cfg.region,
    starts_at: d.startsAt,
    ends_at: d.endsAt,
    active: true,
    updated_at: runStamp,
  }));

  const { error: upErr } = await db.from("cj_deals").upsert(rows, { onConflict: "cj_link_id" });
  if (upErr) throw new Error(`cj upsert failed: ${upErr.message}`);

  // Retire active, API-sourced rows not refreshed this run (their updated_at predates runStamp).
  const { data: deacts, error: deErr } = await db
    .from("cj_deals")
    .update({ active: false, updated_at: runStamp })
    .eq("active", true)
    .not("cj_link_id", "is", null)
    .lt("updated_at", runStamp)
    .select("id");
  if (deErr) throw new Error(`cj deactivate failed: ${deErr.message}`);

  const deactivated = Array.isArray(deacts) ? deacts.length : 0;
  log(`cj: upserted ${rows.length}, retired ${deactivated}.`);
  return { fetched: deals.length, upserted: rows.length, deactivated };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[@roam/api] Missing required env var ${name}. Refusing to run the CJ sync.`);
  return v;
}

/** Runner: build the service client + CJ config from host env, run the sync, log the tally. */
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
    advertiserIds: process.env.CJ_ADVERTISER_IDS ?? "joined",
    linkType: process.env.CJ_LINK_TYPE ?? null,
    promotionType: process.env.CJ_PROMOTION_TYPE ?? null,
    promotionalOnly: !(process.env.CJ_ALL_LINKS === "1" || process.env.CJ_ALL_LINKS === "true"),
    maxPerCategory: Number(process.env.CJ_MAX_PER_CATEGORY ?? "0") || 0,
    region: process.env.CJ_REGION ?? "GB",
    debug: process.env.CJ_DEBUG === "1" || process.env.CJ_DEBUG === "true",
  };
  const r = await runCjOffersSync(service, cfg, (m) => console.log(`  ${m}`));
  console.log(`\ncj sync: fetched ${r.fetched}, upserted ${r.upserted}, retired ${r.deactivated}\n`);
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((e) => {
    console.error("\nCJ sync failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
