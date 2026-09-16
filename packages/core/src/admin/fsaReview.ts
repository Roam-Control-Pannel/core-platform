/**
 * Roam HQ — FSA hygiene-rating match review (backlog #51).
 *
 * The FSA sync (api/jobs/syncFsaNi) auto-links a venue to its FSA establishment only on a confident,
 * unambiguous match (full-postcode agreement + a strong contextual name score). Everything else is
 * left UNLINKED for a human: a moderate name score, a tie between two candidates (a chain's two
 * branches on one postcode), a venue the FSA holds under a neighbouring postcode, or one it simply
 * has no record for. This module is the staff surface over exactly those venues — the FSA twin of
 * the B4b roster queue (reviewQueue.ts), and deliberately the same shape:
 *
 *   fsaReviewQueue       — food venues with no FSA link (and not dismissed), each with its RANKED
 *                          candidate establishments from the same postcode block, re-scored ON DEMAND
 *                          by @roam/core/matching — no stored candidate state to drift.
 *   fsaSearch            — free-text search of the FSA corpus, for the venue whose record sits under
 *                          another postcode or a different trading name.
 *   confirmFsaMatch      — the positive decision: an external_refs row (dataset='fsa',
 *                          method='manual', permanent — the sync never overwrites it).
 *   unlinkFsaMatch       — remove a WRONG link (auto or manual) AND dismiss, so the nightly sync
 *                          cannot put it back; a later confirm clears the dismissal.
 *   setFsaMatchDismissed — the negative decision ("no FSA record is this venue"): the venue leaves
 *                          the queue and the sync skips it (fsa_match_dismissals, 0148).
 *   fsaCoverage          — the headline numbers for the tab.
 *
 * A wrong hygiene rating is a legal exposure, so every mutation is attributed + audited via
 * recordAudit, like the rest of HQ. All reads/writes run with the service-role client under
 * adminProcedure (fsa_match_dismissals and external_refs are service-managed).
 */
import type { RoamClient } from "@roam/db";
import { loose } from "./loose.js";
import { recordAudit, type AdminActor } from "./actions.js";
import {
  extractPostcode,
  resolveCandidates,
  MATCH_THRESHOLDS,
  type MatchDecision,
  type PostcodeAgreement,
} from "../matching/index.js";
import { outwardCode } from "../membership/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const VENUE_PAGE = 200; // venues scanned per DB page while filling a queue page
const MAX_SCAN = 2000; // hard cap on venues scanned per call (bounds a sparse queue)
const FSA_BLOCK_LIMIT = 2000; // establishments read per postcode block
const CANDIDATES_RETURNED = 6; // top-N shown in the review UI
const PAGE = 500; // paged set reads

/** The venue group the FSA scheme covers — Roam's canonical "Food & Drink" pill value. */
const FOOD_CATEGORY = "Food & Drink";

/** One candidate FSA establishment for a venue, with its match score broken out for the reviewer. */
export interface FsaReviewCandidate {
  fhrsid: string;
  name: string;
  address: string | null;
  postcode: string | null;
  /** The FSA's verbatim rating value ("5", "Awaiting inspection", …) — display only. */
  ratingValue: string | null;
  localAuthority: string | null;
  score: number;
  nameScore: number;
  postcodeAgreement: PostcodeAgreement;
}

/** One venue awaiting an FSA decision, with its ranked candidates. */
export interface FsaReviewItem {
  venueId: string;
  name: string;
  address: string | null;
  slug: string | null;
  postcode: string;
  /** What the engine would have done: review (plausible but not certain) or reject (no candidate). */
  decision: MatchDecision;
  bestScore: number;
  dismissed: boolean;
  dismissedNote: string | null;
  candidates: FsaReviewCandidate[];
}

export interface FsaReviewPage {
  items: FsaReviewItem[];
  hasMore: boolean;
  /** The venue offset to resume from (venues are scanned in a stable name+id order). */
  nextOffset: number;
  /** Venues scanned to fill this page — a diagnostic for a sparse queue. */
  scanned: number;
}

export interface FsaCoverage {
  /** Google-sourced venues in the Food & Drink group. */
  foodVenues: number;
  /** Venues with an FSA link (auto or manual). */
  linked: number;
  /** Venues a reviewer dismissed. */
  dismissed: number;
  /** linked / foodVenues, as a percentage (0 when there are no venues). */
  pct: number;
}

type FsaCand = {
  id: string; // fhrsid
  name: string;
  postcode: string;
  address: string | null;
  ratingValue: string | null;
  localAuthority: string | null;
};

/** Venue ids that already carry an FSA link, paged past the row cap. */
async function linkedVenueIds(client: RoamClient): Promise<Set<string>> {
  const set = new Set<string>();
  let from = 0;
  for (;;) {
    const { data, error } = await loose(client)
      .from("external_refs")
      .select("entity_id")
      .eq("dataset", "fsa")
      .eq("entity_type", "venue")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`admin: fsa linked-refs read failed: ${error.message}`);
    const rows = (data ?? []) as { entity_id: string }[];
    for (const r of rows) set.add(String(r.entity_id));
    if (rows.length < PAGE) break;
    from += rows.length;
  }
  return set;
}

/** Dismissed venue ids → note. */
async function dismissedVenues(client: RoamClient): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  let from = 0;
  for (;;) {
    const { data, error } = await loose(client)
      .from("fsa_match_dismissals")
      .select("venue_id, note")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`admin: fsa dismissals read failed: ${error.message}`);
    const rows = (data ?? []) as { venue_id: string; note: string | null }[];
    for (const r of rows) map.set(String(r.venue_id), r.note ?? null);
    if (rows.length < PAGE) break;
    from += rows.length;
  }
  return map;
}

function toCand(e: any): FsaCand {
  return {
    id: String(e.fhrsid),
    name: String(e.business_name ?? ""),
    postcode: String(e.postcode ?? ""),
    address: e.address == null ? null : String(e.address),
    ratingValue: e.rating_value == null ? null : String(e.rating_value),
    localAuthority: e.local_authority == null ? null : String(e.local_authority),
  };
}

/** Every FSA establishment in one postcode outward-code block (e.g. "BT1"). */
async function fsaCandidatesInBlock(client: RoamClient, outward: string): Promise<FsaCand[]> {
  const pat = `${outward.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { data, error } = await loose(client)
    .from("fsa_establishments")
    .select("fhrsid, business_name, address, postcode, rating_value, local_authority")
    .ilike("postcode", pat)
    .limit(FSA_BLOCK_LIMIT);
  if (error) throw new Error(`admin: fsa block read failed: ${error.message}`);
  // "BT1%" also matches BT10–BT19: keep only the exact outward code.
  return ((data ?? []) as any[]).map(toCand).filter((c) => outwardCode(c.postcode) === outward);
}

function present(c: { candidate: FsaCand; score: number; nameScore: number; postcode: PostcodeAgreement }): FsaReviewCandidate {
  return {
    fhrsid: c.candidate.id,
    name: c.candidate.name,
    address: c.candidate.address,
    postcode: c.candidate.postcode || null,
    ratingValue: c.candidate.ratingValue,
    localAuthority: c.candidate.localAuthority,
    score: Number(c.score.toFixed(3)),
    nameScore: Number(c.nameScore.toFixed(3)),
    postcodeAgreement: c.postcode,
  };
}

/**
 * The queue page. Scans Food & Drink venues in a stable order, skipping linked (and, by default,
 * dismissed) ones and any whose postcode block holds no FSA establishments at all (outside the
 * synced corpus — e.g. GB venues while only NI is configured), and re-scores each survivor against
 * its block. Bounded by MAX_SCAN so a sparse queue can't turn into a full-table walk.
 */
export async function fsaReviewQueue(
  client: RoamClient,
  args: { limit: number; offset: number; includeDismissed?: boolean | undefined },
): Promise<FsaReviewPage> {
  const linked = await linkedVenueIds(client);
  const dismissed = await dismissedVenues(client);
  const blockCache = new Map<string, FsaCand[]>();

  const found: (FsaReviewItem & { venueOffset: number })[] = [];
  let offset = args.offset;
  let scanned = 0;

  outer: while (scanned < MAX_SCAN) {
    const { data, error } = await loose(client)
      .from("venues")
      .select("id, name, address, slug")
      .eq("category", FOOD_CATEGORY)
      .eq("source", "google_places")
      .not("business_status", "eq", "CLOSED_PERMANENTLY")
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + VENUE_PAGE - 1);
    if (error) throw new Error(`admin: fsa queue venue read failed: ${error.message}`);
    const rows = (data ?? []) as any[];
    if (rows.length === 0) break;

    for (const v of rows) {
      const venueOffset = offset;
      offset++;
      scanned++;
      const id = String(v.id);
      if (linked.has(id)) continue;
      const isDismissed = dismissed.has(id);
      if (isDismissed && !args.includeDismissed) continue;
      const postcode = extractPostcode(v.address);
      if (!postcode) continue;
      const outward = outwardCode(postcode);
      if (!outward) continue;

      let cands = blockCache.get(outward);
      if (!cands) {
        cands = await fsaCandidatesInBlock(client, outward);
        blockCache.set(outward, cands);
      }
      if (cands.length === 0) continue; // no corpus here → not reviewable yet

      const res = resolveCandidates(
        { name: String(v.name ?? ""), postcode, address: v.address == null ? null : String(v.address) },
        cands,
      );
      const shown = res.ranked
        .filter((c) => c.score >= MATCH_THRESHOLDS.review)
        .slice(0, CANDIDATES_RETURNED)
        .map(present);

      found.push({
        venueId: id,
        name: String(v.name ?? ""),
        address: v.address == null ? null : String(v.address),
        slug: v.slug == null ? null : String(v.slug),
        postcode,
        decision: res.decision,
        bestScore: shown[0]?.score ?? 0,
        dismissed: isDismissed,
        dismissedNote: isDismissed ? (dismissed.get(id) ?? null) : null,
        candidates: shown,
        venueOffset,
      });
      if (found.length > args.limit) break outer;
    }
    if (rows.length < VENUE_PAGE) break;
  }

  const hasMore = found.length > args.limit;
  const nextOffset = hasMore ? found[args.limit]!.venueOffset : offset;
  const page = found.slice(0, args.limit).map(({ venueOffset: _o, ...item }) => item);
  // Most confident first within the page — the quick confirms at the top.
  page.sort((a, b) => b.bestScore - a.bestScore);
  return { items: page, hasMore, nextOffset, scanned };
}

/** Free-text search of the FSA corpus by trading name (for a venue with no candidate at its postcode). */
export async function fsaSearch(
  client: RoamClient,
  args: { q: string; limit?: number | undefined },
): Promise<FsaReviewCandidate[]> {
  const q = args.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`);
  if (q.length < 2) return [];
  const { data, error } = await loose(client)
    .from("fsa_establishments")
    .select("fhrsid, business_name, address, postcode, rating_value, local_authority")
    .ilike("business_name", `%${q}%`)
    .order("business_name", { ascending: true })
    .limit(Math.min(Math.max(args.limit ?? 15, 1), 30));
  if (error) throw new Error(`admin: fsa search failed: ${error.message}`);
  return ((data ?? []) as any[]).map(toCand).map((c) => ({
    fhrsid: c.id,
    name: c.name,
    address: c.address,
    postcode: c.postcode || null,
    ratingValue: c.ratingValue,
    localAuthority: c.localAuthority,
    score: 0,
    nameScore: 0,
    postcodeAgreement: "none" as const,
  }));
}

/**
 * The positive decision: link this venue to this establishment as the manual match of record
 * (method='manual', matched_by=actor). Replaces any existing link for the venue (one per venue),
 * clears a dismissal, and audits. Refuses an unknown venue or fhrsid.
 */
export async function confirmFsaMatch(
  client: RoamClient,
  actor: AdminActor,
  args: { venueId: string; fhrsid: string },
): Promise<void> {
  const { data: venue, error: vErr } = await loose(client).from("venues").select("id").eq("id", args.venueId).maybeSingle();
  if (vErr) throw new Error(`admin: fsa confirm venue read failed: ${vErr.message}`);
  if (!venue) throw new Error("admin: venue not found");

  const { data: est, error: eErr } = await loose(client)
    .from("fsa_establishments")
    .select("fhrsid")
    .eq("fhrsid", args.fhrsid)
    .maybeSingle();
  if (eErr) throw new Error(`admin: fsa confirm establishment read failed: ${eErr.message}`);
  if (!est) throw new Error("admin: FSA establishment not found in the synced corpus");

  const { error: refErr } = await loose(client)
    .from("external_refs")
    .upsert(
      {
        entity_type: "venue",
        entity_id: args.venueId,
        dataset: "fsa",
        external_id: args.fhrsid,
        method: "manual",
        score: null,
        matched_by: actor.id,
      },
      { onConflict: "entity_type,entity_id,dataset", ignoreDuplicates: false },
    );
  if (refErr) throw new Error(`admin: fsa confirm external_ref write failed: ${refErr.message}`);

  const { error: dErr } = await loose(client).from("fsa_match_dismissals").delete().eq("venue_id", args.venueId);
  if (dErr) throw new Error(`admin: fsa confirm undismiss failed: ${dErr.message}`);

  await recordAudit(client, actor, {
    action: "confirm_fsa_match",
    entityType: "venue",
    entityId: args.venueId,
    detail: { fhrsid: args.fhrsid },
  });
}

/**
 * Remove a WRONG link and dismiss the venue, so the nightly sync cannot re-create the same auto
 * link. A later confirmFsaMatch (the right record) clears the dismissal.
 */
export async function unlinkFsaMatch(
  client: RoamClient,
  actor: AdminActor,
  args: { venueId: string; note?: string | undefined },
): Promise<void> {
  const { error: delErr } = await loose(client)
    .from("external_refs")
    .delete()
    .eq("entity_type", "venue")
    .eq("entity_id", args.venueId)
    .eq("dataset", "fsa");
  if (delErr) throw new Error(`admin: fsa unlink failed: ${delErr.message}`);

  const { error: dErr } = await loose(client)
    .from("fsa_match_dismissals")
    .upsert(
      { venue_id: args.venueId, dismissed_by: actor.id, note: (args.note ?? "unlinked wrong match").slice(0, 200) },
      { onConflict: "venue_id", ignoreDuplicates: false },
    );
  if (dErr) throw new Error(`admin: fsa unlink dismissal write failed: ${dErr.message}`);

  await recordAudit(client, actor, {
    action: "unlink_fsa_match",
    entityType: "venue",
    entityId: args.venueId,
    detail: { note: args.note ?? null },
  });
}

/** The negative decision ("no FSA record is this venue") — or undo it. Audited. */
export async function setFsaMatchDismissed(
  client: RoamClient,
  actor: AdminActor,
  args: { venueId: string; dismissed: boolean; note?: string | undefined },
): Promise<void> {
  if (args.dismissed) {
    const { error } = await loose(client)
      .from("fsa_match_dismissals")
      .upsert(
        { venue_id: args.venueId, dismissed_by: actor.id, note: args.note == null ? null : args.note.slice(0, 200) },
        { onConflict: "venue_id", ignoreDuplicates: false },
      );
    if (error) throw new Error(`admin: fsa dismiss write failed: ${error.message}`);
  } else {
    const { error } = await loose(client).from("fsa_match_dismissals").delete().eq("venue_id", args.venueId);
    if (error) throw new Error(`admin: fsa undismiss failed: ${error.message}`);
  }
  await recordAudit(client, actor, {
    action: args.dismissed ? "dismiss_fsa_match" : "undismiss_fsa_match",
    entityType: "venue",
    entityId: args.venueId,
    detail: { note: args.note ?? null },
  });
}

/** Headline coverage for the tab. */
export async function fsaCoverage(client: RoamClient): Promise<FsaCoverage> {
  const count = async (build: (q: any) => any): Promise<number> => {
    const res = await build(loose(client));
    if (res?.error) throw new Error(`admin: fsa coverage count failed: ${res.error.message}`);
    return typeof res?.count === "number" ? res.count : 0;
  };
  const foodVenues = await count((db) =>
    db.from("venues").select("id", { count: "exact", head: true }).eq("category", FOOD_CATEGORY).eq("source", "google_places"),
  );
  const linked = await count((db) =>
    db.from("external_refs").select("id", { count: "exact", head: true }).eq("dataset", "fsa").eq("entity_type", "venue"),
  );
  const dismissed = await count((db) => db.from("fsa_match_dismissals").select("venue_id", { count: "exact", head: true }));
  const pct = foodVenues > 0 ? Math.round((1000 * linked) / foodVenues) / 10 : 0;
  return { foodVenues, linked, dismissed, pct };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
