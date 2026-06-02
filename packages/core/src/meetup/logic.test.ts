import { describe, it, expect } from "vitest";
import {
  tallyVotes,
  resolvePoll,
  canTransition,
  type MeetupOption,
  type Vote,
} from "./logic.js";

const A: MeetupOption = { optionId: "opt-a", venueId: "ven-a" };
const B: MeetupOption = { optionId: "opt-b", venueId: "ven-b" };

const voteFor = (voterId: string, opt: MeetupOption): Vote => ({
  voterId,
  optionId: opt.optionId,
});

describe("tallyVotes", () => {
  it("includes zero-vote options so the UI shows every choice", () => {
    const tally = tallyVotes([A, B], [voteFor("v1", A)]);
    expect(tally).toHaveLength(2);
    expect(tally.find((t) => t.optionId === "opt-b")?.count).toBe(0);
  });

  it("ignores votes for options not in the poll (removed option)", () => {
    const stale: Vote = { voterId: "v2", optionId: "opt-removed" };
    const tally = tallyVotes([A], [voteFor("v1", A), stale]);
    expect(tally).toEqual([{ optionId: "opt-a", venueId: "ven-a", count: 1 }]);
  });

  it("counts one active vote per voter (re-vote overwrites)", () => {
    const tally = tallyVotes(
      [A, B],
      [voteFor("v1", A), voteFor("v1", B), voteFor("v2", B)],
    );
    expect(tally.find((t) => t.optionId === "opt-b")?.count).toBe(2);
    expect(tally.find((t) => t.optionId === "opt-a")?.count).toBe(0);
  });

  it("ranks descending by count, ties keep input order", () => {
    const tally = tallyVotes([A, B], [voteFor("v1", A), voteFor("v2", B)]);
    // Tie 1-1: A listed first, so A stays first.
    expect(tally[0]?.optionId).toBe("opt-a");
  });
});

describe("resolvePoll — documented edge cases", () => {
  it("no votes at all -> not resolved, reason no_votes", () => {
    const r = resolvePoll([A, B], []);
    expect(r.resolved).toBe(false);
    expect(r.reason).toBe("no_votes");
    expect(r.tally.every((t) => t.count === 0)).toBe(true);
  });

  it("clear winner -> resolved with the top option", () => {
    const r = resolvePoll(
      [A, B],
      [voteFor("v1", A), voteFor("v2", A), voteFor("v3", B)],
    );
    expect(r.resolved).toBe(true);
    expect(r.winner?.venueId).toBe("ven-a");
    expect(r.winner?.count).toBe(2);
  });

  it("tie at the top -> not resolved, reason tie (never auto-picks)", () => {
    const r = resolvePoll([A, B], [voteFor("v1", A), voteFor("v2", B)]);
    expect(r.resolved).toBe(false);
    expect(r.reason).toBe("tie");
  });

  it("re-vote flips the winner", () => {
    const r = resolvePoll(
      [A, B],
      [voteFor("v1", A), voteFor("v1", B), voteFor("v2", B)],
    );
    expect(r.resolved).toBe(true);
    expect(r.winner?.venueId).toBe("ven-b");
    expect(r.winner?.count).toBe(2);
  });

  it("stale vote for a removed option is ignored", () => {
    const stale: Vote = { voterId: "v2", optionId: "opt-removed" };
    const r = resolvePoll([A], [voteFor("v1", A), stale]);
    expect(r.resolved).toBe(true);
    expect(r.winner?.venueId).toBe("ven-a");
    expect(r.winner?.count).toBe(1);
  });

  it("single option, single vote -> resolved", () => {
    const r = resolvePoll([A], [voteFor("v1", A)]);
    expect(r.resolved).toBe(true);
    expect(r.winner?.venueId).toBe("ven-a");
  });
});

describe("canTransition", () => {
  it("allows the legal lifecycle transitions", () => {
    expect(canTransition("voting", "resolved")).toBeNull();
    expect(canTransition("voting", "ended")).toBeNull();
    expect(canTransition("resolved", "ended")).toBeNull();
  });

  it("forbids un-resolving and anything out of ended", () => {
    expect(canTransition("resolved", "voting")).not.toBeNull();
    expect(canTransition("ended", "voting")).not.toBeNull();
    expect(canTransition("ended", "resolved")).not.toBeNull();
  });
});
