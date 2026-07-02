/**
 * PollMessage — renders a chat poll (message kind='poll') and its live results. The question +
 * options are the immutable payload snapshot; votes + closed state come from poll.results (fetched
 * on mount, refetched after a vote/close). Tapping an option casts/switches/toggles your vote
 * (single vs multi enforced server-side). Votes are visible (per the product decision) — each
 * option shows who picked it. The creator can close the poll.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import type { PollPayload } from "../lib/chatKinds";

interface Vote {
  optionId: string;
  profileId: string;
  name: string | null;
  avatar: string | null;
}

export function PollMessage({ messageId, payload, mine }: { messageId: string; payload: PollPayload; mine: boolean }) {
  const trpc = useTrpc();
  const session = useSession();
  const myId = session?.user?.id ?? null;

  const [votes, setVotes] = useState<Vote[]>([]);
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const q = trpc.poll.results as unknown as { query: (i: { messageId: string }) => Promise<{ closed: boolean; votes: Vote[] }> };
    try {
      const r = await q.query({ messageId });
      setVotes(Array.isArray(r.votes) ? r.votes : []);
      setClosed(!!r.closed);
    } catch {
      /* leave as-is */
    }
  }, [trpc, messageId]);

  useEffect(() => { void load(); }, [load]);

  const myVotes = useMemo(() => new Set(votes.filter((v) => v.profileId === myId).map((v) => v.optionId)), [votes, myId]);
  const totalVoters = useMemo(() => new Set(votes.map((v) => v.profileId)).size, [votes]);
  const maxCount = useMemo(
    () => payload.options.reduce((m, o) => Math.max(m, votes.filter((v) => v.optionId === o.id).length), 0),
    [payload.options, votes],
  );

  const vote = useCallback(
    async (optionId: string) => {
      if (closed || busy) return;
      setBusy(true);
      const mut = trpc.poll.vote as unknown as { mutate: (i: { messageId: string; optionId: string }) => Promise<unknown> };
      try {
        await mut.mutate({ messageId, optionId });
        await load();
      } catch {
        /* ignore */
      } finally {
        setBusy(false);
      }
    },
    [trpc, messageId, closed, busy, load],
  );

  const closePoll = useCallback(async () => {
    setBusy(true);
    const mut = trpc.poll.close as unknown as { mutate: (i: { messageId: string }) => Promise<unknown> };
    try {
      await mut.mutate({ messageId });
      await load();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }, [trpc, messageId, load]);

  return (
    <div style={{ maxWidth: 300, width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 14, border: "1px solid var(--line)", background: "#fff", boxShadow: "var(--sh-1)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Icon name="poll" size={16} style={{ color: "var(--crimson-700)", flexShrink: 0 }} />
        <span style={{ fontFamily: "var(--ui)", fontWeight: 700, fontSize: 14.5, color: "var(--ink-hi)", lineHeight: 1.3 }}>{payload.question}</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10, fontFamily: "var(--ui)" }}>
        {closed ? "Poll closed" : payload.multi ? "Select one or more" : "Select one"} · {totalVoters} {totalVoters === 1 ? "vote" : "votes"}
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {payload.options.map((o) => {
          const optVotes = votes.filter((v) => v.optionId === o.id);
          const count = optVotes.length;
          const picked = myVotes.has(o.id);
          const pct = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => void vote(o.id)}
              disabled={closed || busy}
              style={{ all: "unset", cursor: closed ? "default" : "pointer", display: "block", position: "relative", borderRadius: 10, border: picked ? "1px solid var(--crimson)" : "1px solid var(--line)", padding: "8px 10px", background: "var(--paper-2)", overflow: "hidden" }}
            >
              {/* result bar */}
              <div aria-hidden style={{ position: "absolute", inset: 0, width: `${pct}%`, background: picked ? "var(--crimson-tint)" : "var(--line)", opacity: 0.6, transition: "width .2s ease" }} />
              <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <span aria-hidden style={{ fontSize: 13, color: picked ? "var(--crimson-700)" : "var(--muted)" }}>{picked ? "◉" : "○"}</span>
                  <span style={{ fontFamily: "var(--ui)", fontSize: 13.5, fontWeight: picked ? 700 : 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.text}</span>
                </span>
                <span style={{ fontFamily: "var(--ui)", fontSize: 12.5, fontWeight: 700, color: "var(--ink-2)" }}>{count}</span>
              </div>
              {optVotes.length > 0 ? (
                <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 3, marginTop: 6, flexWrap: "wrap" }}>
                  {optVotes.slice(0, 8).map((v) => (
                    <VoterDot key={v.profileId} name={v.name} avatar={v.avatar} />
                  ))}
                  {optVotes.length > 8 ? <span style={{ fontSize: 11, color: "var(--muted)" }}>+{optVotes.length - 8}</span> : null}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>

      {mine && !closed ? (
        <button type="button" onClick={() => void closePoll()} disabled={busy} style={{ all: "unset", cursor: "pointer", marginTop: 10, fontSize: 12, color: "var(--crimson-700)", fontWeight: 600 }}>
          Close poll
        </button>
      ) : null}
    </div>
  );
}

/** A tiny voter avatar (image or monogram) with the name in a tooltip. */
function VoterDot({ name, avatar }: { name: string | null; avatar: string | null }) {
  const label = name?.trim() || "Roam member";
  const initial = label.replace(/^@/, "").charAt(0).toUpperCase() || "?";
  return (
    <span title={label} style={{ width: 18, height: 18, borderRadius: "50%", overflow: "hidden", background: "var(--crimson-tint)", display: "inline-grid", placeItems: "center", color: "var(--crimson-700)", fontFamily: "var(--ui)", fontWeight: 700, fontSize: 9 }}>
      {avatar ? (
        // eslint-disable-next-line @next/next/no-img-element -- public avatar URL, 18px
        <img src={avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        initial
      )}
    </span>
  );
}
