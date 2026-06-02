/**
 * Multi-destination post composer logic. Pure validation + scheduling rules.
 *
 * A post (news/offer/event) targets one or more destinations: profile, feed, and
 * optionally a follower push. The rules about what's a valid composition and when
 * it publishes live here, once — not duplicated in the console UI and the API.
 */

export type PostKind = "news" | "offer" | "event";
export type PostDestination = "profile" | "feed" | "follower_push";

export interface ComposeInput {
  kind: PostKind;
  title?: string | undefined;
  body?: string | undefined;
  destinations: readonly PostDestination[];
  isDraft: boolean;
  /** ISO timestamp; if set and future, the post is scheduled. */
  publishAt?: string | undefined;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a composition. Rules:
 * - At least one destination (a post going nowhere is meaningless).
 * - 'profile' is implied/required as the canonical home of the content — a post
 *   must at minimum live on the venue profile, so 'profile' must be present.
 * - follower_push without profile makes no sense (nothing to link the push to).
 * - Non-draft posts need a title or body (no empty publishes).
 * - An offer post must carry a title (offers are surfaced by title in lists).
 */
export function validateComposition(input: ComposeInput): ValidationResult {
  const errors: string[] = [];
  const dest = new Set(input.destinations);

  if (dest.size === 0) {
    errors.push("A post must target at least one destination.");
  }
  if (!dest.has("profile")) {
    errors.push("A post must include the venue profile as a destination.");
  }
  if (dest.has("follower_push") && !dest.has("profile")) {
    errors.push("A follower push requires the post to also live on the profile.");
  }
  if (!input.isDraft) {
    const hasContent =
      (input.title?.trim()?.length ?? 0) > 0 ||
      (input.body?.trim()?.length ?? 0) > 0;
    if (!hasContent) {
      errors.push("A published post needs a title or body.");
    }
  }
  if (input.kind === "offer" && (input.title?.trim()?.length ?? 0) === 0) {
    errors.push("An offer must have a title.");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Decide publish timing from the composition + current time. Pure.
 *
 * example: draft                       -> { status:"draft" }
 * example: no publishAt, not draft     -> { status:"published", at:now }
 * example: publishAt in the future     -> { status:"scheduled", at:publishAt }
 * example: publishAt in the past       -> { status:"published", at:now }
 */
export function resolvePublishTiming(
  input: ComposeInput,
  now: Date = new Date(),
): { status: "draft" | "scheduled" | "published"; at: string | null } {
  if (input.isDraft) return { status: "draft", at: null };

  if (input.publishAt) {
    const when = new Date(input.publishAt);
    if (when.getTime() > now.getTime()) {
      return { status: "scheduled", at: input.publishAt };
    }
  }
  return { status: "published", at: now.toISOString() };
}

/** Does this composition trigger a follower push (and therefore cost credits)? */
export function requiresPushCredit(input: ComposeInput): boolean {
  return input.destinations.includes("follower_push") && !input.isDraft;
}
