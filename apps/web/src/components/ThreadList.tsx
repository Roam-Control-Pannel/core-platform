/**
 * ThreadList — the /threads home. The caller's chats, most-recently-active first,
 * plus "New chat". First surfacing of the Stage 2b chat router to users.
 *
 * Chat is PRIVATE, so this gates on useSession() (unlike public Explore): signed
 * out shows the just-in-time auth prompt (the claim-flow pattern); signed in shows
 * the list. Ships every state with the feature (States matrix): content-shaped
 * skeleton while loading, an honest first-run empty state, and an error state.
 *
 * Create is the minimum viable thread for this slice: a GROUP thread with a title,
 * empty of other people (participants are added later from the detail screen). No
 * friends list exists yet, so we don't pretend to pick people at creation time.
 *
 * Timestamps arrive as ISO strings (the client has no transformer), formatted in
 * the UI — same as FeedList.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Pill, Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";

interface ThreadRow {
  id: string;
  isGroup: boolean;
  title: string | null;
  updatedAt: string;
  participantCount: number;
}

export function ThreadList() {
  const trpc = useTrpc();
  const session = useSession();
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  const load = useCallback(() => {
    let cancelled = false;
    setThreads(null);
    setError(null);
    trpc.chat.listThreads
      .query()
      .then((rows) => {
        if (!cancelled) setThreads(rows as ThreadRow[]);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load your chats.");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  // Only load when signed in (the query is protected; an anon call would 401).
  useEffect(() => {
    if (!session) {
      setThreads(null);
      return;
    }
    return load();
  }, [session, load]);

  const createThread = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) {
      setCreateError("Give your chat a name.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await trpc.chat.createThread.mutate({ isGroup: true, title });
      setNewTitle("");
      setShowCreate(false);
      load(); // refresh the list so the new thread appears (server-truth)
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : "Couldn't create the chat.");
    } finally {
      setCreating(false);
    }
  }, [trpc, newTitle, load]);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--space-2) 0 var(--space-4)",
        }}
      >
        <Link
          href="/explore"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--muted)",
            textDecoration: "none",
          }}
        >
          <span aria-hidden>←</span> Explore
        </Link>
        <h1
          className="t-h2"
          style={{ fontFamily: "var(--display)", fontWeight: 600, margin: 0, fontSize: 22 }}
        >
          Chats
        </h1>
        {session ? (
          <Button variant="pri" size="sm" onClick={() => setShowCreate((s) => !s)}>
            {showCreate ? "Cancel" : "New chat"}
          </Button>
        ) : (
          <span style={{ width: 1 }} />
        )}
      </header>

      {session && showCreate ? (
        <Card flat style={{ marginBottom: "var(--space-4)", padding: "var(--space-4)" }}>
          <label style={{ display: "grid", gap: 5 }}>
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: "var(--muted)",
              }}
            >
              Chat name
            </span>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. Friday night out"
              maxLength={200}
              style={{
                fontFamily: "var(--ui)",
                fontSize: 14,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--line-2)",
                background: "#fff",
                color: "var(--ink)",
                outline: "none",
              }}
            />
          </label>
          {createError ? (
            <div style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-2)" }} role="alert">
              {createError}
            </div>
          ) : null}
          <div style={{ marginTop: "var(--space-3)" }}>
            <Button variant="pri" onClick={createThread} disabled={creating}>
              {creating ? "Creating…" : "Create chat"}
            </Button>
          </div>
        </Card>
      ) : null}

      {!session ? (
        <SignedOut />
      ) : error ? (
        <ErrorState message={error} />
      ) : threads === null ? (
        <ListSkeleton />
      ) : threads.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {threads.map((t) => (
            <ThreadRowCard key={t.id} thread={t} />
          ))}
        </div>
      )}
    </main>
  );
}

function ThreadRowCard({ thread }: { thread: ThreadRow }) {
  const name = thread.title?.trim() || (thread.isGroup ? "Untitled group" : "Direct chat");
  return (
    <Link href={`/threads/${thread.id}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card style={{ padding: "var(--space-4)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600 }}>
            {name}
          </div>
          <Pill variant="neutral" size="sm">
            {thread.participantCount} {thread.participantCount === 1 ? "person" : "people"}
          </Pill>
        </div>
        <div style={{ marginTop: "var(--space-2)", fontSize: 12, color: "var(--faint)", fontFamily: "var(--ui)" }}>
          {thread.isGroup ? "Group" : "Direct"} · updated {formatWhen(thread.updatedAt)}
        </div>
      </Card>
    </Link>
  );
}

/** Compact relative-ish date — same helper shape as FeedList. */
function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const day = 86_400_000;
  if (diffMs < day) return "today";
  if (diffMs < 2 * day) return "yesterday";
  const days = Math.floor(diffMs / day);
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

function SignedOut() {
  return (
    <AuthPanel
      intro="Your chats are private. Sign in to see them and start new ones."
      emailRedirectTo={signedOutReturnUrl()}
      onAuthed={() => {
        // The session change re-runs the list effect automatically; nothing to do.
      }}
    />
  );
}

/** Return here after email confirmation (sign-up). No resume flag needed — landing
 *  on /threads signed in is enough; the list loads on the session change. */
function signedOutReturnUrl(): string {
  const origin =
    (typeof window !== "undefined" ? window.location.origin : undefined) ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "http://localhost:3000";
  return `${origin}/threads`;
}

function ListSkeleton() {
  return (
    <div style={{ display: "grid", gap: "var(--space-3)" }}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          style={{
            borderRadius: 16,
            border: "1px solid var(--line)",
            background: "var(--card)",
            padding: "var(--space-4)",
            display: "grid",
            gap: "var(--space-2)",
          }}
        >
          <div style={{ height: 16, width: "55%", background: "var(--paper-2)", borderRadius: 6 }} />
          <div style={{ height: 11, width: "30%", background: "var(--paper-2)", borderRadius: 6 }} />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)", maxWidth: 420, margin: "0 auto" }}>
      <div
        aria-hidden
        style={{
          width: 56,
          height: 56,
          margin: "0 auto var(--space-4)",
          borderRadius: "50%",
          background: "var(--crimson-tint)",
          display: "grid",
          placeItems: "center",
          fontSize: 24,
          color: "var(--crimson-700)",
        }}
      >
        ◍
      </div>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        No chats yet
      </div>
      <p style={{ color: "var(--muted)", lineHeight: 1.55 }}>
        Start a group chat to plan a meet-up with friends. Create one with “New chat”, then add people to it.
      </p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Couldn&apos;t load your chats
      </div>
      <p style={{ color: "var(--muted)" }}>{message}</p>
    </div>
  );
}
