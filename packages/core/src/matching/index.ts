/**
 * @roam/core/matching — the record-matching engine for roster onboarding (F2G Phase B, slice B2).
 *
 * The Association gives us a roster of vendors as free text (a name, a postcode, an address). To
 * onboard them we must decide, for each, WHICH existing Roam venue it is — or that it is none. This
 * is the one place that decision is made, so web/admin/the import job all match identically, and so
 * the thresholds can be tuned once against the real roster.
 *
 * DESIGN — fail closed. A wrong match is worse than no match: it would attach the wrong FSA hygiene
 * rating (a legal exposure), the wrong owner, the wrong storefront. So the engine never guesses. It:
 *   1. BLOCKS on postcode (the match key) — candidates are grouped by postcode; a venue in a
 *      different postcode is not a serious candidate. Never blocks on coordinates (a venue can have a
 *      null/approximate geocode, and two units can share a centroid).
 *   2. SCORES the name with a deterministic Sørensen–Dice bigram coefficient (order-insensitive,
 *      dependency-free, unit-testable), after normalising away legal suffixes / punctuation / case.
 *   3. RESOLVES to accept / review / reject with an AMBIGUITY MARGIN: two strong, close candidates
 *      (a chain's two branches on one postcode, a concession sharing its host's address) go to human
 *      REVIEW, never auto-accept.
 *
 * Thresholds are exported constants, PROVISIONAL until calibrated on the real roster sample — the
 * import job (B3) persists each decision in `external_refs` so matching is one-time and a human
 * correction is permanent.
 */
import { normalisePostcode, outwardCode } from "../membership/index.js";

// ── name normalisation ────────────────────────────────────────────────────────────────────────

/** Legal-entity suffixes that carry no discriminating signal. Kept deliberately SHORT: over-stripping
 * (e.g. treating "co" as a suffix would maul "Co-op") causes false matches, the exact failure we
 * fear. Only unambiguous company forms. */
const LEGAL_SUFFIXES = /\b(?:ltd|limited|llp|plc|inc)\b/g;

/**
 * Reduce a business name to a comparable core: lowercase, "&"→"and", drop apostrophes/periods so
 * "Mario's" == "Marios", non-alphanumerics → spaces, strip legal suffixes and a standalone "the",
 * collapse whitespace. Returns "" for empty/garbage input (which scores 0 against anything — you
 * cannot match on nothing).
 */
export function normaliseBusinessName(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.toLowerCase();
  s = s.replace(/&/g, " and ");
  s = s.replace(/['’.]/g, ""); // apostrophes/periods vanish rather than split a word
  s = s.replace(/[^a-z0-9]+/g, " ");
  s = s.replace(LEGAL_SUFFIXES, " ");
  s = s.replace(/\bthe\b/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** Character-bigram multiset of a string. */
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    m.set(bg, (m.get(bg) ?? 0) + 1);
  }
  return m;
}

/**
 * Sørensen–Dice similarity over character bigrams, in [0, 1]. Order-insensitive and forgiving of
 * small edits — well suited to business names ("fish and chips co" vs "the fish & chip company").
 * Empty/near-empty inputs score 0 (never a false perfect match on nothing).
 */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const x = normaliseBusinessName(a);
  const y = normaliseBusinessName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const A = bigrams(x);
  const B = bigrams(y);
  let overlap = 0;
  for (const [bg, ca] of A) {
    const cb = B.get(bg);
    if (cb) overlap += Math.min(ca, cb);
  }
  let total = 0;
  for (const c of A.values()) total += c;
  for (const c of B.values()) total += c;
  return total === 0 ? 0 : (2 * overlap) / total;
}

// ── postcode extraction (venue side stores the postcode inside free-text `address`) ─────────────

/** UK/NI postcode pattern (outward + inward), tolerant of missing/oddly-spaced internal space. */
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;

/**
 * Pull a UK/NI postcode out of a free-text address (venues store no discrete postcode column), and
 * return it normalised. "" if the text carries no recognisable postcode.
 */
export function extractPostcode(address: string | null | undefined): string {
  if (!address) return "";
  const m = address.match(UK_POSTCODE);
  return m ? normalisePostcode(m[0]) : "";
}

// ── scoring ─────────────────────────────────────────────────────────────────────────────────────

/** How strongly two postcodes agree — the block signal. */
export type PostcodeAgreement = "full" | "outward" | "none";

/** One party in a match: a name plus, ideally, a postcode. Candidates carry their own extra data. */
export interface MatchParty {
  name: string;
  postcode?: string | null;
}

export interface MatchScore {
  /** Composite confidence in [0, 1]. */
  score: number;
  /** The name-only Sørensen–Dice component, for transparency in the review UI. */
  nameScore: number;
  /** How the postcodes agreed. */
  postcode: PostcodeAgreement;
}

/**
 * Weights. Name carries most of the signal; postcode agreement adds a bounded bonus. A name-only
 * match (no postcode agreement) therefore CANNOT reach the accept threshold on its own — it can only
 * ever reach review, which is the fail-closed behaviour we want. Provisional until roster-calibrated.
 */
export const NAME_WEIGHT = 0.8;
export const POSTCODE_BONUS: Readonly<Record<PostcodeAgreement, number>> = {
  full: 0.2,
  outward: 0.1,
  none: 0,
};

/** Decision bands + the ambiguity margin. PROVISIONAL — tune on the real roster sample. */
export const MATCH_THRESHOLDS = {
  /** score ≥ accept AND a clear margin over the runner-up → auto-accept. */
  accept: 0.85,
  /** accept > score ≥ review → human review queue. Below review → reject. */
  review: 0.55,
  /** the best must beat the runner-up by at least this, or it's ambiguous → review. */
  ambiguityMargin: 0.1,
} as const;

/** Compare two postcodes at block granularity. */
export function postcodeAgreement(a: string | null | undefined, b: string | null | undefined): PostcodeAgreement {
  const pa = normalisePostcode(a);
  const pb = normalisePostcode(b);
  if (!pa || !pb) return "none";
  if (pa === pb) return "full";
  const oa = outwardCode(pa);
  const ob = outwardCode(pb);
  return oa && oa === ob ? "outward" : "none";
}

/** Score a single candidate against the target: name similarity, lifted by postcode agreement. */
export function scoreMatch(target: MatchParty, candidate: MatchParty): MatchScore {
  const nameScore = nameSimilarity(target.name, candidate.name);
  const pc = postcodeAgreement(target.postcode, candidate.postcode);
  const score = Math.min(1, nameScore * NAME_WEIGHT + POSTCODE_BONUS[pc]);
  return { score, nameScore, postcode: pc };
}

// ── resolution ──────────────────────────────────────────────────────────────────────────────────

export type MatchDecision = "accept" | "review" | "reject";

export interface ScoredCandidate<T> extends MatchScore {
  candidate: T;
}

export interface MatchResolution<T> {
  decision: MatchDecision;
  /** Highest-scoring candidate (null when there were no candidates). */
  best: ScoredCandidate<T> | null;
  /** Second-highest, when present — the ambiguity check compares against it. */
  runnerUp: ScoredCandidate<T> | null;
  /** Every candidate scored, highest first — the review UI shows these. */
  ranked: ScoredCandidate<T>[];
}

/**
 * Resolve a target against its candidate venues (already postcode-blocked by the caller, though
 * scoring re-checks postcode so an unblocked list is safe too). Fail-closed:
 *   - accept  — best ≥ accept AND best beats the runner-up by ≥ ambiguityMargin (unambiguous).
 *   - review  — best ≥ review, OR best ≥ accept but too close to the runner-up (a chain's two
 *               branches on one postcode land here, never auto-accepted).
 *   - reject  — best < review, or no candidates at all.
 */
export function resolveCandidates<T extends MatchParty>(
  target: MatchParty,
  candidates: readonly T[],
  thresholds: { accept: number; review: number; ambiguityMargin: number } = MATCH_THRESHOLDS,
): MatchResolution<T> {
  const ranked: ScoredCandidate<T>[] = candidates
    .map((candidate) => ({ candidate, ...scoreMatch(target, candidate) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;

  let decision: MatchDecision;
  if (!best || best.score < thresholds.review) {
    decision = "reject";
  } else if (
    best.score >= thresholds.accept &&
    (!runnerUp || best.score - runnerUp.score >= thresholds.ambiguityMargin)
  ) {
    decision = "accept";
  } else {
    decision = "review";
  }

  return { decision, best, runnerUp, ranked };
}
