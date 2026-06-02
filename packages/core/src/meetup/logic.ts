/**
 * Meet-up loop — PURE resolution logic. The crown jewel.
 *
 * No I/O, no client, no Supabase. Takes plain data, returns plain data, so it is
 * trivially testable and free of any transport/framework assumption (this is what
 * lets the same logic serve web, console, and native).
 *
 * The orchestrators in ./service.ts fetch the data, call these functions, and
 * write the result. The RULES live here.
 *
 * Lifecycle: voting -> resolved (meet at X) -> ended.
 */

export type MeetupState = "voting" | "resolved" | "ended";

/** One participant's current vote (one active vote per voter — re-votes overwrite). */
export interface Vote {
  voterId: string;
  optionId: string;
}

/** A candidate venue in the poll. */
export interface MeetupOption {
  optionId: string;
  venueId: string;
}

/** Tally result for a single option. */
export interface OptionTally {
  optionId: string;
  venueId: string;
  count: number;
}

/** The outcome of attempting to resolve a poll. */
export interface Resolution {
  /** True if a single clear winner exists. */
  resolved: boolean;
  /** The winning option, when resolved. */
  winner?: OptionTally;
  /** Full ranked tally (descending by count, then stable by option order). */
  tally: OptionTally[];
  /** When not resolved, why — useful for the UI to show "it's a tie" etc. */
  reason?: "no_votes" | "tie";
}

/**
 * Tally votes across the poll's options.
 *
 * - Options with zero votes are included with count 0 (so the UI shows every choice).
 * - Votes referencing an option not in `options` are IGNORED (an option may have
 *   been removed after someone voted for it — their stale vote does not count).
 * - One active vote per voter is assumed (the data layer enforces this via PK);
 *   if duplicates somehow appear, the last one in array order wins, defensively.
 *
 * Ranked descending by count. Ties preserve the input order of `options`, so
 * resolution is deterministic and the first-listed option is treated as the
 * incumbent in a tie (caller decides whether that breaks the tie — see resolvePoll).
 */
export function tallyVotes(
  options: readonly MeetupOption[],
  votes: readonly Vote[],
): OptionTally[] {
  const validOptionIds = new Set(options.map((o) => o.optionId));

  // Last-vote-wins per voter (defensive against duplicate rows).
  const voterChoice = new Map<string, string>();
  for (const v of votes) {
    if (validOptionIds.has(v.optionId)) {
      voterChoice.set(v.voterId, v.optionId);
    }
  }

  const counts = new Map<string, number>();
  for (const optionId of voterChoice.values()) {
    counts.set(optionId, (counts.get(optionId) ?? 0) + 1);
  }

  // Build tallies in the input order of options, then stable-sort by count desc.
  const tallies: OptionTally[] = options.map((o) => ({
    optionId: o.optionId,
    venueId: o.venueId,
    count: counts.get(o.optionId) ?? 0,
  }));

  // Stable sort: higher count first; equal counts keep original option order.
  return tallies
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.count - a.t.count || a.i - b.i)
    .map(({ t }) => t);
}

/**
 * Resolve a poll into a winner, or report why it can't resolve.
 *
 * Resolution rule: a poll resolves when exactly one option has the strictly
 * highest count. A tie at the top does NOT auto-resolve — the group must break it
 * (the UI surfaces the tie; someone changes a vote or the starter picks). This is
 * deliberate: silently picking a winner from a tie would feel arbitrary and erode
 * trust in the crown-jewel feature.
 *
 * --- DOCUMENTED EDGE-CASE BEHAVIOUR (verify against these when testing live) ---
 *
 *   example: no votes at all
 *     options=[A,B], votes=[]
 *     -> { resolved:false, reason:"no_votes", tally:[A:0, B:0] }
 *
 *   example: clear winner
 *     options=[A,B], votes=[v1->A, v2->A, v3->B]
 *     -> { resolved:true, winner:A(2), tally:[A:2, B:1] }
 *
 *   example: tie at the top
 *     options=[A,B], votes=[v1->A, v2->B]
 *     -> { resolved:false, reason:"tie", tally:[A:1, B:1] }
 *
 *   example: re-vote (voter switches A -> B; one active vote per voter)
 *     options=[A,B], votes=[v1->A, v1->B, v2->B]
 *     -> { resolved:true, winner:B(2), tally:[B:2, A:0] }
 *
 *   example: stale vote for a removed option is ignored
 *     options=[A], votes=[v1->A, v2->REMOVED]
 *     -> { resolved:true, winner:A(1), tally:[A:1] }
 *
 *   example: single option, single vote
 *     options=[A], votes=[v1->A]
 *     -> { resolved:true, winner:A(1), tally:[A:1] }
 */
export function resolvePoll(
  options: readonly MeetupOption[],
  votes: readonly Vote[],
): Resolution {
  const tally = tallyVotes(options, votes);

  const totalVotes = tally.reduce((sum, t) => sum + t.count, 0);
  if (totalVotes === 0) {
    return { resolved: false, reason: "no_votes", tally };
  }

  const top = tally[0];
  const runnerUp = tally[1];

  // top is defined here because totalVotes > 0 implies at least one option exists.
  if (top === undefined) {
    return { resolved: false, reason: "no_votes", tally };
  }

  // Tie at the top: the second-place count equals the top count.
  if (runnerUp !== undefined && runnerUp.count === top.count) {
    return { resolved: false, reason: "tie", tally };
  }

  return { resolved: true, winner: top, tally };
}

/**
 * Validate a meet-up state transition. Returns null if allowed, or an error
 * message if not. Centralised so no surface invents its own illegal transition.
 *
 * Allowed: voting -> resolved, voting -> ended, resolved -> ended.
 * Forbidden: anything out of 'ended' (terminal), resolved -> voting (no un-resolving).
 */
export function canTransition(
  from: MeetupState,
  to: MeetupState,
): string | null {
  const allowed: Record<MeetupState, MeetupState[]> = {
    voting: ["resolved", "ended"],
    resolved: ["ended"],
    ended: [],
  };
  if (allowed[from].includes(to)) return null;
  return `Illegal meet-up transition: ${from} -> ${to}`;
}
