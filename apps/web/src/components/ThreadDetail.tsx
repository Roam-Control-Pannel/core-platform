/**
 * ThreadDetail — /threads/[id]. The thread surface: its messages (primary), its
 * participants, and the meet-up poll. Messages are the main content (Stage 2c-iii);
 * participants + MeetupPanel sit alongside.
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

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Pill, Button, AvatarStack } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { MeetupPanel } from "./MeetupPanel";
import actions from "./inlineActions.module.css";

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

export function ThreadDetail({ threadId }: { threadId: string }) {
  const trpc = useTrpc();
  const session = useSession();
  const myId = session?.user?.id ?? null;
  const [thread, setThread] = useState<ThreadData | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);

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
        await trpc.chat.addThreadParticipant.mutate({ threadId, profileId });
        load(); // refresh participants from server-truth
      } catch (e: unknown) {
        setAddError(e instanceof Error ? e.message : "Couldn't add that person.");
      } finally {
        setAdding(null);
      }
    },
    [trpc, threadId, load],
  );

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
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
              {threadHeading(thread, myId)}
            </h1>
            <Pill variant={thread.planId ? "ghost-crim" : "neutral"} size="sm">
              {thread.planId ? "Plan chat" : thread.isGroup ? "Group" : "Direct"}
            </Pill>
          </div>
          {thread.planId ? (
            <Link
              href={`/plans/${thread.planId}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--crimson-700)", fontWeight: 600, textDecoration: "none", marginBottom: "var(--space-6)" }}
            >
              🗓 View the plan <span aria-hidden>→</span>
            </Link>
          ) : (
            <div style={{ fontSize: 12.5, color: "var(--faint)", marginBottom: "var(--space-6)" }}>
              Created {formatWhen(thread.createdAt)}
            </div>
          )}

          <MessagePanel threadId={thread.id} />

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

          {thread.isGroup ? <MeetupPanel threadId={thread.id} /> : null}

          {thread.isGroup ? (
            <div style={{ marginTop: "var(--space-6)" }}>
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

          <ThreadActions thread={thread} onRenamed={load} />
        </>
      )}
    </main>
  );
}

/**
 * ThreadActions — manage-this-chat controls at the foot of the thread. A free-standing group
 * can be renamed; a group or direct chat can be left (a plan chat is managed via its plan, so
 * neither applies). Leaving routes back to the inbox.
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

interface ThreadMessage {
  id: string;
  senderId: string | null;
  body: string | null;
  kind: string;
  createdAt: string;
  senderName: string | null;
  senderHandle: string | null;
}

/**
 * MessagePanel — the thread's chat surface. Reads chat.listMessages (oldest-first,
 * RLS-scoped) and posts via chat.sendMessage. Ships the full state ladder:
 * error -> undefined(skeleton) -> empty("new, not dead") -> content. After a send
 * we refetch from server-truth (the sender always sees their own message back, even
 * while it's moderation-pending). Dates arrive as ISO strings; formatted here.
 *
 * Only kind='text' is rendered this slice; a non-text kind (the open rich-kind seam)
 * shows a neutral placeholder rather than nothing, so a future venue_card/poll
 * message isn't silently dropped before its renderer exists.
 */
function MessagePanel({ threadId }: { threadId: string }) {
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

  return (
    <section style={{ marginBottom: "var(--space-8)" }}>
      <SectionLabel>Messages</SectionLabel>

      {error ? (
        <Card flat style={{ padding: "var(--space-4)", marginTop: "var(--space-2)" }}>
          <p style={{ color: "var(--muted)", margin: 0, fontSize: 13 }}>{error}</p>
        </Card>
      ) : messages === undefined ? (
        <MessagesSkeleton />
      ) : (
        <Card flat style={{ padding: "var(--space-4)", marginTop: "var(--space-2)" }}>
          <div
            ref={listRef}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
              maxHeight: 420,
              overflowY: "auto",
            }}
          >
            {messages.length === 0 ? (
              <p style={{ color: "var(--muted)", fontSize: 13, margin: "var(--space-2) 0" }}>
                No messages yet — say something to get this chat going.
              </p>
            ) : (
              messages.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  mine={m.senderId !== null && m.senderId === myId}
                  onChanged={load}
                />
              ))
            )}
          </div>

          {/* composer */}
          <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-4)", alignItems: "flex-end" }}>
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
                resize: "vertical",
                fontFamily: "var(--ui)",
                fontSize: 14,
                lineHeight: 1.45,
                padding: "10px 12px",
                borderRadius: 10,
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
        </Card>
      )}
    </section>
  );
}

function MessageRow({ message, mine, onChanged }: { message: ThreadMessage; mine: boolean; onChanged: () => void }) {
  const trpc = useTrpc();
  const name =
    message.senderName?.trim() ||
    (message.senderHandle ? `@${message.senderHandle}` : null) ||
    (mine ? "You" : "Roam member");

  // Rich-kind seam: only text renders this slice; other kinds get a neutral note.
  const isText = message.kind === "text";

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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: mine ? "flex-end" : "flex-start",
        gap: 2,
      }}
    >
      <span style={{ fontFamily: "var(--ui)", fontSize: 11, color: "var(--faint)" }}>
        {mine ? "You" : name} · {formatWhen(message.createdAt)}
      </span>
      {editing ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, maxWidth: "85%", width: "100%" }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            maxLength={4000}
            aria-label="Edit message"
            style={{
              width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "var(--ui)", fontSize: 14,
              lineHeight: 1.45, padding: "8px 12px", borderRadius: 12, border: "1px solid var(--line-2)",
              background: "#fff", color: "var(--ink)", outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button variant="pri" size="sm" onClick={() => void saveEdit()} disabled={busy || draft.trim().length === 0}>{busy ? "…" : "Save"}</Button>
            <Button variant="neutral" size="sm" onClick={() => { setEditing(false); setDraft(message.body ?? ""); }} disabled={busy}>Cancel</Button>
          </div>
        </div>
      ) : (
        <>
          <div
            style={{
              maxWidth: "78%",
              padding: "8px 12px",
              borderRadius: 12,
              fontSize: 14,
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: mine ? "var(--crimson-tint)" : "var(--paper-2)",
              color: "var(--ink-hi)",
              border: mine ? "1px solid var(--crimson-tint-2)" : "1px solid var(--line)",
            }}
          >
            {isText ? (
              message.body ?? ""
            ) : (
              <span style={{ color: "var(--muted)", fontStyle: "italic" }}>
                Unsupported message type
              </span>
            )}
          </div>
          {mine && isText ? (
            confirming ? (
              <div className={actions.row} style={{ marginTop: 2 }}>
                <span className={actions.confirm}>Delete?</span>
                <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => void remove()} disabled={busy}>{busy ? "…" : "Yes"}</button>
                <button type="button" className={actions.action} onClick={() => setConfirming(false)} disabled={busy}>No</button>
              </div>
            ) : (
              <div className={actions.row} style={{ marginTop: 2 }}>
                <button type="button" className={actions.action} onClick={() => setEditing(true)}>Edit</button>
                <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => setConfirming(true)}>Delete</button>
              </div>
            )
          ) : null}
        </>
      )}
    </div>
  );
}

function MessagesSkeleton() {
  return (
    <Card flat style={{ padding: "var(--space-4)", marginTop: "var(--space-2)" }}>
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
    </Card>
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
