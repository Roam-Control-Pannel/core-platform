/**
 * Roam HQ — F2G match-review queue (B4b).
 *
 * B3-b's importer auto-binds only confident, unambiguous matches; ambiguous or weak ones are left
 * UNBOUND (channel_members.venue_id is null) for a human. This module is the staff review surface over
 * exactly those rows:
 *
 *   channelReviewQueue — unbound, non-dismissed members with their RANKED candidate venues. The
 *     matcher (@roam/core/matching) is re-run ON DEMAND per member, so there is no stored candidate
 *     state to drift; the ranking + scores are computed from live data every time.
 *   confirmMatch       — a reviewer picks the right venue: writes a method='manual' external_ref (the
 *     correction of record, which importRoster never overwrites) and binds channel_members.venue_id.
 *   setMatchDismissed  — a reviewer marks "none of these is it" so the member drops out of the queue
 *     (the sticky negative decision persisted by migration 0140); a later confirm clears it.
 *
 * All reads/writes run with the service-role client under adminProcedure (channel_members is
 * service-managed); every mutation is attributed + audited via recordAudit, like the rest of HQ.
 */
import type { RoamClient } from "@roam/db";
import { loose } from "./loose.js";
import { recordAudit, type AdminActor } from "./actions.js";
import { getChannelByKey } from "../channels/index.js";
import {
  extractPostcode,
  resolveCandidates,
  MATCH_THRESHOLDS,
  type PostcodeAgreement,
} from "../matching/index.js";
import { outwardCode } from "../membership/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CANDIDATE_BLOCK_LIMIT = 60; // venues fetched per member (postcode-blocked)
const CANDIDATES_RETURNED = 6; // top-N shown in the review UI

/** One candidate venue for a member, with its match score broken out for the reviewer. */
export interface ReviewCandidate {
  venueId: string;
  name: string;
  address: string | null;
  slug: string | null;
  score: number;
  nameScore: number;
  postcode: PostcodeAgreement;
  /** Thin Roam data (no rating/hours) — a confirm would want a Places backfill (B3-c). */
  thin: boolean;
}

/** One member awaiting a match decision, with its ranked candidates. */
export interface ReviewItem {
  memberId: string;
  sourceName: string;
  sourcePostcode: string | null;
  sourceAddress: string | null;
  sourceCouncil: string | null;
  status: string;
  /** The highest candidate score (0 when there are no candidates) — the queue sort key. */
  bestScore: number;
  candidates: ReviewCandidate[];
}

export interface ReviewQueuePage {
  items: ReviewItem[];
  hasMore: boolean;
  nextOffset: number;
}

/** Block candidate venues for a member by the postcode outward code (as importRoster does). */
async function candidateVenuesFor(
  client: RoamClient,
  postcode: string,
): Promise<{ id: string; name: string; postcode: string; address: string | null; slug: string | null; thin: boolean }[]> {
  const outward = outwardCode(postcode);
  if (!outward) return [];
  const pat = `%${outward.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { data, error } = await loose(client)
    .from("venues")
    .select("id, name, address, slug, opening_times, rating")
    .ilike("address", pat)
    .not("business_status", "eq", "CLOSED_PERMANENTLY")
    .limit(CANDIDATE_BLOCK_LIMIT);
  if (error) throw new Error(`admin: review candidate read failed: ${error.message}`);
  return ((data ?? []) as any[]).map((v) => ({
    id: String(v.id),
    name: String(v.name ?? ""),
    postcode: extractPostcode(v.address),
    address: v.address ?? null,
    slug: v.slug ?? null,
    thin: v.rating == null || v.opening_times == null,
  }));
}

/**
 * A page of the channel's match-review queue: unbound (venue_id null) members that have a postcode to
 * block on and are not dismissed, each with its ranked candidate venues. Members are read newest-first,
 * limit+1 for hasMore; within the page, items are ordered by best candidate score (most confident
 * first). `includeDismissed` also returns previously-dismissed members (so a mistaken dismiss can be
 * revisited).
 */
export async function channelReviewQueue(
  client: RoamClient,
  args: { channelKey: string; limit: number; offset: number; includeDismissed?: boolean | undefined },
): Promise<ReviewQueuePage> {
  const channel = await getChannelByKey(client, args.channelKey);
  if (!channel) throw new Error(`admin: unknown channel '${args.channelKey}'`);

  let query = loose(client)
    .from("channel_members")
    .select("id, source_name, source_postcode, source_address, source_council, status, match_dismissed_at")
    .eq("channel_id", channel.id)
    .is("venue_id", null)
    .not("source_postcode", "is", null)
    .order("created_at", { ascending: false })
    .range(args.offset, args.offset + args.limit); // limit+1 → hasMore
  if (!args.includeDismissed) query = query.is("match_dismissed_at", null);

  const { data, error } = await query;
  if (error) throw new Error(`admin: review queue read failed: ${error.message}`);
  const raw = (data ?? []) as any[];
  const hasMore = raw.length > args.limit;
  const page = hasMore ? raw.slice(0, args.limit) : raw;

  const items: ReviewItem[] = [];
  for (const m of page) {
    const postcode = m.source_postcode ? String(m.source_postcode) : null;
    const cands = postcode ? await candidateVenuesFor(client, postcode) : [];
    // Pass the roster address for locality-token stripping, exactly as importRoster does — the queue
    // re-scores on demand, so if the two disagreed the reviewer would be shown a different number
    // from the one that sent the member here.
    const res = resolveCandidates(
      { name: String(m.source_name ?? ""), postcode, address: m.source_address ?? null },
      cands,
    );
    // Only surface candidates that clear the review floor — below it is noise, not a plausible match.
    const shown = res.ranked
      .filter((c) => c.score >= MATCH_THRESHOLDS.review)
      .slice(0, CANDIDATES_RETURNED)
      .map((c) => ({
        venueId: c.candidate.id,
        name: c.candidate.name,
        address: c.candidate.address,
        slug: c.candidate.slug,
        score: Number(c.score.toFixed(3)),
        nameScore: Number(c.nameScore.toFixed(3)),
        postcode: c.postcode,
        thin: c.candidate.thin,
      }));
    items.push({
      memberId: String(m.id),
      sourceName: String(m.source_name ?? ""),
      sourcePostcode: postcode,
      sourceAddress: m.source_address ?? null,
      sourceCouncil: m.source_council ?? null,
      status: String(m.status ?? ""),
      bestScore: shown[0]?.score ?? 0,
      candidates: shown,
    });
  }
  // Most confident matches first within the page.
  items.sort((a, b) => b.bestScore - a.bestScore);

  return { items, hasMore, nextOffset: args.offset + page.length };
}

/**
 * Confirm a reviewer's chosen venue for a member: the manual match of record. Writes/updates the
 * external_refs row (method='manual', matched_by=actor) and binds channel_members.venue_id, clearing
 * any prior dismissal. Refuses if the venue is already the confirmed match of a DIFFERENT member (a
 * venue maps to at most one roster member).
 */
export async function confirmMatch(
  client: RoamClient,
  actor: AdminActor,
  args: { channelKey: string; memberId: string; venueId: string },
): Promise<void> {
  const channel = await getChannelByKey(client, args.channelKey);
  if (!channel) throw new Error(`admin: unknown channel '${args.channelKey}'`);

  // The member must belong to this channel (scope the write; never touch another channel's roster).
  const { data: member, error: mErr } = await loose(client)
    .from("channel_members")
    .select("id, channel_id")
    .eq("id", args.memberId)
    .eq("channel_id", channel.id)
    .maybeSingle();
  if (mErr) throw new Error(`admin: confirm-match member read failed: ${mErr.message}`);
  if (!member) throw new Error("admin: member not found on this channel");

  // No two members may confirm the same venue.
  const { data: clash, error: cErr } = await loose(client)
    .from("external_refs")
    .select("entity_id")
    .eq("dataset", "roam_venue")
    .eq("external_id", args.venueId)
    .eq("entity_type", "channel_member")
    .maybeSingle();
  if (cErr) throw new Error(`admin: confirm-match clash check failed: ${cErr.message}`);
  if (clash && String((clash as any).entity_id) !== args.memberId) {
    throw new Error("admin: that venue is already matched to another member");
  }

  const { error: refErr } = await loose(client)
    .from("external_refs")
    .upsert(
      {
        entity_type: "channel_member",
        entity_id: args.memberId,
        dataset: "roam_venue",
        external_id: args.venueId,
        method: "manual",
        matched_by: actor.id,
      },
      { onConflict: "entity_type,entity_id,dataset", ignoreDuplicates: false },
    );
  if (refErr) throw new Error(`admin: confirm-match external_ref write failed: ${refErr.message}`);

  const { error: bindErr } = await loose(client)
    .from("channel_members")
    .update({ venue_id: args.venueId, match_dismissed_at: null, match_dismissed_by: null })
    .eq("id", args.memberId);
  if (bindErr) throw new Error(`admin: confirm-match bind failed: ${bindErr.message}`);

  await recordAudit(client, actor, {
    action: "confirm_match",
    entityType: "channel_member",
    entityId: args.memberId,
    detail: { channel: args.channelKey, venueId: args.venueId },
  });
}

/**
 * Mark a member's match as dismissed ("none of these candidates is it") or undo that, then audit. A
 * dismissed member drops out of the default review queue; it never touches venue_id, so a later
 * confirmMatch can still bind a venue (and will clear the dismissal).
 */
export async function setMatchDismissed(
  client: RoamClient,
  actor: AdminActor,
  args: { channelKey: string; memberId: string; dismissed: boolean },
): Promise<void> {
  const channel = await getChannelByKey(client, args.channelKey);
  if (!channel) throw new Error(`admin: unknown channel '${args.channelKey}'`);

  const { error } = await loose(client)
    .from("channel_members")
    .update(
      args.dismissed
        ? { match_dismissed_at: new Date().toISOString(), match_dismissed_by: actor.id }
        : { match_dismissed_at: null, match_dismissed_by: null },
    )
    .eq("id", args.memberId)
    .eq("channel_id", channel.id);
  if (error) throw new Error(`admin: dismiss-match write failed: ${error.message}`);

  await recordAudit(client, actor, {
    action: args.dismissed ? "dismiss_match" : "undismiss_match",
    entityType: "channel_member",
    entityId: args.memberId,
    detail: { channel: args.channelKey },
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
