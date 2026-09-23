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
import { normalisePostcode, outwardCode, UK_POSTCODE_RE } from "../membership/index.js";

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

// ── contextual name comparison (locality + descriptor stripping, containment) ─────────────────

/**
 * Words that describe WHAT a business is, not WHICH one it is. Both parties routinely differ only
 * in these ("Starbucks Coffee Company" / "Starbucks", "The Belfry Delicatessen" / "The Belfry Deli",
 * "Cafollas TakeAway" / "CAFOLLAS FAST FOOD"), so they are removed before the token comparison.
 * Deliberately modest: a word here is one that appears in thousands of unrelated trading names.
 * If stripping would leave a name EMPTY ("The Coffee Shop"), the unstripped tokens are used instead —
 * we never compare nothing against nothing.
 */
const GENERIC_DESCRIPTORS = new Set([
  "cafe", "caffe", "coffee", "coffeehouse", "shop", "store", "stores", "bar", "bars", "pub", "inn",
  "restaurant", "restaurants", "takeaway", "takeaways", "take", "away", "fast", "food", "foods",
  "kitchen", "kitchens", "deli", "delicatessen", "bakery", "bakers", "company", "co", "grill",
  "diner", "eatery", "bistro", "lounge", "liquor", "saloon", "tavern", "express", "centre", "center",
  "and", "of", "at", "on", "in", "by", "for",
]);

/** Postcode-shaped tokens (either half of a UK postcode) — never discriminating in a name. */
const POSTCODE_TOKEN = /^(?:[a-z]{1,2}\d[a-z\d]?|\d[a-z]{2})$/;

const tokenise = (s: string): string[] => s.split(" ").filter(Boolean);

/**
 * A name's DISCRIMINATING tokens, in context: normalised, minus legal suffixes (already gone), minus
 * generic descriptors, minus any token that also occurs in EITHER party's address. The address rule
 * is what removes locality suffixes — "Cape Cod Ballymena", "Domino's Pizza - Bangor - Abbey Street",
 * "Subway Lisnagelvin" — data-driven from the record itself, with no hardcoded town list. Falls back
 * (descriptors kept, then everything kept) rather than ever returning an empty set for a real name.
 */
export function coreNameTokens(name: string | null | undefined, addresses: readonly (string | null | undefined)[] = []): string[] {
  const all = tokenise(normaliseBusinessName(name));
  if (all.length === 0) return [];
  const addressTokens = new Set<string>();
  for (const a of addresses) for (const t of tokenise(normaliseBusinessName(a))) addressTokens.add(t);
  // Drop address/postcode tokens and ≤2-letter tags ("(NI)", "UK", "Mr") — never discriminating.
  const notLocal = all.filter((t) => !addressTokens.has(t) && !POSTCODE_TOKEN.test(t) && !/^[a-z]{1,2}$/.test(t));
  const specific = notLocal.filter((t) => !GENERIC_DESCRIPTORS.has(t));
  if (specific.length > 0) return specific;
  if (notLocal.length > 0) return notLocal;
  return all;
}

/**
 * Token-containment similarity: 1 when the two core token sets are identical, 0.9 when one is
 * contained in the other and the contained set is still discriminating (≥ 3 characters — "kfc" is
 * a brand; a lone digit is not), else 0. Order-insensitive. This is what accepts
 * "Quirky Cricketer" ⊆ "Quirky Cricketer Coffee Dock" while "Sweet Treats" vs "The Corner Shop"
 * (no shared core token) stays 0.
 */
export function tokenContainment(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const t of small) if (!big.has(t)) return 0;
  if (A.size === B.size) return 1;
  return [...small].join("").length >= 3 ? 0.9 : 0;
}

/**
 * Name similarity IN CONTEXT — the score scoreMatch uses. The maximum of:
 *   - the plain bigram Dice (the original behaviour, so nothing that matched before scores lower),
 *   - Dice over the core tokens (locality + descriptors removed),
 *   - Dice over the core tokens with spaces removed ("smashnbird" == "smash n bird"),
 *   - token containment.
 * Fail-closed is preserved by scoreMatch/resolveCandidates: this only decides the NAME component;
 * the accept threshold, the postcode bonus and the ambiguity margin are untouched.
 */
export function nameSimilarityInContext(target: MatchParty, candidate: MatchParty): number {
  const plain = nameSimilarity(target.name, candidate.name);
  const addresses = [target.address, candidate.address];
  const ta = coreNameTokens(target.name, addresses);
  const tb = coreNameTokens(candidate.name, addresses);
  if (ta.length === 0 || tb.length === 0) return plain;
  const coreA = ta.join(" ");
  const coreB = tb.join(" ");
  const coreDice = nameSimilarity(coreA, coreB);
  const compactDice = nameSimilarity(ta.join(""), tb.join(""));
  const containment = tokenContainment(ta, tb);
  return Math.max(plain, coreDice, compactDice, containment);
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

/**
 * Pull a UK/NI postcode out of a free-text address (venues store no discrete postcode column), and
 * return it normalised. "" if the text carries no recognisable postcode. The pattern is shared with
 * the membership layer (UK_POSTCODE_RE) so the roster side and the venue side agree on what counts
 * as a postcode — two copies of this regex would be two definitions of the match block key.
 */
export function extractPostcode(address: string | null | undefined): string {
  if (!address) return "";
  const m = address.match(UK_POSTCODE_RE);
  return m ? normalisePostcode(m[0]) : "";
}

// ── scoring ─────────────────────────────────────────────────────────────────────────────────────

/** How strongly two postcodes agree — the block signal. */
export type PostcodeAgreement = "full" | "outward" | "none";

/** One party in a match: a name plus, ideally, a postcode. Candidates carry their own extra data. */
export interface MatchParty {
  name: string;
  postcode?: string | null;
  /**
   * Free-text address, when known. Used ONLY to strip locality tokens out of the name before
   * comparison (see coreNameTokens) — never as a match key. Optional; absent = no stripping.
   */
  address?: string | null;
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
 * ever reach review, which is the fail-closed behaviour we want.
 *
 * OUTWARD-ONLY agreement is capped BELOW accept too (1.0 × 0.8 + 0.04 = 0.84 < 0.85): a perfect name
 * in the same outward code is exactly the chain's-other-branch case (the Greggs on the next street),
 * and linking the wrong branch's hygiene rating is the legal exposure this engine exists to prevent.
 * Auto-accept therefore requires FULL postcode agreement; everything else is at most review.
 */
export const NAME_WEIGHT = 0.8;
export const POSTCODE_BONUS: Readonly<Record<PostcodeAgreement, number>> = {
  full: 0.2,
  outward: 0.04,
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
  const nameScore = nameSimilarityInContext(target, candidate);
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
