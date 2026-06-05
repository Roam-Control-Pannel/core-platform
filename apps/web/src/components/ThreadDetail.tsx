/**
 * ThreadDetail — /threads/[id]. The thread container view: who's in it + adding
 * people. NOT messages — listing/sending messages is a later slice; this is the
 * participant surface that the meet-up poll UI (2c-ii) will build on.
 *
 * Reads chat.getThread (RLS-scoped: NOT_FOUND if the caller isn't a participant).
 * Adding a participant calls chat.addThreadParticipant, which is GROUP-ONLY at the
 * router (a 1:1 → group promotion is a separate deliberate action) — so the add
 * control only shows on a group thread, and a PRECONDITION_FAILED is surfaced if
 * the server still rejects.
 *
 * Add-by-profile-UUID is the minimum viable invite for this slice: no friends list
 * exists yet, so we take the profile id directly (exactly what a future friend
 * picker will resolve to). Ships all states: skeleton, error, not-found, loaded.
 *
 * Private surface → gates on useSession() like ThreadList. Timestamps are ISO
 * strings, formatted in the UI.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Pill, Button, AvatarStack } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";

interface Participant {
  profileId: string;
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  joinedAt: string;
}

interface ThreadData {
  id: string;
  isGroup: boolean;
  planId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  participants: Participant[];
}

export function ThreadDetail({ threadId }: { threadId: string }) {
  const trpc = useTrpc();
  const session = useSession();
  const [thread, setThread] = useState<ThreadData | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const [addProfileId, setAddProfileId] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setThread(undefined);
    setError(null);
    trpc.chat.getThread
      .query({ threadId })
      .then((t) => {
        if (!cancelled) setThread(t as ThreadData);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Failed to load this chat.";
        // getThread throws NOT_FOUND for "no such thread, or not yours" — treat as null.
        if (/not found/i.test(msg)) setThread(null);
        else setError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, threadId]);

  useEffect(() => {
    if (!session) {
      setThread(undefined);
      return;
    }
    return load();
  }, [session, load]);

  const addParticipant = useCallback(async () => {
    const profileId = addProfileId.trim();
    if (!profileId) {
      setAddError("Enter a profile ID to add.");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await trpc.chat.addThreadParticipant.mutate({ threadId, profileId });
      setAddProfileId("");
      setShowAdd(false);
      load(); // refresh participants from server-truth
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : "Couldn't add that person.");
    } finally {
      setAdding(false);
    }
  }, [trpc, threadId, addProfileId, load]);

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link
        href="/threads"
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
        <span aria-hidden>←</span> Chats
      </Link>

      {!session ? (
        <SignedOut />
      ) : error ? (
        <ErrorState message={error} />
      ) : thread === undefined ? (
        <DetailSkeleton />
      ) : thread === null ? (
        <NotFoundState />
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-2)" }}>
            <h1
              className="t-h1"
              style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 28, margin: 0 }}
            >
              {thread.title?.trim() || (thread.isGroup ? "Untitled group" : "Direct chat")}
            </h1>
            <Pill variant="neutral" size="sm">
              {thread.isGroup ? "Group" : "Direct"}
            </Pill>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--faint)", marginBottom: "var(--space-6)" }}>
            Created {formatWhen(thread.createdAt)}
          </div>

          <SectionLabel>
            {thread.participants.length} {thread.participants.length === 1 ? "person" : "people"}
          </SectionLabel>
          <Card flat style={{ padding: "var(--space-4)", marginTop: "var(--space-2)" }}>
            <div style={{ display: "grid", gap: "var(--space-3)" }}>
              {thread.participants.map((p) => (
                <ParticipantRow key={p.profileId} participant={p} />
              ))}
            </div>
          </Card>

          {thread.isGroup ? (
            <div style={{ marginTop: "var(--space-6)" }}>
              {showAdd ? (
                <Card flat style={{ padding: "var(--space-4)" }}>
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
                      Profile ID to add
                    </span>
                    <input
                      value={addProfileId}
                      onChange={(e) => setAddProfileId(e.target.value)}
                      placeholder="00000000-0000-0000-0000-000000000000"
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 13,
                        padding: "10px 12px",
                        borderRadius: 10,
                        border: "1px solid var(--line-2)",
                        background: "#fff",
                        color: "var(--ink)",
                        outline: "none",
                      }}
                    />
                  </label>
                  {addError ? (
                    <div style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-2)" }} role="alert">
                      {addError}
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
                    <Button variant="pri" onClick={addParticipant} disabled={adding}>
                      {adding ? "Adding…" : "Add to chat"}
                    </Button>
                    <Button variant="neutral" onClick={() => { setShowAdd(false); setAddError(null); }}>
                      Cancel
                    </Button>
                  </div>
                </Card>
              ) : (
                <Button variant="neutral" onClick={() => setShowAdd(true)}>
                  Add someone
                </Button>
              )}
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}

function ParticipantRow({ participant }: { participant: Participant }) {
  const name = participant.displayName?.trim() || participant.handle?.trim() || "Roam member";
  const initial = name.charAt(0).toUpperCase();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
      <AvatarStack>
        {[
          <div
            key="a"
            style={{
              width: "100%",
              height: "100%",
              background: "var(--crimson-tint)",
              display: "grid",
              placeItems: "center",
              color: "var(--crimson-700)",
              fontFamily: "var(--ui)",
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            {initial}
          </div>,
        ]}
      </AvatarStack>
      <div style={{ display: "grid", gap: 1 }}>
        <span style={{ fontFamily: "var(--ui)", fontSize: 14, fontWeight: 600, color: "var(--ink-hi)" }}>
          {name}
        </span>
        {participant.handle ? (
          <span style={{ fontFamily: "var(--ui)", fontSize: 12, color: "var(--muted)" }}>@{participant.handle}</span>
        ) : null}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--mono)",
        fontSize: 10,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        color: "var(--muted)",
      }}
    >
      {children}
    </div>
  );
}

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
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Sign in to view this chat
      </div>
      <p style={{ color: "var(--muted)", marginBottom: "var(--space-4)" }}>
        Chats are private to their members.
      </p>
      <Link href="/threads" style={{ textDecoration: "none" }}>
        <Pill variant="ghost-crim">← Back to Chats</Pill>
      </Link>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div>
      <div style={{ height: 28, width: "50%", background: "var(--paper-2)", borderRadius: 8 }} />
      <div style={{ height: 12, width: "25%", background: "var(--paper-2)", borderRadius: 6, marginTop: "var(--space-3)" }} />
      <div style={{ height: 120, background: "var(--paper-2)", borderRadius: 12, marginTop: "var(--space-6)" }} />
    </div>
  );
}

function NotFoundState() {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Chat not found
      </div>
      <p style={{ color: "var(--muted)", marginBottom: "var(--space-4)" }}>
        This chat may have been removed, or you don&apos;t have access to it.
      </p>
      <Link href="/threads" style={{ textDecoration: "none" }}>
        <Pill variant="ghost-crim">← Back to Chats</Pill>
      </Link>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Couldn&apos;t load this chat
      </div>
      <p style={{ color: "var(--muted)" }}>{message}</p>
    </div>
  );
}
