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
import { useRouter } from "next/navigation";
import { Card, Button, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { TopicUpvote } from "./TopicUpvote";
import { CopyLinkButton } from "./CopyLinkButton";
import { authorInitial, timeAgo, type TownHallAuthor } from "../lib/townHall";
import { AuthorLink } from "./AuthorLink";
import actions from "./inlineActions.module.css";

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

/** The loaded topic + its replies — also the shape the server passes as the SSR seed. */
export interface TopicDetailData {
  topic: TopicView;
  replies: ReplyView[];
}

export function TownHallTopic({ topicId, initialData }: { topicId: string; initialData?: TopicDetailData | null }) {
  const trpc = useTrpc();
  const session = useSession();
  const router = useRouter();
  const myId = session?.user?.id ?? null;
  const [data, setData] = useState<TopicDetailData | null | undefined>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [editingTopic, setEditingTopic] = useState(false);

  const load = useCallback(async () => {
    const getTopic = trpc.townHall.getTopic as unknown as {
      query: (input: { topicId: string }) => Promise<TopicDetailData | null>;
    };
    return getTopic.query({ topicId });
  }, [trpc, topicId]);

  useEffect(() => {
    let cancelled = false;
    // When the server seeded the thread (SSR), refresh silently — pick up the viewer's upvote
    // state and any new replies without blanking the already-rendered content. Only the
    // unseeded path shows the skeleton / surfaces a load error.
    const seeded = initialData !== undefined;
    if (!seeded) {
      setData(undefined);
      setError(null);
    }
    load()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled && !seeded) setError(e instanceof Error ? e.message : "Couldn't load this topic.");
      });
    return () => {
      cancelled = true;
    };
  }, [load, initialData]);

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
            {/* Poster + community. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "var(--space-2)", fontSize: 12, color: "var(--muted)" }}>
              <span aria-hidden style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontSize: 11.5, fontWeight: 700, flexShrink: 0 }}>
                {authorInitial(data.topic.author)}
              </span>
              <AuthorLink author={data.topic.author} style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }} />
              <span aria-hidden>·</span>
              <span>{timeAgo(data.topic.createdAt)}</span>
              <span aria-hidden>·</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--muted)" }}>{data.topic.localityLabel}</span>
            </div>

            {editingTopic ? (
              <TopicEditor
                topicId={data.topic.id}
                initialTitle={data.topic.title}
                initialBody={data.topic.body}
                onSaved={() => { setEditingTopic(false); void load().then((d) => setData(d)).catch(() => {}); }}
                onCancel={() => setEditingTopic(false)}
              />
            ) : (
              <>
                <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 22, lineHeight: 1.25, margin: 0, letterSpacing: "-.01em" }}>
                  {data.topic.title}
                </h1>
                <p style={{ marginTop: "var(--space-3)", marginBottom: 0, color: "var(--ink)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                  {data.topic.body}
                </p>

                {/* Action bar: vote · comments · share. */}
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-4)", flexWrap: "wrap" }}>
                  <TopicUpvote
                    topicId={data.topic.id}
                    initialUpvoted={data.topic.viewerUpvoted}
                    initialCount={data.topic.upvoteCount}
                    canVote={!!session}
                  />
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 999, background: "var(--paper-2)", border: "1px solid var(--line)", color: "var(--ink-2)", fontFamily: "var(--ui)", fontSize: 13, fontWeight: 600 }}>
                    <Icon name="chat" size={15} /> {data.topic.replyCount}
                  </span>
                  <CopyLinkButton />
                </div>

                {myId && data.topic.author.id === myId ? (
                  <OwnerActions
                    onEdit={() => setEditingTopic(true)}
                    onDelete={async () => {
                      const del = trpc.townHall.removeTopic as unknown as { mutate: (i: { topicId: string }) => Promise<unknown> };
                      await del.mutate({ topicId });
                      router.push("/town-hall");
                    }}
                    confirmLabel="Delete this topic?"
                  />
                ) : null}
              </>
            )}
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
                <ReplyRow key={r.id} reply={r} myId={myId} onChanged={onReplied} />
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

function ReplyRow({ reply, myId, onChanged }: { reply: ReplyView; myId: string | null; onChanged: () => void }) {
  const trpc = useTrpc();
  const [editing, setEditing] = useState(false);
  const mine = !!myId && reply.author.id === myId;

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
        <AuthorLink author={reply.author} style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }} />
        <span aria-hidden style={{ color: "var(--muted)" }}>·</span>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{timeAgo(reply.createdAt)}</span>
      </div>
      {editing ? (
        <ReplyEditor
          replyId={reply.id}
          initialBody={reply.body}
          onSaved={() => { setEditing(false); onChanged(); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <p style={{ margin: 0, color: "var(--ink-2)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{reply.body}</p>
          {mine ? (
            <OwnerActions
              onEdit={() => setEditing(true)}
              onDelete={async () => {
                const del = trpc.townHall.removeReply as unknown as { mutate: (i: { replyId: string }) => Promise<unknown> };
                await del.mutate({ replyId: reply.id });
                onChanged();
              }}
              confirmLabel="Delete this reply?"
            />
          ) : null}
        </>
      )}
    </Card>
  );
}

/** A quiet Edit · Delete control row for content the viewer owns. Delete asks once inline. */
function OwnerActions({ onEdit, onDelete, confirmLabel }: { onEdit: () => void; onDelete: () => Promise<void>; confirmLabel: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (confirming) {
    return (
      <div className={actions.row} style={{ marginTop: "var(--space-3)" }}>
        <span className={actions.confirm}>{confirmLabel}</span>
        <button
          type="button"
          className={`${actions.action} ${actions.danger}`}
          disabled={busy}
          onClick={async () => { setBusy(true); try { await onDelete(); } catch { setBusy(false); setConfirming(false); } }}
        >
          {busy ? "Deleting…" : "Yes, delete"}
        </button>
        <button type="button" className={actions.action} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    );
  }
  return (
    <div className={actions.row} style={{ marginTop: "var(--space-3)" }}>
      <button type="button" className={actions.action} onClick={onEdit}>Edit</button>
      <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => setConfirming(true)}>Delete</button>
    </div>
  );
}

function TopicEditor({ topicId, initialTitle, initialBody, onSaved, onCancel }: { topicId: string; initialTitle: string; initialBody: string; onSaved: () => void; onCancel: () => void }) {
  const trpc = useTrpc();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const mut = trpc.townHall.updateTopic as unknown as { mutate: (i: { topicId: string; title: string; body: string }) => Promise<{ ok: true }> };
    try {
      await mut.mutate({ topicId, title, body });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save your changes.");
      setBusy(false);
    }
  }, [trpc, topicId, title, body, onSaved]);

  return (
    <div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Topic title" maxLength={140} style={editInput} />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} aria-label="Topic detail" rows={4} style={{ ...editInput, resize: "vertical", minHeight: 96 }} />
      {err ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-2)" }}>{err}</div> : null}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button variant="pri" size="sm" onClick={() => void save()} disabled={busy || title.trim().length === 0 || body.trim().length === 0}>{busy ? "Saving…" : "Save"}</Button>
        <Button variant="neutral" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

function ReplyEditor({ replyId, initialBody, onSaved, onCancel }: { replyId: string; initialBody: string; onSaved: () => void; onCancel: () => void }) {
  const trpc = useTrpc();
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const mut = trpc.townHall.updateReply as unknown as { mutate: (i: { replyId: string; body: string }) => Promise<{ ok: true }> };
    try {
      await mut.mutate({ replyId, body });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save your changes.");
      setBusy(false);
    }
  }, [trpc, replyId, body, onSaved]);

  return (
    <div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} aria-label="Edit reply" rows={3} style={{ ...editInput, resize: "vertical", minHeight: 72 }} />
      {err ? <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-2)" }}>{err}</div> : null}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button variant="pri" size="sm" onClick={() => void save()} disabled={busy || body.trim().length === 0}>{busy ? "Saving…" : "Save"}</Button>
        <Button variant="neutral" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

const editInput: React.CSSProperties = {
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
};

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
