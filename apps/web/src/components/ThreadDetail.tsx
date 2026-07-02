/**
 * ThreadDetail — /threads/[id]. A two-view chat surface modelled on WhatsApp:
 *
 *   - CONVERSATION (default): the chat IS the screen. A tappable header (name + subtitle),
 *     an optional slim meet-up banner when one's live, the message list filling the viewport,
 *     and the composer pinned beneath it. Nothing else competes for space.
 *   - CHAT INFO: opened by tapping the header. The "settings section" — members, add someone,
 *     the full meet-up controls, rename (groups), and leave. Back returns to the conversation.
 *
 * One getThread load (RLS-scoped: NOT_FOUND if the caller isn't a participant) feeds both views;
 * a local `view` flag flips between them (no route change, instant transition). Adding a
 * participant is GROUP-ONLY at the router, so the add control only shows on a group. Private
 * surface → gates on useSession(). Timestamps are ISO strings, formatted in the UI.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Pill, Button, AvatarStack } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { MeetupPanel } from "./MeetupPanel";
import { MessageCard } from "./ChatCards";
import { ChatShareMenu } from "./ChatShareMenu";
import type { MessageKind } from "../lib/chatKinds";
import actions from "./inlineActions.module.css";
import styles from "./Chat.module.css";

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

interface Friend {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

function friendName(f: Friend): string {
  if (f.displayName && f.displayName.trim()) return f.displayName.trim();
  if (f.handle && f.handle.trim()) return `@${f.handle.trim()}`;
  return "Roam member";
}

/** Heading for the thread: its title for group/plan; the OTHER person for a 1:1 DM. */
function threadHeading(thread: ThreadData, myId: string | null): string {
  if (thread.title?.trim()) return thread.title.trim();
  if (!thread.isGroup) {
    const other = thread.participants.find((p) => p.profileId !== myId) ?? thread.participants[0];
    if (other) return other.displayName?.trim() || (other.handle ? `@${other.handle}` : "Direct chat");
    return "Direct chat";
  }
  return "Untitled group";
}

/** One-line context under the heading: who/how many, or the chat kind. */
function threadSubtitle(thread: ThreadData, myId: string | null): string {
  if (!thread.isGroup) {
    const other = thread.participants.find((p) => p.profileId !== myId) ?? thread.participants[0];
    return other?.handle ? `@${other.handle}` : "Direct chat";
  }
  if (thread.planId) return "Plan chat";
  const n = thread.participants.length;
  return `${n} ${n === 1 ? "person" : "people"} · tap for info`;
}

export function ThreadDetail({ threadId }: { threadId: string }) {
  const trpc = useTrpc();
  const session = useSession();
  const myId = session?.user?.id ?? null;
  const [thread, setThread] = useState<ThreadData | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "info">("chat");

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

  // Opening a thread marks it read (clears its unread badge in the inbox on next load).
  useEffect(() => {
    if (!session) return;
    const mut = trpc.chat.markRead as unknown as { mutate: (i: { threadId: string }) => Promise<unknown> };
    mut.mutate({ threadId }).catch(() => {});
  }, [session, threadId, trpc]);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-3) var(--space-4) var(--space-6)" }}>
      {!session ? (
        <SignedOut />
      ) : error ? (
        <ErrorState message={error} />
      ) : thread === undefined ? (
        <DetailSkeleton />
      ) : thread === null ? (
        <NotFoundState />
      ) : view === "chat" ? (
        <ConversationView thread={thread} myId={myId} onOpenInfo={() => setView("info")} />
      ) : (
        <ChatInfoView thread={thread} myId={myId} onBack={() => setView("chat")} onChanged={load} />
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ conversation view */

function ConversationView({
  thread,
  myId,
  onOpenInfo,
}: {
  thread: ThreadData;
  myId: string | null;
  onOpenInfo: () => void;
}) {
  return (
    <>
      <Link
        href="/threads"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-2)" }}
      >
        <span aria-hidden>←</span> Chats
      </Link>

      <button type="button" className={styles.headerBtn} onClick={onOpenInfo} aria-label="Open chat info">
        <ChatAvatar label={threadHeading(thread, myId)} />
        <span style={{ display: "grid", gap: 1, minWidth: 0, flex: 1 }}>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
            <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 19, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {threadHeading(thread, myId)}
            </span>
            <Pill variant={thread.planId ? "ghost-crim" : "neutral"} size="sm">
              {thread.planId ? "Plan" : thread.isGroup ? "Group" : "Direct"}
            </Pill>
          </span>
          <span style={{ fontSize: 12.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {threadSubtitle(thread, myId)}
          </span>
        </span>
        <span aria-hidden style={{ color: "var(--faint)", fontSize: 20, paddingLeft: 4 }}>›</span>
      </button>

      <div style={{ marginTop: "var(--space-4)" }}>
        {thread.isGroup ? <MeetupBar threadId={thread.id} onOpen={onOpenInfo} /> : null}
        <MessagePanel threadId={thread.id} isGroup={thread.isGroup} />
      </div>
    </>
  );
}

/**
 * MeetupBar — a slim, tappable banner shown above the messages when a live meet-up exists
 * (voting or resolved; hidden when there's none or it's ended). Its own light forThread read so
 * the conversation stays lean; tapping opens Chat info where the full poll controls live.
 */
function MeetupBar({ threadId, onOpen }: { threadId: string; onOpen: () => void }) {
  const trpc = useTrpc();
  const session = useSession();
  const [meetup, setMeetup] = useState<{ state: string } | null | undefined>(undefined);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    trpc.meetup.forThread
      .query({ threadId })
      .then((m) => {
        if (!cancelled) setMeetup((m as { state: string } | null) ?? null);
      })
      .catch(() => {
        if (!cancelled) setMeetup(null);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, threadId, session]);

  if (!meetup || meetup.state === "ended") return null;
  const label = meetup.state === "voting" ? "Meet-up · voting open" : "Meet-up · winner decided";
  return (
    <button type="button" className={styles.meetupBar} onClick={onOpen}>
      <span aria-hidden>📍</span>
      <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
      <span aria-hidden style={{ opacity: 0.8 }}>Open ›</span>
    </button>
  );
}

/* ------------------------------------------------------------------ chat info view */

function ChatInfoView({
  thread,
  myId,
  onBack,
  onChanged,
}: {
  thread: ThreadData;
  myId: string | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  const trpc = useTrpc();

  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);

  const openAdd = useCallback(async () => {
    setShowAdd(true);
    setAddError(null);
    const q = trpc.social.myFriends as unknown as { query: () => Promise<{ ok: boolean; friends?: Friend[] }> };
    try {
      const r = await q.query();
      setFriends(r.ok ? r.friends ?? [] : []);
    } catch {
      setFriends([]);
    }
  }, [trpc]);

  const addParticipant = useCallback(
    async (profileId: string) => {
      setAdding(profileId);
      setAddError(null);
      try {
        await trpc.chat.addThreadParticipant.mutate({ threadId: thread.id, profileId });
        onChanged(); // refresh participants from server-truth
      } catch (e: unknown) {
        setAddError(e instanceof Error ? e.message : "Couldn't add that person.");
      } finally {
        setAdding(null);
      }
    },
    [trpc, thread.id, onChanged],
  );

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", marginBottom: "var(--space-4)" }}
      >
        <span aria-hidden>←</span> Back to chat
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-2)" }}>
        <ChatAvatar label={threadHeading(thread, myId)} size={44} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 24, margin: 0 }}>
              {threadHeading(thread, myId)}
            </h1>
            <Pill variant={thread.planId ? "ghost-crim" : "neutral"} size="sm">
              {thread.planId ? "Plan chat" : thread.isGroup ? "Group" : "Direct"}
            </Pill>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--faint)", marginTop: 2 }}>Created {formatWhen(thread.createdAt)}</div>
        </div>
      </div>

      {thread.planId ? (
        <Link
          href={`/plans/${thread.planId}`}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--crimson-700)", fontWeight: 600, textDecoration: "none", marginBottom: "var(--space-4)" }}
        >
          🗓 View the plan <span aria-hidden>→</span>
        </Link>
      ) : null}

      <div style={{ marginTop: "var(--space-5)" }}>
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
      </div>

      {thread.isGroup ? (
        <div style={{ marginTop: "var(--space-4)" }}>
          {showAdd ? (
            <Card flat style={{ padding: "var(--space-4)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-3)" }}>
                <SectionLabel>Add a friend</SectionLabel>
                <button type="button" onClick={() => { setShowAdd(false); setAddError(null); }} style={{ all: "unset", cursor: "pointer", color: "var(--muted)", fontSize: 13 }}>
                  Done
                </button>
              </div>
              {(() => {
                const here = new Set(thread.participants.map((p) => p.profileId));
                const addable = friends.filter((f) => !here.has(f.id));
                if (addable.length === 0) {
                  return (
                    <p style={{ color: "var(--ink-2)", margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                      {friends.length === 0
                        ? "No friends to add yet. Add friends from their profile walls, then bring them in here."
                        : "All your friends are already in this chat."}
                    </p>
                  );
                }
                return (
                  <div style={{ display: "grid", gap: "var(--space-2)" }}>
                    {addable.map((f) => (
                      <div key={f.id} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{friendName(f)}</span>
                        <Button variant="neutral" size="sm" onClick={() => void addParticipant(f.id)} disabled={adding === f.id}>
                          {adding === f.id ? "…" : "Add"}
                        </Button>
                      </div>
                    ))}
                  </div>
                );
              })()}
              {addError ? (
                <div style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-2)" }} role="alert">
                  {addError}
                </div>
              ) : null}
            </Card>
          ) : (
            <Button variant="neutral" onClick={() => void openAdd()}>
              Add someone
            </Button>
          )}
        </div>
      ) : null}

      {thread.isGroup ? <MeetupPanel threadId={thread.id} /> : null}

      <ThreadActions thread={thread} onRenamed={onChanged} />
    </>
  );
}

/**
 * ThreadActions — manage-this-chat controls in Chat info. A free-standing group can be renamed;
 * a group or direct chat can be left (a plan chat is managed via its plan). Leaving routes back
 * to the inbox.
 */
function ThreadActions({ thread, onRenamed }: { thread: ThreadData; onRenamed: () => void }) {
  const trpc = useTrpc();
  const router = useRouter();
  const canRename = thread.isGroup && !thread.planId;
  const canLeave = !thread.planId; // group or direct; a plan chat re-adds you on open

  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(thread.title ?? "");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = useCallback(async () => {
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    try {
      await trpc.chat.renameThread.mutate({ threadId: thread.id, title: t });
      setRenaming(false);
      onRenamed();
    } catch {
      /* keep editing */
    } finally {
      setBusy(false);
    }
  }, [trpc, thread.id, title, onRenamed]);

  const leave = useCallback(async () => {
    setBusy(true);
    try {
      await trpc.chat.leaveThread.mutate({ threadId: thread.id });
      router.push("/threads");
    } catch {
      setBusy(false);
      setConfirmLeave(false);
    }
  }, [trpc, thread.id, router]);

  if (!canRename && !canLeave) return null;

  const linkStyle: React.CSSProperties = { all: "unset", cursor: "pointer", fontSize: 12.5, color: "var(--muted)", textDecoration: "underline" };

  return (
    <div style={{ marginTop: "var(--space-8)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--line)" }}>
      {renaming ? (
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Group name"
            maxLength={200}
            style={{ flex: 1, minWidth: 180, fontFamily: "var(--ui)", fontSize: 14, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--line-2)", background: "#fff", color: "var(--ink)", outline: "none" }}
          />
          <Button variant="pri" size="sm" onClick={() => void save()} disabled={busy || title.trim().length === 0}>{busy ? "…" : "Save"}</Button>
          <Button variant="neutral" size="sm" onClick={() => { setRenaming(false); setTitle(thread.title ?? ""); }} disabled={busy}>Cancel</Button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "center" }}>
          {canRename ? <button type="button" onClick={() => setRenaming(true)} style={linkStyle}>Rename chat</button> : null}
          {canLeave ? (
            confirmLeave ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)", fontSize: 12.5, color: "var(--ink-2)" }}>
                Leave this chat?
                <button type="button" onClick={() => void leave()} disabled={busy} style={{ ...linkStyle, color: "var(--crimson-700)", fontWeight: 600 }}>{busy ? "Leaving…" : "Yes, leave"}</button>
                <button type="button" onClick={() => setConfirmLeave(false)} disabled={busy} style={linkStyle}>Cancel</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmLeave(true)} style={{ ...linkStyle, color: "var(--crimson-700)" }}>Leave chat</button>
            )
          ) : null}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ messages */

interface ThreadMessage {
  id: string;
  senderId: string | null;
  body: string | null;
  kind: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  senderName: string | null;
  senderHandle: string | null;
  senderAvatar: string | null;
}

/**
 * MessagePanel — the conversation body. Reads chat.listMessages (oldest-first, RLS-scoped) and
 * posts via chat.sendMessage. State ladder: error -> undefined(skeleton) -> empty -> content.
 * The list fills the viewport (Chat.module.css .scroll) and pins to the newest message; the
 * composer sits directly beneath it, always visible. After a send we refetch server-truth.
 * Only kind='text' renders; a non-text kind shows a neutral placeholder (the rich-kind seam).
 */
function MessagePanel({ threadId, isGroup }: { threadId: string; isGroup: boolean }) {
  const trpc = useTrpc();
  const session = useSession();
  const [messages, setMessages] = useState<ThreadMessage[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const myId = session?.user?.id ?? null;

  const load = useCallback(() => {
    let cancelled = false;
    setMessages(undefined);
    setError(null);
    trpc.chat.listMessages
      .query({ threadId })
      .then((rows) => {
        if (!cancelled) setMessages(rows as ThreadMessage[]);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load messages.");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, threadId]);

  useEffect(() => load(), [load]);

  // Keep the list pinned to the newest message as content arrives / a send lands.
  useEffect(() => {
    if (messages && messages.length > 0 && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body) {
      setSendError("Type a message to send.");
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      await trpc.chat.sendMessage.mutate({ threadId, body });
      setDraft("");
      load(); // refetch server-truth (includes the just-sent message)
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : "Couldn't send your message.");
    } finally {
      setSending(false);
    }
  }, [trpc, threadId, draft, load]);

  // Share a rich card (venue/plan/person) — same send path, a kind + validated payload snapshot.
  const sendRich = useCallback(
    async (kind: MessageKind, payload: Record<string, unknown>) => {
      setSendError(null);
      const mut = trpc.chat.sendMessage as unknown as {
        mutate: (i: { threadId: string; kind: MessageKind; payload: Record<string, unknown> }) => Promise<unknown>;
      };
      try {
        await mut.mutate({ threadId, kind, payload });
        load();
      } catch (e: unknown) {
        setSendError(e instanceof Error ? e.message : "Couldn't share that.");
      }
    },
    [trpc, threadId, load],
  );

  if (error) {
    return (
      <Card flat style={{ padding: "var(--space-4)" }}>
        <p style={{ color: "var(--muted)", margin: 0, fontSize: 13 }}>{error}</p>
      </Card>
    );
  }
  if (messages === undefined) return <MessagesSkeleton />;

  return (
    <div>
      <div ref={listRef} className={styles.scroll}>
        <div className={styles.scrollInner}>
          {messages.length === 0 ? (
            <p style={{ color: "var(--muted)", fontSize: 13, margin: "var(--space-2) 0" }}>
              No messages yet — say something to get this chat going.
            </p>
          ) : (
            buildRenderItems(messages, myId).map((it) =>
              it.type === "date" ? (
                <div key={it.key} className={styles.dateChip}>{it.label}</div>
              ) : (
                <MessageRow
                  key={it.key}
                  message={it.message}
                  mine={it.mine}
                  isGroup={isGroup}
                  showHeader={it.showHeader}
                  onChanged={load}
                />
              ),
            )
          )}
        </div>
      </div>

      {/* composer */}
      <div style={{ position: "relative", display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)", alignItems: "flex-end" }}>
        <ChatShareMenu threadId={threadId} onShare={(kind, payload) => void sendRich(kind, payload)} disabled={sending} />
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Write a message…"
          rows={2}
          maxLength={4000}
          style={{
            flex: 1,
            resize: "none",
            fontFamily: "var(--ui)",
            fontSize: 14,
            lineHeight: 1.45,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid var(--line-2)",
            background: "#fff",
            color: "var(--ink)",
            outline: "none",
          }}
        />
        <Button variant="pri" onClick={() => void send()} disabled={sending}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
      {sendError ? (
        <div style={{ color: "var(--crimson-700)", fontSize: 13, marginTop: "var(--space-2)" }} role="alert">
          {sendError}
        </div>
      ) : null}
    </div>
  );
}

/** A rendered row: either a day separator or a message (with its grouping flag). */
type RenderItem =
  | { type: "date"; key: string; label: string }
  | { type: "msg"; key: string; message: ThreadMessage; mine: boolean; showHeader: boolean };

/**
 * Turn a flat message list into rendered rows: insert a day separator when the calendar day
 * changes, and mark a message as a group START (showHeader) when it's the first of the day, from a
 * different sender than the previous, or more than 5 minutes after it. Grouped continuations hide
 * the name/time and tuck under the same avatar gutter — the WhatsApp read.
 */
function buildRenderItems(messages: ThreadMessage[], myId: string | null): RenderItem[] {
  const items: RenderItem[] = [];
  let lastDay = "";
  let prev: ThreadMessage | null = null;
  for (const m of messages) {
    const d = new Date(m.createdAt);
    const dayKey = Number.isNaN(d.getTime()) ? "" : d.toDateString();
    if (dayKey !== lastDay) {
      items.push({ type: "date", key: `date-${m.id}`, label: dayLabel(m.createdAt) });
      lastDay = dayKey;
      prev = null;
    }
    const mine = m.senderId !== null && m.senderId === myId;
    const grouped = prev !== null && prev.senderId === m.senderId && withinMinutes(prev.createdAt, m.createdAt, 5);
    items.push({ type: "msg", key: m.id, message: m, mine, showHeader: !grouped });
    prev = m;
  }
  return items;
}

function MessageRow({ message, mine, isGroup, showHeader, onChanged }: { message: ThreadMessage; mine: boolean; isGroup: boolean; showHeader: boolean; onChanged: () => void }) {
  const trpc = useTrpc();
  const name =
    message.senderName?.trim() ||
    (message.senderHandle ? `@${message.senderHandle}` : null) ||
    (mine ? "You" : "Roam member");

  const isText = message.kind === "text";
  const showAvatarGutter = isGroup && !mine; // avatars only for OTHERS in a group

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body ?? "");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const saveEdit = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      await trpc.chat.editMessage.mutate({ messageId: message.id, body });
      setEditing(false);
      onChanged();
    } catch {
      setBusy(false);
    }
  }, [trpc, message.id, draft, onChanged]);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await trpc.chat.deleteMessage.mutate({ messageId: message.id });
      onChanged();
    } catch {
      setBusy(false);
      setConfirming(false);
    }
  }, [trpc, message.id, onChanged]);

  return (
    <div className={styles.msgWrap} style={{ display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start", gap: 2, marginTop: showHeader ? "var(--space-3)" : 2 }}>
      {showHeader ? (
        <span style={{ fontFamily: "var(--ui)", fontSize: 11, color: "var(--faint)", paddingLeft: showAvatarGutter ? 38 : 2, paddingRight: mine ? 2 : 0 }}>
          {mine ? formatClock(message.createdAt) : `${name} · ${formatClock(message.createdAt)}`}
        </span>
      ) : null}

      <div style={{ display: "flex", flexDirection: mine ? "row-reverse" : "row", alignItems: "flex-end", gap: 8, maxWidth: "85%" }}>
        {showAvatarGutter ? (
          showHeader ? <MsgAvatar name={name} url={message.senderAvatar} /> : <div style={{ width: 30, flex: "0 0 auto" }} />
        ) : null}

        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start", gap: 4 }}>
          {editing ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, width: "100%", minWidth: 220 }}>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                maxLength={4000}
                aria-label="Edit message"
                style={{ width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "var(--ui)", fontSize: 14, lineHeight: 1.45, padding: "8px 12px", borderRadius: 12, border: "1px solid var(--line-2)", background: "#fff", color: "var(--ink)", outline: "none" }}
              />
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <Button variant="pri" size="sm" onClick={() => void saveEdit()} disabled={busy || draft.trim().length === 0}>{busy ? "…" : "Save"}</Button>
                <Button variant="neutral" size="sm" onClick={() => { setEditing(false); setDraft(message.body ?? ""); }} disabled={busy}>Cancel</Button>
              </div>
            </div>
          ) : isText ? (
            <div
              style={{
                padding: "8px 12px",
                borderRadius: 14,
                fontSize: 14,
                lineHeight: 1.45,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                background: mine ? "var(--crimson-tint)" : "#fff",
                color: "var(--ink-hi)",
                border: mine ? "1px solid var(--crimson-tint-2)" : "1px solid var(--line)",
                boxShadow: "var(--sh-1)",
              }}
            >
              {message.body ?? ""}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start", gap: 4 }}>
              <MessageCard kind={message.kind as MessageKind} payload={message.payload} messageId={message.id} mine={mine} />
              {message.body ? (
                <div style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.4, maxWidth: 260 }}>{message.body}</div>
              ) : null}
            </div>
          )}

          {mine && !editing ? (
            confirming ? (
              <div className={`${actions.row} ${styles.msgActions}`}>
                <span className={actions.confirm}>Delete?</span>
                <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => void remove()} disabled={busy}>{busy ? "…" : "Yes"}</button>
                <button type="button" className={actions.action} onClick={() => setConfirming(false)} disabled={busy}>No</button>
              </div>
            ) : (
              <div className={`${actions.row} ${styles.msgActions}`}>
                {isText ? <button type="button" className={actions.action} onClick={() => setEditing(true)}>Edit</button> : null}
                <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => setConfirming(true)}>Delete</button>
              </div>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Small round avatar for a message sender in a group chat (image, or a monogram fallback). */
function MsgAvatar({ name, url }: { name: string; url: string | null }) {
  const initial = (name.replace(/^@/, "").charAt(0) || "?").toUpperCase();
  return (
    <div style={{ width: 30, height: 30, flex: "0 0 auto", borderRadius: "50%", overflow: "hidden", background: "var(--crimson-tint)", display: "grid", placeItems: "center", color: "var(--crimson-700)", fontFamily: "var(--ui)", fontWeight: 600, fontSize: 12 }}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- public avatar URL; next/image adds no value on a 30px chat avatar
        <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        initial
      )}
    </div>
  );
}

/** True if two ISO timestamps are within `mins` minutes of each other (for message grouping). */
function withinMinutes(a: string, b: string, mins: number): boolean {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(tb - ta) <= mins * 60_000;
}

/** Day separator label: Today / Yesterday / a full date. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** Clock time for a message header, e.g. "14:32". */
function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function MessagesSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {[
        { w: "55%", me: false },
        { w: "40%", me: true },
        { w: "65%", me: false },
      ].map((r, i) => (
        <div key={i} style={{ display: "flex", justifyContent: r.me ? "flex-end" : "flex-start" }}>
          <div style={{ height: 32, width: r.w, background: "var(--paper-2)", borderRadius: 12 }} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ shared bits */

/** Round monogram avatar for a chat (group or DM), from the heading's first letter. */
function ChatAvatar({ label, size = 38 }: { label: string; size?: number }) {
  const initial = (label.replace(/^@/, "").charAt(0) || "?").toUpperCase();
  return (
    <div style={{ flex: "0 0 auto" }}>
      <AvatarStack size={size}>
        {[
          <div
            key="a"
            style={{ width: "100%", height: "100%", background: "var(--crimson-tint)", display: "grid", placeItems: "center", color: "var(--crimson-700)", fontFamily: "var(--ui)", fontWeight: 600, fontSize: size <= 40 ? 15 : 18 }}
          >
            {initial}
          </div>,
        ]}
      </AvatarStack>
    </div>
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
            style={{ width: "100%", height: "100%", background: "var(--crimson-tint)", display: "grid", placeItems: "center", color: "var(--crimson-700)", fontFamily: "var(--ui)", fontWeight: 600, fontSize: 12 }}
          >
            {initial}
          </div>,
        ]}
      </AvatarStack>
      <div style={{ display: "grid", gap: 1 }}>
        <span style={{ fontFamily: "var(--ui)", fontSize: 14, fontWeight: 600, color: "var(--ink-hi)" }}>{name}</span>
        {participant.handle ? (
          <span style={{ fontFamily: "var(--ui)", fontSize: 12, color: "var(--muted)" }}>@{participant.handle}</span>
        ) : null}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>
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
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>Sign in to view this chat</div>
      <p style={{ color: "var(--muted)", marginBottom: "var(--space-4)" }}>Chats are private to their members.</p>
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
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>Chat not found</div>
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
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>Couldn&apos;t load this chat</div>
      <p style={{ color: "var(--muted)" }}>{message}</p>
    </div>
  );
}
