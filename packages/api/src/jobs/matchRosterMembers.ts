/**
 * matchRosterMembers — the ONE roster→venue matching phase, shared by every roster source.
 *
 * Extracted from importRoster when the HubSpot sync (plan 2.3) became a second way for members to
 * arrive. Two copies of this would be two definitions of "which venue is this member", and migration
 * 0154 exists precisely because that had already happened once with "what is a member": the ranking
 * helper, the directory and the entitlements had each drifted to a different answer.
 *
 * What it does, per member with a postcode:
 *   1. Blocks candidate venues by the postcode's outward code.
 *   2. Scores them with @roam/core/matching (name similarity in context + postcode agreement).
 *   3. On an unambiguous ACCEPT, binds channel_members.venue_id and writes an external_refs auto row.
 *
 * Three refusals, all deliberate:
 *   * a human `method='manual'` correction is permanent and is never overwritten;
 *   * a venue already held by ANOTHER member of this channel is never taken — with no membership
 *     number to prove identity, the roster match IS the identity claim behind activation, so one
 *     venue bound to two members would let the wrong business activate it;
 *   * review/reject never bind anything; they are counted and left for the B4b review queue.
 */
import type { RoamClient } from "@roam/db";
import { matching, membership } from "@roam/core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loose = { from: (t: string) => any };
const loose = (c: RoamClient) => c as unknown as Loose;

const MATCH_BLOCK_LIMIT = 60; // candidate venues fetched per member (postcode-blocked)
const CHUNK = 500; // scan page size (cap-proof)

/** One member to match. `id` is null for a row that does not exist yet (a dry run). */
export interface MatchableMember {
  id: string | null;
  /** The stable key, used to name the member in conflict reports. */
  ref: string;
  name: string;
  postcode: string | null;
  address: string | null;
}

export interface MatchPhaseResult {
  accepted: number;
  review: number;
  rejected: number;
  /** Accepts withheld because the venue belongs to another member (counted inside `review` too). */
  conflicts: number;
  conflictsSample: { member: string; venueId: string }[];
  /** Venue ids of freshly-matched venues with thin data — the caller enriches these (B3-c). */
  backfillCandidates: string[];
}

/** Block candidate venues for a member by the postcode outward code. */
async function candidatesFor(client: RoamClient, postcode: string) {
  const outward = membership.outwardCode(postcode);
  if (!outward) return [];
  const pat = `%${outward.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { data, error } = await loose(client)
    .from("venues")
    .select("id, name, address, opening_times, rating")
    .ilike("address", pat)
    .not("business_status", "eq", "CLOSED_PERMANENTLY")
    .limit(MATCH_BLOCK_LIMIT);
  if (error) throw new Error(`matchRosterMembers: candidate read failed: ${error.message}`);
  return ((data ?? []) as any[]).map((v) => ({
    id: String(v.id),
    name: String(v.name ?? ""),
    postcode: matching.extractPostcode(v.address),
    address: v.address == null ? null : String(v.address), // lets the engine strip locality tokens
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

/**
 * Every venue already bound to a member of this channel → the member holding it. Read ONCE and paged
 * past the 1000-row cap, so the duplicate-venue guard costs no per-member round trip.
 */
export async function boundVenues(client: RoamClient, channelId: string): Promise<Map<string, string>> {
  const bound = new Map<string, string>();
  let from = 0;
  for (;;) {
    const { data, error } = await loose(client)
      .from("channel_members")
      .select("id, venue_id")
      .eq("channel_id", channelId)
      .not("venue_id", "is", null)
      .range(from, from + CHUNK - 1);
    if (error) throw new Error(`matchRosterMembers: bound-venue read failed: ${error.message}`);
    const rows = (data ?? []) as { id: string; venue_id: string | null }[];
    for (const r of rows) if (r.venue_id) bound.set(String(r.venue_id), String(r.id));
    if (rows.length < CHUNK) break;
    from += rows.length;
  }
  return bound;
}

/**
 * Run the match phase over `members`. With `dryRun` nothing is written — the decisions are computed
 * and counted exactly as a real run would, which is what makes a rehearsal trustworthy.
 */
export async function matchRosterMembers(
  client: RoamClient,
  args: { channelId: string; members: readonly MatchableMember[]; dryRun?: boolean | undefined },
): Promise<MatchPhaseResult> {
  const dryRun = args.dryRun === true;
  let accepted = 0;
  let review = 0;
  let rejected = 0;
  let conflicts = 0;
  const conflictsSample: { member: string; venueId: string }[] = [];
  const backfill = new Set<string>();

  // Seeded from the DB and extended as this run binds, so two rows of the SAME batch cannot both
  // take one venue either.
  const taken = await boundVenues(client, args.channelId);

  for (const m of args.members) {
    if (!m.postcode) continue; // no postcode → cannot block; leave unmatched
    if (m.id && (await hasManualRef(client, m.id))) continue; // human correction is permanent

    const cands = await candidatesFor(client, m.postcode);
    // The roster ADDRESS is context, not a key: the matcher uses it only to strip locality tokens out
    // of the name before comparing ("Apache Lisburn" vs Google's "Apache Pizza").
    const res = matching.resolveCandidates(
      { name: m.name, postcode: m.postcode, address: m.address },
      cands,
    );

    if (res.decision === "accept" && res.best) {
      const v = res.best.candidate;
      const holder = taken.get(v.id);
      if (holder && (!m.id || holder !== m.id)) {
        conflicts++;
        review++;
        if (conflictsSample.length < 50) conflictsSample.push({ member: m.ref, venueId: v.id });
        continue;
      }

      if (!dryRun && m.id) {
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
        if (refErr) throw new Error(`matchRosterMembers: external_ref write failed: ${refErr.message}`);
        const { error: bindErr } = await loose(client)
          .from("channel_members")
          .update({ venue_id: v.id })
          .eq("id", m.id);
        if (bindErr) throw new Error(`matchRosterMembers: venue bind failed: ${bindErr.message}`);
      }
      taken.set(v.id, m.id ?? m.ref);
      accepted++;
      if (v.thin) backfill.add(v.id);
    } else if (res.decision === "review") {
      review++; // surfaced by the B4b review queue (no auto-bind)
    } else {
      rejected++;
    }
  }

  return {
    accepted,
    review,
    rejected,
    conflicts,
    conflictsSample,
    backfillCandidates: Array.from(backfill),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
