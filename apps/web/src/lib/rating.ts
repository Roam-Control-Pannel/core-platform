/**
 * The one place that decides which rating a venue shows — so the public profile, the sidebar
 * rating card, and the owner dashboard all agree (no divergence between "what the owner sees" and
 * "what a local sees"). Roam's own rating SUPERSEDES Google once the venue has enough Roam reviews
 * (the "eventually override" product decision from the reviews feature); until then Google's
 * borrowed credibility stands. Each result carries its SOURCE so the UI can label it honestly —
 * we never blend the two numbers or invent data.
 */

/** How many Roam reviews a venue needs before its Roam rating replaces Google's as the headline. */
export const ROAM_RATING_MIN = 3;

export interface RatingInputs {
  googleRating: number | null;
  googleCount: number;
  roamRating: number | null;
  roamCount: number;
}

export interface EffectiveRating {
  /** The rating to show (1.0–5.0), or null when the venue has no rating at all. */
  value: number | null;
  /** The count behind `value`. */
  count: number;
  /** Where `value` came from — drives the "Google" / "Roam" label. */
  source: "roam" | "google" | null;
}

export function effectiveRating(i: RatingInputs): EffectiveRating {
  // Roam takes over once it has enough of its own reviews.
  if (i.roamRating != null && i.roamCount >= ROAM_RATING_MIN) {
    return { value: i.roamRating, count: i.roamCount, source: "roam" };
  }
  // Otherwise Google's rating stands (the external signal on an unclaimed/new venue).
  if (i.googleRating != null) {
    return { value: i.googleRating, count: i.googleCount, source: "google" };
  }
  // No Google rating, but a few Roam reviews exist (below the override threshold) — show those.
  if (i.roamRating != null && i.roamCount > 0) {
    return { value: i.roamRating, count: i.roamCount, source: "roam" };
  }
  return { value: null, count: 0, source: null };
}
