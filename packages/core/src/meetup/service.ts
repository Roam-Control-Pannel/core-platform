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

  const { error: updateErr } = await client
    .from("meetups")
    .update({
      state: "resolved",
      resolved_venue_id: resolution.winner.venueId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", meetupId)
    .eq("state", "voting"); // guard against a concurrent resolve (last-write-safe)

  if (updateErr) throw new Error(`Failed to resolve meet-up: ${updateErr.message}`);

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

  const { error: updateErr } = await client
    .from("meetups")
    .update({ state: "ended", ended_at: new Date().toISOString() })
    .eq("id", meetupId);
  if (updateErr) throw new Error(`Failed to end meet-up: ${updateErr.message}`);
}

/**
 * Cast (or change) a vote in a meet-up poll. Encodes the crown-jewel rule that
 * logic.ts documents and the DB enforces by PK: ONE active vote per voter, and a
 * re-vote OVERWRITES the previous one. We express that as an upsert keyed on
 * (meetup_id, voter_id) — the same voter voting again replaces their row rather
 * than adding a second, which is exactly what resolvePoll's re-vote example expects.
 *
 * The vote may only be cast while the meet-up is still in 'voting'. We check state
 * first so a closed poll can't be mutated (a resolved/ended meet-up rejects votes).
 *
 * Thin orchestrator: the RULE (one-per-voter, overwrite) lives here in core so web,
 * console, native, and cron all cast votes identically; the transport layer only
 * supplies the validated ids.
 */
export async function castVote(
  client: RoamClient,
  meetupId: string,
  optionId: string,
  voterId: string,
): Promise<{ ok: boolean; reason?: "not_voting" }> {
  const { data: meetup, error } = await client
    .from("meetups")
    .select("state")
    .eq("id", meetupId)
    .single();
  if (error) throw new Error(`Failed to load meet-up: ${error.message}`);

  if ((meetup.state as MeetupState) !== "voting") {
    return { ok: false, reason: "not_voting" };
  }

  const { error: voteErr } = await client
    .from("meetup_votes")
    .upsert(
      { meetup_id: meetupId, option_id: optionId, voter_id: voterId },
      { onConflict: "meetup_id,voter_id" },
    );
  if (voteErr) throw new Error(`Failed to cast vote: ${voteErr.message}`);

  return { ok: true };
}
