/**
 * Awin Offers sync — pulls advertiser promotions/vouchers from the Awin Offers API into awin_deals,
 * so the public Deals surface (PR 1) reads them from our own DB rather than hitting Awin per view
 * (the API is throttled to 20 req/min). Upsert-by-promotion-id, then retire any previously-active
 * ingested deal that wasn't in this run.
 *
 * Retire strategy: every upserted row is stamped with a single `runStamp`; afterwards we deactivate
 * active, API-sourced rows whose `updated_at` is older than this run — i.e. offers that vanished
 * from the feed. This avoids a giant IN-list and never touches hand-seeded rows (awin_promotion_id
 * null). Crucially we SKIP deactivation entirely when the pull returned nothing, so an API hiccup
 * can never blank the whole surface.
 *
 * RUNNABLE ENTRY at the bottom (guarded), for a manual run / Railway cron; the primary trigger is
 * the internal /jobs/sync-awin-offers route driven by pg_cron.
 */
import { createServiceClient, type RoamClient } from "@roam/db";
import { retrieveOffers, type AwinConfig } from "../awin/client.js";

export interface AwinSyncResult {
  /** Offers returned by the API that mapped cleanly. */
  fetched: number;
  /** Rows upserted into awin_deals. */
  upserted: number;
  /** Previously-active ingested deals retired (no longer in the feed). */
  deactivated: number;
}

// awin_deals isn't in the generated DB types until regenerated post-migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = { from: (t: string) => any };

export async function runAwinOffersSync(
  service: RoamClient,
  cfg: AwinConfig,
  log: (msg: string) => void = () => {},
): Promise<AwinSyncResult> {
  const offers = await retrieveOffers(cfg, log);
  if (offers.length === 0) {
    // Never blanket-deactivate on an empty pull — treat it as "no change" (could be a transient miss).
    log("awin: no offers returned — leaving existing deals untouched.");
    return { fetched: 0, upserted: 0, deactivated: 0 };
  }

  const db = service as unknown as LooseDb;
  const runStamp = new Date().toISOString();
  const rows = offers.map((o) => ({
    awin_promotion_id: o.promotionId,
    advertiser_id: o.advertiserId,
    advertiser_name: o.advertiserName,
    title: o.title,
    description: o.description,
    kind: o.kind,
    voucher_code: o.voucherCode,
    terms: o.terms,
    destination_url: o.destinationUrl,
    image_url: o.imageUrl,
    region: cfg.region,
    starts_at: o.startsAt,
    ends_at: o.endsAt,
    active: true,
    updated_at: runStamp,
  }));

  const { error: upErr } = await db.from("awin_deals").upsert(rows, { onConflict: "awin_promotion_id" });
  if (upErr) throw new Error(`awin upsert failed: ${upErr.message}`);

  // Retire active, API-sourced rows not refreshed this run (their updated_at predates runStamp).
  const { data: deacts, error: deErr } = await db
    .from("awin_deals")
    .update({ active: false, updated_at: runStamp })
    .eq("active", true)
    .not("awin_promotion_id", "is", null)
    .lt("updated_at", runStamp)
    .select("id");
  if (deErr) throw new Error(`awin deactivate failed: ${deErr.message}`);

  const deactivated = Array.isArray(deacts) ? deacts.length : 0;
  log(`awin: upserted ${rows.length}, retired ${deactivated}.`);
  return { fetched: offers.length, upserted: rows.length, deactivated };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[@roam/api] Missing required env var ${name}. Refusing to run the Awin sync.`);
  return v;
}

/** Runner: build the service client + Awin config from host env, run the sync, log the tally. */
async function main(): Promise<void> {
  const service = createServiceClient({
    url: requireEnv("SUPABASE_URL"),
    serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  });
  const cfg: AwinConfig = {
    apiKey: requireEnv("AWIN_API_KEY"),
    publisherId: process.env.AWIN_PUBLISHER_ID ?? null,
    baseUrl: process.env.AWIN_API_BASE ?? "https://api.awin.com",
    region: process.env.AWIN_REGION ?? "GB",
    membership: process.env.AWIN_MEMBERSHIP ?? "joined",
    debug: process.env.AWIN_DEBUG === "1" || process.env.AWIN_DEBUG === "true",
    offersPath: process.env.AWIN_OFFERS_PATH ?? null,
    offersMethod: process.env.AWIN_OFFERS_METHOD ?? null,
  };
  const r = await runAwinOffersSync(service, cfg, (m) => console.log(`  ${m}`));
  console.log(`\nawin sync: fetched ${r.fetched}, upserted ${r.upserted}, retired ${r.deactivated}\n`);
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((e) => {
    console.error("\nAwin sync failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
