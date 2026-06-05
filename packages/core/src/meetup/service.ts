/**
 * Meet-up orchestration — the THIN layer that touches data.
 *
 * Fetches votes/options via the client, calls the PURE logic in ./logic.ts,
 * writes the result. Holds no rules of its own beyond "fetch, compute, persist".
 * Keeping this thin is what keeps the rules testable and the logic transport-free.
 */
import type { RoamClient } from "@roam/db";
import {
  resolvePoll,
  canTransition,
  type MeetupOption,
  type Vote,
  type Resolution,
  type MeetupState,
} from "./logic.js";

/**
 * Compute the current resolution of a meet-up's poll from live data.
 * Read-only — does not change state. Useful for showing live vote counts.
 */
export async function getPollResolution(
  client: RoamClient,
  meetupId: string,
): Promise<Resolution> {
  const [{ data: optionRows, error: optErr }, { data: voteRows, error: voteErr }] =
    await Promise.all([
      client
        .from("meetup_options")
        .select("id, venue_id")
        .eq("meetup_id", meetupId),
      client
        .from("meetup_votes")
        .select("voter_id, option_id")
        .eq("meetup_id", meetupId),
    ]);

  if (optErr) throw new Error(`Failed to load meet-up options: ${optErr.message}`);
  if (voteErr) throw new Error(`Failed to load meet-up votes: ${voteErr.message}`);

  const options: MeetupOption[] = (optionRows ?? []).map((r) => ({
    optionId: r.id as string,
    venueId: r.venue_id as string,
  }));
  const votes: Vote[] = (voteRows ?? []).map((r) => ({
    voterId: r.voter_id as string,
    optionId: r.option_id as string,
  }));

  return resolvePoll(options, votes);
}

/**
 * Attempt to resolve the meet-up: if the poll has a clear winner, transition
 * voting -> resolved and record the winning venue. Returns the resolution either
 * way so the caller can surface a tie/no-votes state to the group.
 *
 * Idempotent-ish: if already resolved/ended, returns the current resolution
 * without re-writing (callers may poll this).
 */
export async function tryResolveMeetup(
  client: RoamClient,
  meetupId: string,
): Promise<Resolution> {
  const { data: meetup, error } = await client
    .from("meetups")
    .select("state")
    .eq("id", meetupId)
    .single();

  if (error) throw new Error(`Failed to load meet-up: ${error.message}`);

  const state = meetup.state as MeetupState;
  const resolution = await getPollResolution(client, meetupId);

  // Only act while still voting and only when a clear winner exists.
  if (state !== "voting" || !resolution.resolved || !resolution.winner) {
    return resolution;
  }

  const transitionError = canTransition("voting", "resolved");
  if (transitionError) throw new Error(transitionError);

  const { data: updatedRows, error: updateErr } = await client
    .from("meetups")
    .update({
      state: "resolved",
      resolved_venue_id: resolution.winner.venueId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", meetupId)
    .eq("state", "voting") // guard against a concurrent resolve (last-write-safe)
    .select("id");

  if (updateErr) throw new Error(`Failed to resolve meet-up: ${updateErr.message}`);
  // A zero-row update here means the write was silently denied (e.g. a missing RLS
  // UPDATE policy) or lost a concurrent race. Either way the transition did NOT persist,
  // so we must not report success — surface it instead of returning a stale resolution.
  if (!updatedRows || updatedRows.length === 0) {
    throw new Error(
      "Resolve did not persist: the meet-up row was not updated (check RLS UPDATE policy on meetups).",
    );
  }

  return resolution;
}

/** End a meet-up. Validates the transition from its current state. */
export async function endMeetup(
  client: RoamClient,
  meetupId: string,
): Promise<void> {
  const { data: meetup, error } = await client
    .from("meetups")
    .select("state")
    .eq("id", meetupId)
    .single();
  if (error) throw new Error(`Failed to load meet-up: ${error.message}`);

  const transitionError = canTransition(meetup.state as MeetupState, "ended");
  if (transitionError) throw new Error(transitionError);

  const { data: updatedRows, error: updateErr } = await client
    .from("meetups")
    .update({ state: "ended", ended_at: new Date().toISOString() })
    .eq("id", meetupId)
    .select("id");
  if (updateErr) throw new Error(`Failed to end meet-up: ${updateErr.message}`);
  // Zero rows updated => the write was silently denied (missing RLS UPDATE policy) and
  // the meet-up did NOT end. Fail loudly rather than reporting a phantom success.
  if (!updatedRows || updatedRows.length === 0) {
    throw new Error(
      "End did not persist: the meet-up row was not updated (check RLS UPDATE policy on meetups).",
    );
  }
}
