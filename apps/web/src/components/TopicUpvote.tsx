/**
 * TopicUpvote — the horizontal ▲ + count vote pill on a Town Hall topic (Reddit-style action bar),
 * used on both the board list and the topic page. Optimistic: a tap flips the local state
 * immediately and calls townHall.toggleUpvote, reconciling to the server count (or reverting on
 * error). Upvote-only by design — a friendly, positive-only signal for a local community.
 *
 * Signed-out callers see the count read-only (browse-freely): the control is disabled with a
 * "sign in to upvote" hint rather than throwing them into auth mid-scroll — they can upvote
 * once they sign in to post.
 */
"use client";

import { useState, useCallback } from "react";
import { Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";

export function TopicUpvote({
  topicId,
  initialUpvoted,
  initialCount,
  canVote,
}: {
  topicId: string;
  initialUpvoted: boolean;
  initialCount: number;
  canVote: boolean;
}) {
  const trpc = useTrpc();
  const [upvoted, setUpvoted] = useState(initialUpvoted);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);

  const toggle = useCallback(async () => {
    if (!canVote || busy) return;
    setBusy(true);
    // Optimistic flip.
    const prevUpvoted = upvoted;
    const prevCount = count;
    setUpvoted(!prevUpvoted);
    setCount(prevCount + (prevUpvoted ? -1 : 1));
    const toggleUpvote = trpc.townHall.toggleUpvote as unknown as {
      mutate: (input: { topicId: string }) => Promise<{ upvoted: boolean; upvoteCount: number }>;
    };
    try {
      const res = await toggleUpvote.mutate({ topicId });
      setUpvoted(res.upvoted);
      setCount(res.upvoteCount);
    } catch {
      // Revert on failure.
      setUpvoted(prevUpvoted);
      setCount(prevCount);
    } finally {
      setBusy(false);
    }
  }, [trpc, topicId, canVote, busy, upvoted, count]);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        void toggle();
      }}
      disabled={!canVote || busy}
      aria-pressed={upvoted}
      aria-label={upvoted ? "Remove upvote" : "Upvote"}
      title={canVote ? (upvoted ? "Remove upvote" : "Upvote") : "Sign in to upvote"}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: canVote ? "pointer" : "default",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 12px",
        borderRadius: 999,
        border: `1px solid ${upvoted ? "var(--crimson-tint-2)" : "var(--line)"}`,
        background: upvoted ? "var(--crimson-tint)" : "var(--paper-2)",
        color: upvoted ? "var(--crimson-700)" : "var(--ink-2)",
        fontFamily: "var(--ui)",
      }}
    >
      <Icon name="upvote" size={16} />
      <span style={{ fontSize: 13, fontWeight: 700, lineHeight: 1 }}>{count}</span>
    </button>
  );
}
