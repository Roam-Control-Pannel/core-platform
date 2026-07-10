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
import { useTranslations } from "next-intl";
import { Card, Pill, Button, AvatarStack, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { MeetupPanel } from "./MeetupPanel";
import { MessageCard } from "./ChatCards";
import { ChatShareMenu } from "./ChatShareMenu";
import { ThreadAvatar } from "./ThreadAvatar";
import { ImageCropper } from "./ImageCropper";
import { uploadChatImage } from "../lib/uploadChatImage";
import type { MessageKind } from "../lib/chatKinds";
import { useThreadRealtime } from "../lib/useThreadRealtime";
import { getFormatLocale } from "../lib/i18n/runtime";
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
  imagePath: string | null;
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
  participants: Participant[];
}

/** Kind + up-to-4 member avatars for a thread's ThreadAvatar (self ordered last). */
function threadIconProps(thread: ThreadData, myId: string | null): { kind: "plan" | "group" | "direct"; memberAvatars: string[] } {
  const kind = thread.planId ? "plan" : thread.isGroup ? "group" : "direct";
  const ordered =
    kind === "direct"
      ? thread.participants.filter((p) => p.profileId !== myId)
      : [...thread.participants].sort((a, b) => (a.profileId === myId ? 1 : 0) - (b.profileId === myId ? 1 : 0));
  const memberAvatars = ordered.map((p) => p.avatarUrl).filter((u): u is string => !!u).slice(0, 4);
  return { kind, memberAvatars };
}

interface Friend {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

function friendName(t: ReturnType<typeof useTranslations>, f: Friend): string {
  if (f.displayName && f.displayName.trim()) return f.displayName.trim();
  if (f.handle && f.handle.trim()) return `@${f.handle.trim()}`;
  return t("roamMember");
}

/** Heading for the thread: its title for group/plan; the OTHER person for a 1:1 DM. */
function threadHeading(t: ReturnType<typeof useTranslations>, thread: ThreadData, myId: string | null): string {
  if (thread.title?.trim()) return thread.title.trim();
  if (!thread.isGroup) {
    const other = thread.participants.find((p) => p.profileId !== myId) ?? thread.participants[0];
    if (other) return other.displayName?.trim() || (other.handle ? `@${other.handle}` : t("directChat"));
    return t("directChat");
  }
  return t("untitledGroup");
}

/** One-line context under the heading: "4 people · Sarah, Tom, Grace, you" (mockup style). */
function threadSubtitle(t: ReturnType<typeof useTranslations>, thread: ThreadData, myId: string | null): string {
  if (!thread.isGroup) {
    const other = thread.participants.find((p) => p.profileId !== myId) ?? thread.participants[0];
    return other?.handle ? `@${other.handle}` : t("directChat");
  }
  const n = thread.participants.length;
  // First names, self shown as "you" (last), capped so long groups stay one line.
  const others = thread.participants
    .filter((p) => p.profileId !== myId)
    .map((p) => (p.displayName?.trim() || (p.handle ? `@${p.handle}` : t("someone"))).split(/\s+/)[0]!)
    .slice(0, 3);
  const hasMe = thread.participants.some((p) => p.profileId === myId);
  const shown = [...others, ...(hasMe ? [t("youLower")] : [])];
  const more = n - others.length - (hasMe ? 1 : 0);
  const names = shown.join(", ") + (more > 0 ? ` +${more}` : "");
  const kind = thread.planId ? t("planChat") : t("people", { count: n });
  return names ? `${kind} · ${names}` : kind;
}

export function ThreadDetail({ threadId }: { threadId: string }) {
  const t = useTranslations("threadDetail");
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
        const msg = e instanceof Error ? e.message : t("errors.loadChat");
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
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
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
    </div>
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
  const t = useTranslations("threadDetail");
  return (
    <>
      {/* Mobile back to the list — the desktop shell shows the list beside us. */}
      <Link
        href="/threads"
        className={styles.mobileBack}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-2)" }}
      >
        <span aria-hidden>←</span> {t("chats")}
      </Link>

      <button type="button" className={styles.headerBtn} onClick={onOpenInfo} aria-label={t("openChatInfo")}>
        <ThreadAvatar name={threadHeading(t, thread, myId)} size={44} imageUrl={thread.imageUrl} {...threadIconProps(thread, myId)} />
        <span style={{ display: "grid", gap: 1, minWidth: 0, flex: 1 }}>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
            <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 19, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {threadHeading(t, thread, myId)}
            </span>
            <Pill variant={thread.planId ? "ghost-crim" : "neutral"} size="sm">
              {thread.planId ? t("kind.plan") : thread.isGroup ? t("kind.group") : t("kind.direct")}
            </Pill>
          </span>
          <span style={{ fontSize: 12.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {threadSubtitle(t, thread, myId)}
          </span>
        </span>
        <Icon name="chevronRight" size={20} style={{ color: "var(--faint)", flexShrink: 0 }} />
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
  const t = useTranslations("threadDetail");
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
  const label = meetup.state === "voting" ? t("meetupBar.voting") : t("meetupBar.winner");
  return (
    <button type="button" className={styles.meetupBar} onClick={onOpen}>
      <Icon name="place" size={15} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 2, opacity: 0.85 }}>{t("meetupBar.open")} <Icon name="chevronRight" size={13} /></span>
    </button>
  );
}

/* ------------------------------------------------------------------ group photo */

/**
 * The thread icon in Chat Info. For a free-standing GROUP chat it's tappable: pick → crop
 * (round, avatar) → upload to chat-media → chat.setThreadImage. A photo can be removed to fall
 * back to the member-avatar composite. Plan chats and DMs render a plain, non-editable icon.
 */
function GroupPhoto({ thread, myId, onChanged }: { thread: ThreadData; myId: string | null; onChanged: () => void }) {
  const t = useTranslations("threadDetail");
  const trpc = useTrpc();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = thread.isGroup && !thread.planId;
  const icon = <ThreadAvatar name={threadHeading(t, thread, myId)} size={56} imageUrl={thread.imageUrl} {...threadIconProps(thread, myId)} />;

  const upload = useCallback(
    async (cropped: File) => {
      setBusy(true);
      setError(null);
      try {
        const { path } = await uploadChatImage(thread.id, cropped);
        await trpc.chat.setThreadImage.mutate({ threadId: thread.id, imagePath: path });
        onChanged();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : t("photo.failed"));
      } finally {
        setBusy(false);
        setPending(null);
      }
    },
    [trpc, thread.id, onChanged, t],
  );

  const remove = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await trpc.chat.setThreadImage.mutate({ threadId: thread.id, imagePath: null });
      onChanged();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("photo.failed"));
    } finally {
      setBusy(false);
    }
  }, [trpc, thread.id, onChanged, t]);

  if (!editable) return icon;

  return (
    <div style={{ display: "grid", gap: 4, justifyItems: "center" }}>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        aria-label={thread.imageUrl ? t("photo.change") : t("photo.add")}
        style={{ all: "unset", cursor: busy ? "default" : "pointer", position: "relative", lineHeight: 0 }}
      >
        {icon}
        <span
          aria-hidden
          style={{ position: "absolute", right: -2, bottom: -2, width: 20, height: 20, borderRadius: "50%", background: "var(--crimson-700)", color: "#fff", display: "grid", placeItems: "center", border: "2px solid var(--card)" }}
        >
          <Icon name="camera" size={11} />
        </span>
      </button>
      <div style={{ display: "flex", gap: 8, fontSize: 11.5 }}>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} style={{ all: "unset", cursor: busy ? "default" : "pointer", color: "var(--crimson-700)", fontWeight: 600 }}>
          {busy ? t("photo.saving") : thread.imageUrl ? t("photo.change") : t("photo.add")}
        </button>
        {thread.imageUrl && !busy ? (
          <button type="button" onClick={() => void remove()} style={{ all: "unset", cursor: "pointer", color: "var(--muted)" }}>
            {t("photo.remove")}
          </button>
        ) : null}
      </div>
      {error ? <div style={{ fontSize: 11, color: "var(--crimson-700)", maxWidth: 160, textAlign: "center" }}>{error}</div> : null}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) setPending(f);
        }}
      />
      {pending ? (
        <ImageCropper
          file={pending}
          spec={{ aspect: 1, outputWidth: 800, round: true, title: t("photo.cropTitle") }}
          onCancel={() => setPending(null)}
          onCropped={(f) => void upload(f)}
        />
      ) : null}
    </div>
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
  const t = useTranslations("threadDetail");
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
        setAddError(e instanceof Error ? e.message : t("errors.addPerson"));
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
        <span aria-hidden>←</span> {t("backToChat")}
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-2)" }}>
        <GroupPhoto thread={thread} myId={myId} onChanged={onChanged} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 24, margin: 0 }}>
              {threadHeading(t, thread, myId)}
            </h1>
            <Pill variant={thread.planId ? "ghost-crim" : "neutral"} size="sm">
              {thread.planId ? t("planChat") : thread.isGroup ? t("kind.group") : t("kind.direct")}
            </Pill>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--faint)", marginTop: 2 }}>{t("createdWhen", { when: formatWhen(t, thread.createdAt) })}</div>
        </div>
      </div>

      {thread.planId ? (
        <Link
          href={`/plans/${thread.planId}`}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--crimson-700)", fontWeight: 600, textDecoration: "none", marginBottom: "var(--space-4)" }}
        >
          <Icon name="plan" size={15} /> {t("viewThePlan")} <span aria-hidden>→</span>
        </Link>
      ) : null}

      <div style={{ marginTop: "var(--space-5)" }}>
        <SectionLabel>
          {t("people", { count: thread.participants.length })}
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
                <SectionLabel>{t("addFriend")}</SectionLabel>
                <button type="button" onClick={() => { setShowAdd(false); setAddError(null); }} style={{ all: "unset", cursor: "pointer", color: "var(--muted)", fontSize: 13 }}>
                  {t("done")}
                </button>
              </div>
              {(() => {
                const here = new Set(thread.participants.map((p) => p.profileId));
                const addable = friends.filter((f) => !here.has(f.id));
                if (addable.length === 0) {
                  return (
                    <p style={{ color: "var(--ink-2)", margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                      {friends.length === 0
                        ? t("noFriendsToAdd")
                        : t("allFriendsHere")}
                    </p>
                  );
                }
                return (
                  <div style={{ display: "grid", gap: "var(--space-2)" }}>
                    {addable.map((f) => (
                      <div key={f.id} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{friendName(t, f)}</span>
                        <Button variant="neutral" size="sm" onClick={() => void addParticipant(f.id)} disabled={adding === f.id}>
                          {adding === f.id ? "…" : t("add")}
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
              {t("addSomeone")}
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
  const t = useTranslations("threadDetail");
  const trpc = useTrpc();
  const router = useRouter();
  const canRename = thread.isGroup && !thread.planId;
  const canLeave = !thread.planId; // group or direct; a plan chat re-adds you on open

  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(thread.title ?? "");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await trpc.chat.renameThread.mutate({ threadId: thread.id, title: trimmed });
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
            aria-label={t("groupNameAria")}
            maxLength={200}
            style={{ flex: 1, minWidth: 180, fontFamily: "var(--ui)", fontSize: 14, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--line-2)", background: "#fff", color: "var(--ink)", outline: "none" }}
          />
          <Button variant="pri" size="sm" onClick={() => void save()} disabled={busy || title.trim().length === 0}>{busy ? "…" : t("save")}</Button>
          <Button variant="neutral" size="sm" onClick={() => { setRenaming(false); setTitle(thread.title ?? ""); }} disabled={busy}>{t("cancel")}</Button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "center" }}>
          {canRename ? <button type="button" onClick={() => setRenaming(true)} style={linkStyle}>{t("renameChat")}</button> : null}
          {canLeave ? (
            confirmLeave ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)", fontSize: 12.5, color: "var(--ink-2)" }}>
                {t("leaveConfirm")}
                <button type="button" onClick={() => void leave()} disabled={busy} style={{ ...linkStyle, color: "var(--crimson-700)", fontWeight: 600 }}>{busy ? t("leaving") : t("yesLeave")}</button>
                <button type="button" onClick={() => setConfirmLeave(false)} disabled={busy} style={linkStyle}>{t("cancel")}</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmLeave(true)} style={{ ...linkStyle, color: "var(--crimson-700)" }}>{t("leaveChat")}</button>
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
  const t = useTranslations("threadDetail");
  const trpc = useTrpc();
  const session = useSession();
  const [messages, setMessages] = useState<ThreadMessage[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Whether the list is "stuck" to the bottom. True while the reader is at/near the newest
  // message; a live message then auto-scrolls. Set false once they scroll up to read history,
  // so an incoming message doesn't yank them down mid-read (WhatsApp behaviour).
  const stickRef = useRef(true);

  const myId = session?.user?.id ?? null;
  const token = session?.access_token ?? null;

  // Fetch server-truth. `silent` keeps the current messages on screen (no skeleton) — used for
  // background refetches (live events, after a send, edit/delete) so the view never flickers.
  const fetchMessages = useCallback(
    (silent = false) => {
      let cancelled = false;
      if (!silent) setMessages(undefined);
      setError(null);
      trpc.chat.listMessages
        .query({ threadId })
        .then((rows) => {
          if (!cancelled) setMessages(rows as ThreadMessage[]);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          if (!silent) setError(e instanceof Error ? e.message : t("errors.loadMessages"));
        });
      return () => {
        cancelled = true;
      };
    },
    [trpc, threadId],
  );

  const load = useCallback(() => fetchMessages(false), [fetchMessages]);

  useEffect(() => load(), [load]);

  // Live delivery: a new/edited/deleted message in this thread triggers a silent refetch, and —
  // since the thread is open — marks it read so the inbox badge stays in sync.
  const onRealtime = useCallback(() => {
    fetchMessages(true);
    const mut = trpc.chat.markRead as unknown as { mutate: (i: { threadId: string }) => Promise<unknown> };
    mut.mutate({ threadId }).catch(() => {});
  }, [fetchMessages, trpc, threadId]);
  useThreadRealtime(threadId, token, onRealtime);

  // Keep the list pinned to the newest message as content arrives — but only when the reader is
  // already at the bottom (see stickRef), so live messages don't interrupt reading history.
  useEffect(() => {
    if (messages && messages.length > 0 && listRef.current && stickRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body) {
      setSendError(t("errors.emptyMessage"));
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      await trpc.chat.sendMessage.mutate({ threadId, body });
      setDraft("");
      stickRef.current = true; // sending always snaps you to your new message
      fetchMessages(true); // refetch server-truth (includes the just-sent message)
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : t("errors.send"));
    } finally {
      setSending(false);
    }
  }, [trpc, threadId, draft, fetchMessages]);

  // Share a rich card (venue/plan/person) — same send path, a kind + validated payload snapshot.
  const sendRich = useCallback(
    async (kind: MessageKind, payload: Record<string, unknown>) => {
      setSendError(null);
      const mut = trpc.chat.sendMessage as unknown as {
        mutate: (i: { threadId: string; kind: MessageKind; payload: Record<string, unknown> }) => Promise<unknown>;
      };
      try {
        await mut.mutate({ threadId, kind, payload });
        stickRef.current = true;
        fetchMessages(true);
      } catch (e: unknown) {
        setSendError(e instanceof Error ? e.message : t("errors.share"));
      }
    },
    [trpc, threadId, fetchMessages],
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
      <div
        ref={listRef}
        className={styles.scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className={styles.scrollInner}>
          {messages.length === 0 ? (
            <p style={{ color: "var(--muted)", fontSize: 13, margin: "var(--space-2) 0" }}>
              {t("noMessages")}
            </p>
          ) : (
            buildRenderItems(t, messages, myId).map((it) =>
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
          placeholder={t("composerPlaceholder")}
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
          {sending ? t("sending") : t("send")}
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
function buildRenderItems(t: ReturnType<typeof useTranslations>, messages: ThreadMessage[], myId: string | null): RenderItem[] {
  const items: RenderItem[] = [];
  let lastDay = "";
  let prev: ThreadMessage | null = null;
  for (const m of messages) {
    const d = new Date(m.createdAt);
    const dayKey = Number.isNaN(d.getTime()) ? "" : d.toDateString();
    if (dayKey !== lastDay) {
      items.push({ type: "date", key: `date-${m.id}`, label: dayLabel(t, m.createdAt) });
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
  const t = useTranslations("threadDetail");
  const trpc = useTrpc();
  const name =
    message.senderName?.trim() ||
    (message.senderHandle ? `@${message.senderHandle}` : null) ||
    (mine ? t("you") : t("roamMember"));

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
                aria-label={t("editMessageAria")}
                style={{ width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "var(--ui)", fontSize: 14, lineHeight: 1.45, padding: "8px 12px", borderRadius: 12, border: "1px solid var(--line-2)", background: "#fff", color: "var(--ink)", outline: "none" }}
              />
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <Button variant="pri" size="sm" onClick={() => void saveEdit()} disabled={busy || draft.trim().length === 0}>{busy ? "…" : t("save")}</Button>
                <Button variant="neutral" size="sm" onClick={() => { setEditing(false); setDraft(message.body ?? ""); }} disabled={busy}>{t("cancel")}</Button>
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
                <span className={actions.confirm}>{t("deleteConfirm")}</span>
                <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => void remove()} disabled={busy}>{busy ? "…" : t("yes")}</button>
                <button type="button" className={actions.action} onClick={() => setConfirming(false)} disabled={busy}>{t("no")}</button>
              </div>
            ) : (
              <div className={`${actions.row} ${styles.msgActions}`}>
                {isText ? <button type="button" className={actions.action} onClick={() => setEditing(true)}>{t("edit")}</button> : null}
                <button type="button" className={`${actions.action} ${actions.danger}`} onClick={() => setConfirming(true)}>{t("delete")}</button>
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
function dayLabel(t: ReturnType<typeof useTranslations>, iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (days <= 0) return t("day.today");
  if (days === 1) return t("day.yesterday");
  return d.toLocaleDateString(getFormatLocale(), { weekday: "short", day: "numeric", month: "short" });
}

/** Clock time for a message header, e.g. "14:32". */
function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(getFormatLocale(), { hour: "2-digit", minute: "2-digit" });
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

function ParticipantRow({ participant }: { participant: Participant }) {
  const t = useTranslations("threadDetail");
  const name = participant.displayName?.trim() || participant.handle?.trim() || t("roamMember");
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

function formatWhen(t: ReturnType<typeof useTranslations>, iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const day = 86_400_000;
  if (diffMs < day) return t("when.today");
  if (diffMs < 2 * day) return t("when.yesterday");
  const days = Math.floor(diffMs / day);
  if (days < 7) return t("when.daysAgo", { count: days });
  return new Date(iso).toLocaleDateString(getFormatLocale());
}

function SignedOut() {
  const t = useTranslations("threadDetail");
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>{t("signedOut.title")}</div>
      <p style={{ color: "var(--muted)", marginBottom: "var(--space-4)" }}>{t("signedOut.body")}</p>
      <Link href="/threads" style={{ textDecoration: "none" }}>
        <Pill variant="ghost-crim">← {t("backToChats")}</Pill>
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
  const t = useTranslations("threadDetail");
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>{t("notFound.title")}</div>
      <p style={{ color: "var(--muted)", marginBottom: "var(--space-4)" }}>
        {t("notFound.body")}
      </p>
      <Link href="/threads" style={{ textDecoration: "none" }}>
        <Pill variant="ghost-crim">← {t("backToChats")}</Pill>
      </Link>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  const t = useTranslations("threadDetail");
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>{t("errorTitle")}</div>
      <p style={{ color: "var(--muted)" }}>{message}</p>
    </div>
  );
}
