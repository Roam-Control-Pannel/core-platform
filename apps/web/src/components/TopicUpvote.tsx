/**
 * Vote pills for Town Hall — the horizontal ▲ + count control (Reddit-style action bar). Optimistic:
 * a tap flips local state immediately and calls the toggle mutation, reconciling to the server count
 * (or reverting on error). Upvote-only by design — a friendly, positive-only signal for a local
 * community. Two thin wrappers share one <VotePill>: TopicUpvote (topics) and ReplyUpvote (comments).
 *
 * Signed-out callers see the count read-only (browse-freely): the control is disabled with a
 * "sign in to upvote" title rather than throwing them into auth mid-scroll.
 */
"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";

interface ToggleResult {
  upvoted: boolean;
  upvoteCount: number;
}

function VotePill({
  initialUpvoted,
  initialCount,
  canVote,
  onToggle,
  size = "md",
  vertical = false,
}: {
  initialUpvoted: boolean;
  initialCount: number;
  canVote: boolean;
  onToggle: () => Promise<ToggleResult>;
  size?: "md" | "sm";
  /** Column form (chevron button above the count) — the board card's left vote rail. */
  vertical?: boolean;
}) {
  const t = useTranslations("topicUpvote");
  const [upvoted, setUpvoted] = useState(initialUpvoted);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);

  const toggle = useCallback(async () => {
    if (!canVote || busy) return;
    setBusy(true);
    const prevUpvoted = upvoted;
    const prevCount = count;
    setUpvoted(!prevUpvoted);
    setCount(prevCount + (prevUpvoted ? -1 : 1));
    try {
      const res = await onToggle();
      setUpvoted(res.upvoted);
      setCount(res.upvoteCount);
    } catch {
      setUpvoted(prevUpvoted);
      setCount(prevCount);
    } finally {
      setBusy(false);
    }
  }, [canVote, busy, upvoted, count, onToggle]);

  const sm = size === "sm";

  if (vertical) {
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); void toggle(); }}
          disabled={!canVote || busy}
          aria-pressed={upvoted}
          aria-label={upvoted ? t("removeUpvote") : t("upvote")}
          title={canVote ? (upvoted ? t("removeUpvote") : t("upvote")) : t("signInToUpvote")}
          style={{
            all: "unset",
            boxSizing: "border-box",
            cursor: canVote ? "pointer" : "default",
            display: "grid",
            placeItems: "center",
            width: 32,
            height: 32,
            borderRadius: 10,
            border: `1px solid ${upvoted ? "var(--crimson-tint-2)" : "var(--line)"}`,
            background: upvoted ? "var(--crimson-tint)" : "#fff",
            color: upvoted ? "var(--crimson-700)" : "var(--ink-2)",
          }}
        >
          <Icon name="upvote" size={16} />
        </button>
        <span style={{ fontFamily: "var(--ui)", fontSize: 14, fontWeight: 700, lineHeight: 1, color: upvoted ? "var(--crimson-700)" : "var(--ink)" }}>
          {count}
        </span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); void toggle(); }}
      disabled={!canVote || busy}
      aria-pressed={upvoted}
      aria-label={upvoted ? t("removeUpvote") : t("upvote")}
      title={canVote ? (upvoted ? t("removeUpvote") : t("upvote")) : t("signInToUpvote")}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: canVote ? "pointer" : "default",
        display: "inline-flex",
        alignItems: "center",
        gap: sm ? 5 : 6,
        padding: sm ? "3px 9px" : "5px 12px",
        borderRadius: 999,
        border: `1px solid ${upvoted ? "var(--crimson-tint-2)" : "var(--line)"}`,
        background: upvoted ? "var(--crimson-tint)" : "var(--paper-2)",
        color: upvoted ? "var(--crimson-700)" : "var(--ink-2)",
        fontFamily: "var(--ui)",
      }}
    >
      <Icon name="upvote" size={sm ? 14 : 16} />
      <span style={{ fontSize: sm ? 12 : 13, fontWeight: 700, lineHeight: 1 }}>{count}</span>
    </button>
  );
}

export function TopicUpvote({
  topicId,
  initialUpvoted,
  initialCount,
  canVote,
  vertical = false,
}: {
  topicId: string;
  initialUpvoted: boolean;
  initialCount: number;
  canVote: boolean;
  vertical?: boolean;
}) {
  const trpc = useTrpc();
  const onToggle = useCallback(() => {
    const mut = trpc.townHall.toggleUpvote as unknown as { mutate: (i: { topicId: string }) => Promise<ToggleResult> };
    return mut.mutate({ topicId });
  }, [trpc, topicId]);
  return <VotePill initialUpvoted={initialUpvoted} initialCount={initialCount} canVote={canVote} onToggle={onToggle} vertical={vertical} />;
}

export function ReplyUpvote({
  replyId,
  initialUpvoted,
  initialCount,
  canVote,
}: {
  replyId: string;
  initialUpvoted: boolean;
  initialCount: number;
  canVote: boolean;
}) {
  const trpc = useTrpc();
  const onToggle = useCallback(() => {
    const mut = trpc.townHall.toggleReplyUpvote as unknown as { mutate: (i: { replyId: string }) => Promise<ToggleResult> };
    return mut.mutate({ replyId });
  }, [trpc, replyId]);
  return <VotePill initialUpvoted={initialUpvoted} initialCount={initialCount} canVote={canVote} onToggle={onToggle} size="sm" />;
}
