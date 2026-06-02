/**
 * Moderation routing. Pure decisioning over a content-scan result.
 *
 * Global launch forces automated first-pass + manual queue (a §4 hard gate; app
 * stores reject without working moderation). The ACTUAL scanning (a moderation
 * API on text/images) runs in an Edge Function; this module decides what its
 * result means — auto-approve, auto-flag to the manual queue, or hard-reject.
 *
 * Keeping the decision here (not in the Edge Function) means web/console/native
 * and the cron all route content the same way, and the thresholds live in one place.
 */

export type ModerationStatus =
  | "pending"
  | "auto_approved"
  | "auto_flagged"
  | "approved"
  | "rejected";

/** Normalised output of a content scan, whatever provider produced it. */
export interface ScanResult {
  /** 0..1 — likelihood the content is disallowed. */
  score: number;
  /** Categories the scanner tripped (e.g. 'sexual', 'violence', 'csae'). */
  categories: readonly string[];
}

/**
 * Categories that are NEVER auto-approved and escalate hardest. Child-safety and
 * the most severe categories route to immediate reject + human review regardless
 * of score, erring to caution.
 */
const ZERO_TOLERANCE = new Set(["csae", "child_safety", "terrorism"]);

export interface RoutingDecision {
  status: ModerationStatus;
  /** True if this must also be written to the manual review queue. */
  enqueueForReview: boolean;
  reason: string;
}

/**
 * Route a scan result. Thresholds are deliberately conservative for launch.
 *
 * example: score 0.02, no categories         -> auto_approved, no queue
 * example: score 0.55, ['profanity']         -> auto_flagged, queued
 * example: score 0.95, ['sexual']            -> rejected, queued
 * example: any score, ['csae']               -> rejected, queued (zero tolerance)
 */
export function routeScan(
  scan: ScanResult,
  thresholds: { flagAt: number; rejectAt: number } = {
    flagAt: 0.4,
    rejectAt: 0.85,
  },
): RoutingDecision {
  const hitsZeroTolerance = scan.categories.some((c) => ZERO_TOLERANCE.has(c));
  if (hitsZeroTolerance) {
    return {
      status: "rejected",
      enqueueForReview: true,
      reason: "Zero-tolerance category detected; rejected and escalated.",
    };
  }

  if (scan.score >= thresholds.rejectAt) {
    return {
      status: "rejected",
      enqueueForReview: true,
      reason: `Scan score ${scan.score.toFixed(2)} at/above reject threshold.`,
    };
  }

  if (scan.score >= thresholds.flagAt) {
    return {
      status: "auto_flagged",
      enqueueForReview: true,
      reason: `Scan score ${scan.score.toFixed(2)} in review band.`,
    };
  }

  return {
    status: "auto_approved",
    enqueueForReview: false,
    reason: "Below flag threshold; auto-approved.",
  };
}

/** A user report always enqueues for review regardless of prior auto-status. */
export function routeUserReport(): RoutingDecision {
  return {
    status: "pending",
    enqueueForReview: true,
    reason: "User report; queued for manual review.",
  };
}
