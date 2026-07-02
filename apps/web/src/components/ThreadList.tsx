/**
 * ThreadList — the /threads home. The caller's chats, most-recently-active first,
 * plus "New chat". First surfacing of the Stage 2b chat router to users.
 *
 * Chat is PRIVATE, so this gates on useSession() (unlike public Explore): signed
 * out shows the just-in-time auth prompt (the claim-flow pattern); signed in shows
 * the list. Ships every state with the feature (States matrix): content-shaped
 * skeleton while loading, an honest first-run empty state, and an error state.
 *
 * Three kinds of chat share this inbox: DIRECT (1:1, started from a friend's wall or
 * the friends list via MessageButton), PLAN (a plan's group chat, opened from the plan),
 * and free-standing GROUP threads. "New chat" searches people and branches on how many you
 * pick: one → a 1:1 DM (deduped), several → a named group. Each row shows a kind
 * badge and the right name (the other person for a DM, the title for group/plan).
 *
 * Timestamps arrive as ISO strings (the client has no transformer), formatted in
 * the UI — same as FeedList.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Pill, Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { UserSearch, PersonAvatar, personName, type SearchedPerson } from "./UserSearch";
import rowStyles from "./listRow.module.css";

type ThreadKind = "plan" | "group" | "direct";

interface LastMessage {
  kind: string;
  body: string | null;
  senderId: string | null;
  createdAt: string;
}

interface ThreadRow {
  id: string;
  isGroup: boolean;
  planId: string | null;
  kind: ThreadKind;
  title: string | null;
  name: string | null;
  updatedAt: string;
  participantCount: number;
  lastMessage: LastMessage | null;
  unreadCount: number;
}

export function ThreadList() {
  const trpc = useTrpc();
  const session = useSession();
  const router = useRouter();
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<SearchedPerson[]>([]);
  const [groupTitle, setGroupTitle] = useState("");

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

  const toggle = useCallback((p: SearchedPerson) => {
    setCreateError(null);
    setSelected((cur) => (cur.some((x) => x.id === p.id) ? cur.filter((x) => x.id !== p.id) : [...cur, p]));
  }, []);

  const resetCreate = useCallback(() => {
    setShowCreate(false);
    setSelected([]);
    setGroupTitle("");
    setCreateError(null);
  }, []);

  // One entry point, WhatsApp-style: 1 person picked → a 1:1 DM; 2+ → a named group.
  const startChat = useCallback(async () => {
    if (selected.length === 0) return;
    setCreating(true);
    setCreateError(null);
    try {
      if (selected.length === 1) {
        const dm = trpc.chat.directThread as unknown as { mutate: (i: { profileId: string }) => Promise<{ threadId: string }> };
        const { threadId } = await dm.mutate({ profileId: selected[0]!.id });
        router.push(`/threads/${threadId}`);
        return;
      }
      const title = groupTitle.trim();
      if (!title) {
        setCreateError("Give your group a name.");
        setCreating(false);
        return;
      }
      const grp = trpc.chat.createGroupThread as unknown as {
        mutate: (i: { title: string; memberIds: string[] }) => Promise<{ id: string }>;
      };
      const { id } = await grp.mutate({ title, memberIds: selected.map((p) => p.id) });
      router.push(`/threads/${id}`);
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : "Couldn't start that chat.");
      setCreating(false);
    }
  }, [trpc, selected, groupTitle, router]);

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
          <Button variant="pri" size="sm" onClick={() => (showCreate ? resetCreate() : setShowCreate(true))}>
            {showCreate ? "Cancel" : "New chat"}
          </Button>
        ) : (
          <span style={{ width: 1 }} />
        )}
      </header>

      {session && showCreate ? (
        <Card flat style={{ marginBottom: "var(--space-4)", padding: "var(--space-4)" }}>
          {/* Selected people — chips with remove. */}
          {selected.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
              {selected.map((p) => (
                <span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px 4px 5px", borderRadius: 999, background: "var(--crimson-tint)", border: "1px solid var(--crimson-tint-2)" }}>
                  <PersonAvatar p={p} size={20} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--crimson-700)" }}>{personName(p)}</span>
                  <button type="button" aria-label={`Remove ${personName(p)}`} onClick={() => toggle(p)} style={{ all: "unset", cursor: "pointer", color: "var(--crimson-700)", fontSize: 14, lineHeight: 1, padding: "0 2px" }}>×</button>
                </span>
              ))}
            </div>
          ) : null}

          <UserSearch
            placeholder="Search people to chat with"
            autoFocus
            selectedIds={selected.map((p) => p.id)}
            onRowClick={toggle}
          />

          {/* 2+ people → it's a group, which needs a name. */}
          {selected.length >= 2 ? (
            <input
              value={groupTitle}
              onChange={(e) => setGroupTitle(e.target.value)}
              placeholder="Group name — e.g. Friday night out"
              aria-label="Group name"
              maxLength={200}
              style={{
                width: "100%", boxSizing: "border-box", marginTop: "var(--space-3)",
                fontFamily: "var(--ui)", fontSize: 16, padding: "11px 12px", borderRadius: 10,
                border: "1px solid var(--line-2)", background: "#fff", color: "var(--ink)", outline: "none",
              }}
            />
          ) : null}

          {createError ? (
            <div style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-2)" }} role="alert">
              {createError}
            </div>
          ) : null}

          {selected.length > 0 ? (
            <div style={{ marginTop: "var(--space-3)" }}>
              <Button variant="pri" onClick={() => void startChat()} disabled={creating}>
                {creating
                  ? "Starting…"
                  : selected.length === 1
                    ? `Message ${personName(selected[0]!)}`
                    : `Create group · ${selected.length}`}
              </Button>
            </div>
          ) : (
            <p style={{ color: "var(--muted)", fontSize: 12.5, margin: "var(--space-3) 2px 0", lineHeight: 1.5 }}>
              Pick one person for a direct chat, or several for a group.
            </p>
          )}
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
            <ThreadRowCard key={t.id} thread={t} myId={session.user?.id ?? null} />
          ))}
        </div>
      )}
    </main>
  );
}

const KIND_META: Record<ThreadKind, { label: string; glyph: string; fallback: string }> = {
  plan: { label: "Plan chat", glyph: "🗓", fallback: "Plan chat" },
  group: { label: "Group", glyph: "◍", fallback: "Untitled group" },
  direct: { label: "Direct", glyph: "✉", fallback: "Direct chat" },
};

/** The inbox preview line for a thread's last message ("You: …", or a label for a shared card). */
function previewText(last: LastMessage | null, myId: string | null): string {
  if (!last) return "No messages yet";
  const prefix = last.senderId && last.senderId === myId ? "You: " : "";
  switch (last.kind) {
    case "text":
      return prefix + (last.body?.trim() || "Message");
    case "venue_card":
      return prefix + "📍 Shared a place";
    case "plan_card":
      return prefix + "🗓 Shared a plan";
    case "profile_card":
      return prefix + "👤 Shared a contact";
    case "image":
      return prefix + "📷 Photo";
    case "poll":
      return prefix + "📊 Poll";
    default:
      return prefix + "Message";
  }
}

function ThreadRowCard({ thread, myId }: { thread: ThreadRow; myId: string | null }) {
  const meta = KIND_META[thread.kind];
  const name = thread.name?.trim() || thread.title?.trim() || meta.fallback;
  const unread = thread.unreadCount > 0;
  const when = formatWhen(thread.lastMessage?.createdAt ?? thread.updatedAt);
  return (
    <Link href={`/threads/${thread.id}`} className={rowStyles.cardLift} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card style={{ padding: "var(--space-4)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
            <span aria-hidden style={{ fontSize: 16, flexShrink: 0 }}>{meta.glyph}</span>
            <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {name}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexShrink: 0 }}>
            {unread ? (
              <span aria-label={`${thread.unreadCount} unread`} style={{ minWidth: 20, height: 20, padding: "0 6px", borderRadius: 999, background: "var(--crimson)", color: "#fff", fontFamily: "var(--ui)", fontSize: 11.5, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                {thread.unreadCount > 99 ? "99+" : thread.unreadCount}
              </span>
            ) : (
              <Pill variant={thread.kind === "plan" ? "ghost-crim" : "neutral"} size="sm">
                {meta.label}
              </Pill>
            )}
          </div>
        </div>
        <div
          style={{
            marginTop: "var(--space-2)",
            fontSize: 13,
            color: unread ? "var(--ink)" : "var(--muted)",
            fontWeight: unread ? 600 : 400,
            fontFamily: "var(--ui)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {previewText(thread.lastMessage, myId)}
        </div>
        <div style={{ marginTop: 3, fontSize: 12, color: "var(--faint)", fontFamily: "var(--ui)" }}>
          {thread.participantCount} {thread.participantCount === 1 ? "person" : "people"} · {when}
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
        Tap “New chat”, then search for someone — pick one person for a direct message, or several
        for a group. You can also message a friend from their profile, or open a plan to chat with
        everyone on it.
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
