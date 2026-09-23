/**
 * importRoster — the F2G bulk-onboarding engine (B3-a import + B3-b match).
 *
 * Given a channel and a roster CSV, it:
 *   1. IMPORTS — parses the CSV (@roam/core/membership.parseRosterCsv) and upserts each row into
 *      channel_members, idempotent on (channel_id, membership_ref) so a re-import updates rather than
 *      duplicates (insert vs update counted from the pre-existing ref set).
 *   2. MATCHES — for each member with a postcode, blocks venue candidates by the postcode's outward
 *      code, scores them with @roam/core/matching.resolveCandidates, and on an ACCEPT binds the venue
 *      (channel_members.venue_id) + writes an external_refs auto row — never overwriting a human
 *      method='manual' correction, and never binding a venue another member already holds.
 *      review/reject are counted (the review QUEUE is B4b).
 *   3. Reports the run into channel_import_runs, and returns the thin matched venue ids so the caller
 *      (the web route) can drive the budgeted Places backfill (B3-c) via places.enrichVenue.
 *
 * DRY RUN (holistic plan 2.2). Every step above runs; with `dryRun` nothing is written. That exists
 * because the first contact with a partner's real file should not also be the moment it lands in the
 * roster of record: the operator sees the column mapping, the match split and the rejected rows, fixes
 * the mapping, and only then commits. The counts are computed independently of the writes, so what the
 * rehearsal reports is what the real run does.
 *
 * Runs with the service client under an internalProcedure. Cap-proof where it scans the roster.
 */
import type { RoamClient } from "@roam/db";
import { membership, channels as coreChannels } from "@roam/core";
import { matchRosterMembers } from "./matchRosterMembers.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = { from: (t: string) => any };
const loose = (c: RoamClient) => c as unknown as Loose;

export interface ImportRosterArgs {
  channelKey: string;
  csv: string;
  actorId?: string | null | undefined;
  /** Operator column mapping (header text → canonical field), overriding the alias table. */
  mapping?: Record<string, string> | undefined;
  /**
   * REHEARSE the import: parse, match and report, writing NOTHING — no member upsert, no venue bind,
   * no external_ref, no run row. Defaults to false here (an explicit library call means it), but the
   * tRPC input defaults it to TRUE so the network-facing default cannot silently commit a roster.
   */
  dryRun?: boolean | undefined;
}

export interface ImportRosterReport {
  runId: string | null;
  /** True when nothing was written — the counts are what WOULD happen. */
  dryRun: boolean;
  imported: number;
  updated: number;
  matchedAccept: number;
  matchedReview: number;
  matchedReject: number;
  /**
   * Accepts withheld because the venue is already bound to a DIFFERENT member of this channel.
   * Counted inside matchedReview (they need a human) but broken out so the report says why.
   */
  matchedConflict: number;
  errors: number;
  warnings: number;
  /** Venue ids of freshly-matched venues with thin data — the caller enriches these (B3-c). */
  backfillCandidates: string[];
  /** How each source column was interpreted — shown in the HQ preview before committing. */
  columns: membership.RosterColumn[];
  /** First 50 of each, so a dry run is readable without opening the run record. */
  errorsSample: membership.RosterRowIssue[];
  warningsSample: membership.RosterRowIssue[];
  conflictsSample: { member: string; venueId: string }[];
}

const CHUNK = 500; // upsert / scan page size (cap-proof) // upsert / scan page size (cap-proof)

/** All membership_refs already on the channel, paged past the 1000-row cap. */
async function existingRefs(client: RoamClient, channelId: string): Promise<Set<string>> {
  const refs = new Set<string>();
  let from = 0;
  for (;;) {
    const { data, error } = await loose(client)
      .from("channel_members")
      .select("membership_ref")
      .eq("channel_id", channelId)
      .range(from, from + CHUNK - 1);
    if (error) throw new Error(`importRoster: read refs failed: ${error.message}`);
    const rows = (data ?? []) as { membership_ref: string }[];
    for (const r of rows) refs.add(r.membership_ref);
    if (rows.length < CHUNK) break;
    from += rows.length;
  }
  return refs;
}

export async function importRoster(client: RoamClient, args: ImportRosterArgs): Promise<ImportRosterReport> {
  const startedAt = new Date().toISOString();
  const channel = await coreChannels.getChannelByKey(client, args.channelKey);
  if (!channel) throw new Error(`importRoster: unknown channel '${args.channelKey}'`);
  if (channel.isDefault) throw new Error("importRoster: the default channel has no roster");

  const dryRun = args.dryRun === true;
  const parsed = membership.parseRosterCsv(args.csv, { mapping: args.mapping });
  const seen = await existingRefs(client, channel.id);

  // Count insert vs update from the pre-existing ref set — independent of whether we then write, so a
  // dry run reports exactly the numbers the real run would.
  let imported = 0;
  let updated = 0;
  for (const r of parsed.rows) {
    if (seen.has(r.membershipRef)) updated++; else imported++;
  }

  if (!dryRun) {
    for (let i = 0; i < parsed.rows.length; i += CHUNK) {
      const payload = parsed.rows.slice(i, i + CHUNK).map((r) => ({
        channel_id: channel.id,
        membership_ref: r.membershipRef,
        source_name: r.sourceName,
        source_postcode: r.sourcePostcode,
        source_email: r.sourceEmail,
        source_address: r.sourceAddress,
        source_council: r.sourceCouncil,
        source_phone: r.sourcePhone,
        source_raw: r.raw,
      }));
      const { error } = await loose(client)
        .from("channel_members")
        .upsert(payload, { onConflict: "channel_id,membership_ref", ignoreDuplicates: false });
      if (error) throw new Error(`importRoster: upsert failed: ${error.message}`);
    }
  }

  // Re-read the members by ref to learn their ids — the one thing the parsed rows cannot tell us.
  // Everything the matcher needs comes from the parsed row itself, which is both simpler and what
  // makes a dry run possible: for a row not yet inserted there is no id, but there is a full record.
  const refToId = new Map<string, { id: string }>();
  const allRefs = parsed.rows.map((r) => r.membershipRef);
  for (let i = 0; i < allRefs.length; i += CHUNK) {
    const chunk = allRefs.slice(i, i + CHUNK);
    const { data, error } = await loose(client)
      .from("channel_members")
      .select("id, membership_ref")
      .eq("channel_id", channel.id)
      .in("membership_ref", chunk);
    if (error) throw new Error(`importRoster: member re-read failed: ${error.message}`);
    for (const m of (data ?? []) as any[]) {
      refToId.set(String(m.membership_ref), { id: String(m.id) });
    }
  }

  // Match each member (that has a postcode) and persist accepts — through the SHARED match phase, so
  // the CSV path and the HubSpot sync (plan 2.3) can never drift to different answers about which
  // venue a member is. A dry run has not inserted new members, so those rows carry a null id and the
  // matcher computes their decision without the id-dependent steps.
  const match = await matchRosterMembers(client, {
    channelId: channel.id,
    dryRun,
    members: parsed.rows.map((r) => ({
      id: refToId.get(r.membershipRef)?.id ?? null,
      ref: r.membershipRef,
      name: r.sourceName,
      postcode: r.sourcePostcode,
      address: r.sourceAddress,
    })),
  });
  const matchedAccept = match.accepted;
  const matchedReview = match.review;
  const matchedReject = match.rejected;
  const matchedConflict = match.conflicts;
  const conflictsSample = match.conflictsSample;
  const backfill = match.backfillCandidates;

  const errorsSample = parsed.errors.slice(0, 50);
  const warningsSample = parsed.warnings.slice(0, 50);

  // Persist the run report — a REAL run only. A dry run wrote nothing, so recording it as a run would
  // put a row in the channel's import history for an import that never happened.
  let runId: string | null = null;
  if (!dryRun) {
    const { data: runRow, error: runErr } = await loose(client)
      .from("channel_import_runs")
      .insert({
        channel_id: channel.id,
        actor_id: args.actorId ?? null,
        imported,
        updated,
        matched_accept: matchedAccept,
        matched_review: matchedReview,
        matched_reject: matchedReject,
        errors: parsed.errors.length,
        report: { errorsSample, warningsSample, conflictsSample, columns: parsed.columns },
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle();
    if (runErr) throw new Error(`importRoster: run-report write failed: ${runErr.message}`);
    runId = (runRow as { id?: string } | null)?.id ?? null;
  }

  return {
    runId,
    dryRun,
    imported,
    updated,
    matchedAccept,
    matchedReview,
    matchedReject,
    matchedConflict,
    errors: parsed.errors.length,
    warnings: parsed.warnings.length,
    backfillCandidates: Array.from(backfill),
    columns: parsed.columns,
    errorsSample,
    warningsSample,
    conflictsSample,
  };
}

/** Update a run's backfilled count after the caller (route) has driven B3-c Places enrichment. */
export async function recordImportBackfill(client: RoamClient, runId: string, backfilled: number): Promise<void> {
  const { error } = await loose(client).from("channel_import_runs").update({ backfilled }).eq("id", runId);
  if (error) throw new Error(`importRoster: backfill count write failed: ${error.message}`);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
