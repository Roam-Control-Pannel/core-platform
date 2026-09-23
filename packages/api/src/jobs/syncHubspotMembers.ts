/**
 * HubSpot member sync (F2G plan 2.3) — the Association's CRM becomes the roster of record.
 *
 * The roster spreadsheet they sent has no e-mail column and no membership number (none until 2027),
 * which leaves the onboarding funnel with nothing to activate on and no stable key to re-import
 * against. This job closes both gaps by reading the system they actually maintain:
 *
 *   companies → channel_members  (source_system='hubspot', source_system_id=<company id>)
 *   contacts  → source_email     (the invite/activation credential)
 *
 * IDEMPOTENT BY CONSTRUCTION. Rows are keyed on the company's immutable HubSpot id, so correcting a
 * name or postcode in their CRM updates the member rather than creating a second one — the exact
 * failure the derived CSV key has (see @roam/core/membership/import.ts derivedRef).
 *
 * NEVER DESTRUCTIVE. It inserts and updates; it does not delete, lapse or un-match anybody. A
 * company that disappears from HubSpot is LEFT ALONE: the lifecycle rule ("absent from this sync →
 * lapse after a grace period") is Phase 2.3+ and deliberately not enabled here, because a partner's
 * API returning a short page must never retire real members. An empty pull is treated as no change,
 * for the same reason the FSA sync refuses to blank its corpus on an outage.
 *
 * Matching reuses the shared phase (./matchRosterMembers), so the CSV path and this one can never
 * disagree about which venue a member is.
 */
import { createServiceClient, type RoamClient } from "@roam/db";
import { channels as coreChannels, hubspot } from "@roam/core";
import { reportJobFailure } from "../observability/ops.js";
import { loadHubspotConfig, fetchCompanies, fetchContactsByCompany, type HubspotConfig } from "../hubspot/client.js";
import { matchRosterMembers } from "./matchRosterMembers.js";

export interface HubspotSyncResult {
  status: "ok" | "unconfigured";
  /** Companies read from the portal (after dropping unusable records). */
  fetched: number;
  inserted: number;
  updated: number;
  /** Members that ended the run with an e-mail — the size of the self-serve-capable population. */
  withEmail: number;
  /** Members with no e-mail anywhere in the CRM: these can only ever be activated by HQ. */
  withoutEmail: number;
  /** Companies whose several contacts forced the tie-break rule (the open question, measured). */
  ambiguousContacts: number;
  matchedAccept: number;
  matchedReview: number;
  matchedReject: number;
  matchedConflict: number;
  backfillCandidates: string[];
  dryRun: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = { from: (t: string) => any };
const loose = (c: RoamClient) => c as unknown as Loose;

const CHUNK = 500; // scan / write page size (cap-proof)

/** Existing hubspot-sourced members on this channel: company id → { id, membership_ref }. */
async function existingBySystemId(
  client: RoamClient,
  channelId: string,
): Promise<Map<string, { id: string }>> {
  const out = new Map<string, { id: string }>();
  let from = 0;
  for (;;) {
    const { data, error } = await loose(client)
      .from("channel_members")
      .select("id, source_system_id")
      .eq("channel_id", channelId)
      .eq("source_system", "hubspot")
      .range(from, from + CHUNK - 1);
    if (error) throw new Error(`hubspot sync: existing-member read failed: ${error.message}`);
    const rows = (data ?? []) as { id: string; source_system_id: string | null }[];
    for (const r of rows) if (r.source_system_id) out.set(String(r.source_system_id), { id: String(r.id) });
    if (rows.length < CHUNK) break;
    from += rows.length;
  }
  return out;
}

export interface HubspotSyncArgs {
  /** Only pull companies modified since this instant (a nightly delta). Null = full sync. */
  since?: Date | null | undefined;
  /** Compute and report, write nothing. */
  dryRun?: boolean | undefined;
  actorId?: string | null | undefined;
}

export async function runHubspotSync(
  client: RoamClient,
  cfg: HubspotConfig | null,
  args: HubspotSyncArgs = {},
  log: (msg: string) => void = () => {},
): Promise<HubspotSyncResult> {
  const empty: HubspotSyncResult = {
    status: "unconfigured", fetched: 0, inserted: 0, updated: 0, withEmail: 0, withoutEmail: 0,
    ambiguousContacts: 0, matchedAccept: 0, matchedReview: 0, matchedReject: 0, matchedConflict: 0,
    backfillCandidates: [], dryRun: args.dryRun === true,
  };
  if (!cfg) return empty;

  const dryRun = args.dryRun === true;
  const startedAt = new Date().toISOString();

  const channel = await coreChannels.getChannelByKey(client, cfg.channelKey);
  if (!channel) throw new Error(`hubspot sync: unknown channel '${cfg.channelKey}'`);
  if (channel.isDefault) throw new Error("hubspot sync: the default channel has no roster");

  const companies = await fetchCompanies(cfg, args.since ?? null, log);
  log(`hubspot sync: ${companies.length} company record(s) read${args.since ? " (incremental)" : ""}.`);
  if (companies.length === 0) {
    // Not an error, and explicitly not a reason to touch anything: a partner API returning nothing
    // is indistinguishable from an outage from here.
    return { ...empty, status: "ok", dryRun };
  }

  const contactsByCompany = await fetchContactsByCompany(cfg, companies.map((c) => c.id), log);

  let ambiguousContacts = 0;
  let withEmail = 0;
  const rows = companies.map((company) => {
    const choice = hubspot.pickRosterContact(contactsByCompany.get(company.id) ?? []);
    if (choice.emailCandidates > 1) ambiguousContacts++;
    const row = hubspot.toRosterRow(company, choice.contact);
    if (row.sourceEmail) withEmail++;
    return row;
  });

  const existing = await existingBySystemId(client, channel.id);
  const toInsert = rows.filter((r) => !existing.has(r.sourceSystemId));
  const toUpdate = rows.filter((r) => existing.has(r.sourceSystemId));

  if (!dryRun) {
    // Insert and update separately rather than upserting on the (channel, system, id) index: that
    // index is PARTIAL (`where source_system is not null`, migration 0154) and PostgREST cannot name
    // a partial index as a conflict arbiter, so an upsert would fail at the boundary rather than here.
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const payload = toInsert.slice(i, i + CHUNK).map((r) => ({
        channel_id: channel.id,
        source_system: r.sourceSystem,
        source_system_id: r.sourceSystemId,
        membership_ref: r.membershipRef,
        source_name: r.sourceName,
        source_address: r.sourceAddress,
        source_postcode: r.sourcePostcode,
        source_email: r.sourceEmail,
        source_phone: r.sourcePhone,
        source_raw: r.sourceRaw,
      }));
      const { error } = await loose(client).from("channel_members").insert(payload);
      if (error) throw new Error(`hubspot sync: member insert failed: ${error.message}`);
    }

    for (const r of toUpdate) {
      const target = existing.get(r.sourceSystemId)!;
      // Only the source_* fields are written. status, venue_id, claimed_by and the match state belong
      // to Roam's onboarding, not to the CRM, and a sync must never roll a live member backwards.
      const { error } = await loose(client)
        .from("channel_members")
        .update({
          source_name: r.sourceName,
          source_address: r.sourceAddress,
          source_postcode: r.sourcePostcode,
          source_email: r.sourceEmail,
          source_phone: r.sourcePhone,
          source_raw: r.sourceRaw,
        })
        .eq("id", target.id);
      if (error) throw new Error(`hubspot sync: member update failed: ${error.message}`);
    }
  }

  // Re-read ids so freshly-inserted members can be matched in this same run.
  const afterIds = dryRun ? existing : await existingBySystemId(client, channel.id);
  const match = await matchRosterMembers(client, {
    channelId: channel.id,
    dryRun,
    members: rows.map((r) => ({
      id: afterIds.get(r.sourceSystemId)?.id ?? null,
      ref: r.membershipRef,
      name: r.sourceName,
      postcode: r.sourcePostcode,
      address: r.sourceAddress,
    })),
  });

  if (!dryRun) {
    const { error } = await loose(client).from("channel_import_runs").insert({
      channel_id: channel.id,
      actor_id: args.actorId ?? null,
      imported: toInsert.length,
      updated: toUpdate.length,
      matched_accept: match.accepted,
      matched_review: match.review,
      matched_reject: match.rejected,
      errors: 0,
      report: {
        source: "hubspot",
        incremental: !!args.since,
        withEmail,
        withoutEmail: rows.length - withEmail,
        ambiguousContacts,
        conflictsSample: match.conflictsSample,
      },
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });
    if (error) throw new Error(`hubspot sync: run-report write failed: ${error.message}`);
  }

  log(
    `hubspot sync: ${toInsert.length} inserted, ${toUpdate.length} updated, ` +
      `${withEmail}/${rows.length} with an e-mail, ${match.accepted} matched.`,
  );

  return {
    status: "ok",
    fetched: rows.length,
    inserted: toInsert.length,
    updated: toUpdate.length,
    withEmail,
    withoutEmail: rows.length - withEmail,
    ambiguousContacts,
    matchedAccept: match.accepted,
    matchedReview: match.review,
    matchedReject: match.rejected,
    matchedConflict: match.conflicts,
    backfillCandidates: match.backfillCandidates,
    dryRun,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** How far back a scheduled run looks. Generous overlap: re-reading a member is free and idempotent,
 * missing one because a clock drifted is not. */
const INCREMENTAL_WINDOW_MS = 36 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const service = createServiceClient({
    url: requireEnv("SUPABASE_URL"),
    serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  });
  const full = process.argv.includes("--full");
  const dryRun = process.argv.includes("--dry-run");
  console.log(`\n🧾  HubSpot member sync — ${new Date().toISOString()}${full ? " (full)" : ""}${dryRun ? " (dry run)" : ""}\n`);
  const r = await runHubspotSync(
    service,
    loadHubspotConfig(),
    { since: full ? null : new Date(Date.now() - INCREMENTAL_WINDOW_MS), dryRun },
    (m) => console.log(`  ${m}`),
  );
  console.log("\n──────── summary ────────");
  console.log(`status:        ${r.status}`);
  console.log(`fetched:       ${r.fetched}`);
  console.log(`inserted:      ${r.inserted}`);
  console.log(`updated:       ${r.updated}`);
  console.log(`with e-mail:   ${r.withEmail}`);
  console.log(`no e-mail:     ${r.withoutEmail}`);
  console.log(`ambiguous:     ${r.ambiguousContacts}`);
  console.log(`matched:       ${r.matchedAccept}`);
  console.log(`review:        ${r.matchedReview} (of which ${r.matchedConflict} venue conflicts)`);
  console.log("─────────────────────────\n");
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch(async (e) => {
    await reportJobFailure("hubspot-sync", e);
    process.exitCode = 1;
  });
}
