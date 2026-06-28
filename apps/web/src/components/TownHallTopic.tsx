/**
 * TownHallTopic — a single Town Hall topic (/town-hall/[topicId]): the opening post with its
 * upvote, the thread of replies, a just-in-time-auth reply composer, and a quiet report link
 * (the user half of the moderation backstop, same posture as ReportVenue).
 *
 * PUBLIC to read; replying / upvoting / reporting need an account. Ships loading / not-found /
 * error / loaded states.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { TopicUpvote } from "./TopicUpvote";
import { townHallAuthor, authorInitial, timeAgo, type TownHallAuthor } from "../lib/townHall";

interface TopicView {
  id: string;
  title: string;
  body: string;
  upvoteCount: number;
  replyCount: number;
  localityLabel: string;
  createdAt: string;
  author: TownHallAuthor;
  viewerUpvoted: boolean;
}
interface ReplyView {
  id: string;
  body: string;
  createdAt: string;
  author: TownHallAuthor;
}

export function TownHallTopic({ topicId }: { topicId: string }) {
  const trpc = useTrpc();
  const session = useSession();
  const [data, setData] = useState<{ topic: TopicView; replies: ReplyView[] } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const getTopic = trpc.townHall.getTopic as unknown as {
      query: (input: { topicId: string }) => Promise<{ topic: TopicView; replies: ReplyView[] } | null>;
    };
    return getTopic.query({ topicId });
  }, [trpc, topicId]);

  useEffect(() => {
    let cancelled = false;
    setData(undefined);
    setError(null);
    load()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load this topic.");
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const onReplied = useCallback(() => {
    void load().then((d) => setData(d)).catch(() => {});
  }, [load]);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link
        href="/town-hall"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          color: "var(--muted)",
          textDecoration: "none",
          marginBottom: "var(--space-4)",
        }}
      >
        <span aria-hidden>←</span> Town Hall
      </Link>

      {error ? (
        <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>{error}</p>
        </Card>
      ) : data === undefined ? (
        <div style={{ height: 160, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
      ) : data === null ? (
        <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
            Topic not found
          </div>
          <p style={{ color: "var(--ink-2)", margin: 0 }}>It may have been removed, or the link is wrong.</p>
        </Card>
      ) : (
        <>
          <Card style={{ padding: "var(--space-4)" }}>
            <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}>
              <TopicUpvote
                topicId={data.topic.id}
                initialUpvoted={data.topic.viewerUpvoted}
                initialCount={data.topic.upvoteCount}
                canVote={!!session}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    letterSpacing: ".04em",
                    textTransform: "uppercase",
                    color: "var(--muted)",
                    marginBottom: 4,
                  }}
                >
                  {data.topic.localityLabel}
                </div>
                <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 22, lineHeight: 1.25, margin: 0 }}>
                  {data.topic.title}
                </h1>
                <div style={{ marginTop: "var(--space-2)", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
                  <span>{townHallAuthor(data.topic.author)}</span>
                  <span aria-hidden>·</span>
                  <span>{timeAgo(data.topic.createdAt)}</span>
                </div>
                <p style={{ marginTop: "var(--space-3)", marginBottom: 0, color: "var(--ink)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                  {data.topic.body}
                </p>
              </div>
            </div>
          </Card>

          {/* Replies */}
          <div style={{ marginTop: "var(--space-5)" }}>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: "var(--muted)",
                marginBottom: "var(--space-3)",
              }}
            >
              {data.replies.length === 0
                ? "No replies yet"
                : data.replies.length === 1
                  ? "1 reply"
                  : `${data.replies.length} replies`}
            </div>
            <div style={{ display: "grid", gap: "var(--space-3)" }}>
              {data.replies.map((r) => (
                <ReplyRow key={r.id} reply={r} />
              ))}
            </div>
          </div>

          {/* Reply composer — auth-gated */}
          <div style={{ marginTop: "var(--space-5)" }}>
            {session ? (
              <ReplyComposer topicId={topicId} onReplied={onReplied} />
            ) : (
              <Card style={{ padding: "var(--space-4)" }}>
                <AuthPanel
                  intro="Sign in to join the conversation."
                  emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
                  onAuthed={() => {
                    /* session change re-renders; the composer shows */
                  }}
                />
              </Card>
            )}
          </div>

          {session ? <ReportTopic topicId={topicId} /> : null}
        </>
      )}
    </main>
  );
}

function ReplyRow({ reply }: { reply: ReplyView }) {
  return (
    <Card flat style={{ padding: "var(--space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span
          aria-hidden
          style={{
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: "var(--crimson-tint)",
            color: "var(--crimson-700)",
            display: "grid",
            placeItems: "center",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {authorInitial(reply.author)}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{townHallAuthor(reply.author)}</span>
        <span aria-hidden style={{ color: "var(--muted)" }}>·</span>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{timeAgo(reply.createdAt)}</span>
      </div>
      <p style={{ margin: 0, color: "var(--ink-2)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{reply.body}</p>
    </Card>
  );
}

function ReplyComposer({ topicId, onReplied }: { topicId: string; onReplied: () => void }) {
  const trpc = useTrpc();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const createReply = trpc.townHall.createReply as unknown as {
      mutate: (input: { topicId: string; body: string }) => Promise<{ id: string }>;
    };
    try {
      await createReply.mutate({ topicId, body });
      setBody("");
      setBusy(false);
      onReplied();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Couldn't post your reply.");
      setBusy(false);
    }
  }, [trpc, topicId, body, onReplied]);

  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Add a reply…"
        aria-label="Your reply"
        rows={3}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "10px 12px",
          marginBottom: "var(--space-3)",
          background: "var(--paper-2)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-md)",
          fontFamily: "var(--ui)",
          fontSize: 16,
          color: "var(--ink)",
          outline: "none",
          resize: "vertical",
          minHeight: 80,
        }}
      />
      {err ? (
        <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-2)" }}>
          {err}
        </div>
      ) : null}
      <Button variant="pri" onClick={() => void submit()} disabled={body.trim().length === 0 || busy}>
        {busy ? "Posting…" : "Post reply"}
      </Button>
    </Card>
  );
}

/** Quiet report affordance for a topic — files a user_report for human review. */
function ReportTopic({ topicId }: { topicId: string }) {
  const trpc = useTrpc();
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");

  const report = useCallback(async () => {
    setState("sending");
    const reportTopic = trpc.townHall.reportTopic as unknown as {
      mutate: (input: { topicId: string }) => Promise<{ ok: true }>;
    };
    try {
      await reportTopic.mutate({ topicId });
      setState("done");
    } catch {
      setState("idle");
    }
  }, [trpc, topicId]);

  if (state === "done") {
    return (
      <p style={{ marginTop: "var(--space-6)", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
        Thanks — a moderator will take a look.
      </p>
    );
  }
  return (
    <div style={{ marginTop: "var(--space-6)", textAlign: "center" }}>
      <button
        type="button"
        onClick={() => void report()}
        disabled={state === "sending"}
        style={{
          all: "unset",
          cursor: state === "sending" ? "default" : "pointer",
          fontSize: 12,
          color: "var(--muted)",
          textDecoration: "underline",
        }}
      >
        {state === "sending" ? "Reporting…" : "Report this topic"}
      </button>
    </div>
  );
}
