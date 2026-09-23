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
import { membership, matching, channels as coreChannels } from "@roam/core";

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
async function candidatesFor(client: RoamClient, postcode: string): Promise<{ id: string; name: string; postcode: string; address: string | null; thin: boolean }[]> {
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
    address: v.address == null ? null : String(v.address), // lets the engine strip locality tokens
    thin: v.rating == null || v.opening_times == null, // needs a Places backfill
  }));
}

/**
 * Every venue already bound to a member of this channel → the member holding it. Read ONCE and paged
 * past the 1000-row cap, so the duplicate-venue guard costs no per-member round trip.
 */
async function boundVenues(client: RoamClient, channelId: string): Promise<Map<string, string>> {
  const bound = new Map<string, string>();
  let from = 0;
  for (;;) {
    const { data, error } = await loose(client)
      .from("channel_members")
      .select("id, venue_id")
      .eq("channel_id", channelId)
      .not("venue_id", "is", null)
      .range(from, from + CHUNK - 1);
    if (error) throw new Error(`importRoster: bound-venue read failed: ${error.message}`);
    const rows = (data ?? []) as { id: string; venue_id: string | null }[];
    for (const r of rows) if (r.venue_id) bound.set(String(r.venue_id), String(r.id));
    if (rows.length < CHUNK) break;
    from += rows.length;
  }
  return bound;
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

  // Match each member (that has a postcode) and persist accepts.
  let matchedAccept = 0;
  let matchedReview = 0;
  let matchedReject = 0;
  let matchedConflict = 0;
  const backfill = new Set<string>();
  const conflictsSample: { member: string; venueId: string }[] = [];
  // Venue → member already holding it. Seeded from the DB and extended as this run binds, so two rows
  // of the SAME file cannot both take one venue either.
  const taken = await boundVenues(client, channel.id);

  for (const r of parsed.rows) {
    const m = refToId.get(r.membershipRef);
    // A dry run has not inserted new members, so `m` is absent for them — match on the parsed row and
    // simply skip the id-dependent steps (nothing manual can exist for a row that does not exist yet).
    if (!dryRun && !m) continue;
    const postcode = r.sourcePostcode;
    if (!postcode) continue; // no postcode → cannot block; leave unmatched
    if (m && (await hasManualRef(client, m.id))) continue; // human correction is permanent

    const cands = await candidatesFor(client, postcode);
    // The roster ADDRESS is passed as context, not as a key: the matcher uses it only to strip
    // locality tokens out of the name before comparing ("Apache Lisburn" vs Google's "Apache Pizza"),
    // which is exactly the shape real roster names take. Withholding it threw away the strongest
    // disambiguator we hold — and the review queue re-scores from the same persisted column, so both
    // surfaces now agree on the score.
    const res = matching.resolveCandidates(
      { name: r.sourceName, postcode, address: r.sourceAddress },
      cands,
    );

    if (res.decision === "accept" && res.best) {
      const v = res.best.candidate;
      // A venue belongs to at most ONE member. With no membership number to prove identity, the
      // roster match IS the identity claim behind activation, so binding one venue to two members
      // would let the wrong business be activated. confirmMatch has always refused this on the manual
      // path (reviewQueue.ts); the automatic path silently allowed it. Withheld → human review.
      const holder = taken.get(v.id);
      if (holder && (!m || holder !== m.id)) {
        matchedConflict++;
        matchedReview++;
        if (conflictsSample.length < 50) conflictsSample.push({ member: r.membershipRef, venueId: v.id });
        continue;
      }

      if (!dryRun && m) {
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
      }
      taken.set(v.id, m?.id ?? r.membershipRef);
      matchedAccept++;
      if (v.thin) backfill.add(v.id);
    } else if (res.decision === "review") {
      matchedReview++; // surfaced by the B4b review queue (no auto-bind)
    } else {
      matchedReject++;
    }
  }

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
