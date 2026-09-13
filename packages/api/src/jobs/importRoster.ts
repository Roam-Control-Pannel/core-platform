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
 *      method='manual' correction. review/reject are counted (the review QUEUE is B4b).
 *   3. Reports the run into channel_import_runs, and returns the thin matched venue ids so the caller
 *      (the web route) can drive the budgeted Places backfill (B3-c) via places.enrichVenue.
 *
 * Runs with the service client under an internalProcedure. Cap-proof where it scans the roster.
 */
import type { RoamClient } from "@roam/db";
import { membership, matching, channels as coreChannels } from "@roam/core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = { from: (t: string) => any };
const loose = (c: RoamClient) => c as unknown as Loose;

export interface ImportRosterArgs {
  channelKey: string;
  csv: string;
  actorId?: string | null | undefined;
}

export interface ImportRosterReport {
  runId: string | null;
  imported: number;
  updated: number;
  matchedAccept: number;
  matchedReview: number;
  matchedReject: number;
  errors: number;
  warnings: number;
  /** Venue ids of freshly-matched venues with thin data — the caller enriches these (B3-c). */
  backfillCandidates: string[];
}

const MATCH_BLOCK_LIMIT = 60; // candidate venues fetched per member (postcode-blocked)
const CHUNK = 500; // upsert / scan page size (cap-proof)

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

/** Block candidate venues for a member by the postcode outward code (appears in the free-text address). */
async function candidatesFor(client: RoamClient, postcode: string): Promise<{ id: string; name: string; postcode: string; thin: boolean }[]> {
  const outward = membership.outwardCode(postcode);
  if (!outward) return [];
  // Escape ILIKE wildcards in the (trusted, but be safe) outward code.
  const pat = `%${outward.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { data, error } = await loose(client)
    .from("venues")
    .select("id, name, address, opening_times, rating")
    .ilike("address", pat)
    .not("business_status", "eq", "CLOSED_PERMANENTLY")
    .limit(MATCH_BLOCK_LIMIT);
  if (error) throw new Error(`importRoster: candidate read failed: ${error.message}`);
  return ((data ?? []) as any[]).map((v) => ({
    id: String(v.id),
    name: String(v.name ?? ""),
    postcode: matching.extractPostcode(v.address),
    thin: v.rating == null || v.opening_times == null, // needs a Places backfill
  }));
}

/** Whether a human has already fixed this member's match — never overwrite a manual correction. */
async function hasManualRef(client: RoamClient, memberId: string): Promise<boolean> {
  const { data } = await loose(client)
    .from("external_refs")
    .select("method")
    .eq("entity_type", "channel_member")
    .eq("entity_id", memberId)
    .eq("dataset", "roam_venue")
    .maybeSingle();
  return (data as { method?: string } | null)?.method === "manual";
}

export async function importRoster(client: RoamClient, args: ImportRosterArgs): Promise<ImportRosterReport> {
  const startedAt = new Date().toISOString();
  const channel = await coreChannels.getChannelByKey(client, args.channelKey);
  if (!channel) throw new Error(`importRoster: unknown channel '${args.channelKey}'`);
  if (channel.isDefault) throw new Error("importRoster: the default channel has no roster");

  const parsed = membership.parseRosterCsv(args.csv);
  const seen = await existingRefs(client, channel.id);

  let imported = 0;
  let updated = 0;
  // Upsert in chunks; count insert vs update from the pre-existing ref set.
  for (let i = 0; i < parsed.rows.length; i += CHUNK) {
    const slice = parsed.rows.slice(i, i + CHUNK);
    const payload = slice.map((r) => {
      const isNew = !seen.has(r.membershipRef);
      if (isNew) imported++; else updated++;
      return {
        channel_id: channel.id,
        membership_ref: r.membershipRef,
        source_name: r.sourceName,
        source_postcode: r.sourcePostcode,
        source_email: r.sourceEmail,
        source_address: r.sourceAddress,
        source_council: r.sourceCouncil,
        source_phone: r.sourcePhone,
        source_raw: r.raw,
      };
    });
    const { error } = await loose(client)
      .from("channel_members")
      .upsert(payload, { onConflict: "channel_id,membership_ref", ignoreDuplicates: false });
    if (error) throw new Error(`importRoster: upsert failed: ${error.message}`);
  }

  // Re-read the members we just touched (id + fields needed to match), by their refs, chunked.
  const refToId = new Map<string, { id: string; venueId: string | null; postcode: string | null; name: string }>();
  const allRefs = parsed.rows.map((r) => r.membershipRef);
  for (let i = 0; i < allRefs.length; i += CHUNK) {
    const chunk = allRefs.slice(i, i + CHUNK);
    const { data, error } = await loose(client)
      .from("channel_members")
      .select("id, membership_ref, venue_id, source_postcode, source_name")
      .eq("channel_id", channel.id)
      .in("membership_ref", chunk);
    if (error) throw new Error(`importRoster: member re-read failed: ${error.message}`);
    for (const m of (data ?? []) as any[]) {
      refToId.set(String(m.membership_ref), { id: String(m.id), venueId: m.venue_id ?? null, postcode: m.source_postcode ?? null, name: String(m.source_name ?? "") });
    }
  }

  // Match each member (that has a postcode) and persist accepts.
  let matchedAccept = 0;
  let matchedReview = 0;
  let matchedReject = 0;
  const backfill = new Set<string>();
  for (const r of parsed.rows) {
    const m = refToId.get(r.membershipRef);
    if (!m || !m.postcode) continue; // no postcode → cannot block; leave unmatched
    if (await hasManualRef(client, m.id)) continue; // human correction is permanent

    const cands = await candidatesFor(client, m.postcode);
    const res = matching.resolveCandidates({ name: m.name, postcode: m.postcode }, cands);
    if (res.decision === "accept" && res.best) {
      const v = res.best.candidate;
      const { error: refErr } = await loose(client)
        .from("external_refs")
        .upsert(
          {
            entity_type: "channel_member",
            entity_id: m.id,
            dataset: "roam_venue",
            external_id: v.id,
            method: "auto",
            score: Number(res.best.score.toFixed(3)),
          },
          { onConflict: "entity_type,entity_id,dataset", ignoreDuplicates: false },
        );
      if (refErr) throw new Error(`importRoster: external_ref write failed: ${refErr.message}`);
      const { error: bindErr } = await loose(client)
        .from("channel_members")
        .update({ venue_id: v.id })
        .eq("id", m.id);
      if (bindErr) throw new Error(`importRoster: venue bind failed: ${bindErr.message}`);
      matchedAccept++;
      if (v.thin) backfill.add(v.id);
    } else if (res.decision === "review") {
      matchedReview++; // surfaced by the B4b review queue (no auto-bind)
    } else {
      matchedReject++;
    }
  }

  // Persist the run report.
  const report = {
    errorsSample: parsed.errors.slice(0, 50),
    warningsSample: parsed.warnings.slice(0, 50),
  };
  let runId: string | null = null;
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
      report,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();
  if (runErr) throw new Error(`importRoster: run-report write failed: ${runErr.message}`);
  runId = (runRow as { id?: string } | null)?.id ?? null;

  return {
    runId,
    imported,
    updated,
    matchedAccept,
    matchedReview,
    matchedReject,
    errors: parsed.errors.length,
    warnings: parsed.warnings.length,
    backfillCandidates: Array.from(backfill),
  };
}

/** Update a run's backfilled count after the caller (route) has driven B3-c Places enrichment. */
export async function recordImportBackfill(client: RoamClient, runId: string, backfilled: number): Promise<void> {
  const { error } = await loose(client).from("channel_import_runs").update({ backfilled }).eq("id", runId);
  if (error) throw new Error(`importRoster: backfill count write failed: ${error.message}`);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
