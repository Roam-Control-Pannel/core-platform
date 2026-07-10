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
import { useTranslations } from "next-intl";
import { Card, Button, Icon, type IconName } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { UserSearch, PersonAvatar, personName, type SearchedPerson } from "./UserSearch";
import { getFormatLocale } from "../lib/i18n/runtime";

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

export function ThreadList({ activeThreadId = null }: { activeThreadId?: string | null }) {
  const t = useTranslations("threadList");
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
        if (!cancelled) setError(e instanceof Error ? e.message : t("errors.load"));
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
        setCreateError(t("errors.groupName"));
        setCreating(false);
        return;
      }
      const grp = trpc.chat.createGroupThread as unknown as {
        mutate: (i: { title: string; memberIds: string[] }) => Promise<{ id: string }>;
      };
      const { id } = await grp.mutate({ title, memberIds: selected.map((p) => p.id) });
      router.push(`/threads/${id}`);
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : t("errors.start"));
      setCreating(false);
    }
  }, [trpc, selected, groupTitle, router]);

  return (
    <div>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-3)",
          padding: "var(--space-1) var(--space-1) var(--space-4)",
        }}
      >
        <h1
          className="t-h2"
          style={{ fontFamily: "var(--display)", fontWeight: 600, margin: 0, fontSize: 22 }}
        >
          {t("title")}
        </h1>
        {session ? (
          <Button variant="pri" size="sm" onClick={() => (showCreate ? resetCreate() : setShowCreate(true))}>
            {showCreate ? t("cancel") : t("new")}
          </Button>
        ) : null}
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
                  <button type="button" aria-label={t("removePerson", { name: personName(p) })} onClick={() => toggle(p)} style={{ all: "unset", cursor: "pointer", color: "var(--crimson-700)", fontSize: 14, lineHeight: 1, padding: "0 2px" }}>×</button>
                </span>
              ))}
            </div>
          ) : null}

          <UserSearch
            friendsFirst
            autoFocus
            selectedIds={selected.map((p) => p.id)}
            onRowClick={toggle}
          />

          {/* 2+ people → it's a group, which needs a name. */}
          {selected.length >= 2 ? (
            <input
              value={groupTitle}
              onChange={(e) => setGroupTitle(e.target.value)}
              placeholder={t("groupNamePlaceholder")}
              aria-label={t("groupNameAria")}
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
                  ? t("starting")
                  : selected.length === 1
                    ? t("messagePerson", { name: personName(selected[0]!) })
                    : t("createGroup", { count: selected.length })}
              </Button>
            </div>
          ) : (
            <p style={{ color: "var(--muted)", fontSize: 12.5, margin: "var(--space-3) 2px 0", lineHeight: 1.5 }}>
              {t("pickHint")}
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
        <div>
          {threads.map((t, i) => (
            <ThreadRowCard
              key={t.id}
              thread={t}
              myId={session.user?.id ?? null}
              active={t.id === activeThreadId}
              first={i === 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_META: Record<ThreadKind, { labelKey: string; icon: IconName; fallbackKey: string }> = {
  plan: { labelKey: "kindLabel.plan", icon: "plan", fallbackKey: "fallback.plan" },
  group: { labelKey: "kindLabel.group", icon: "users", fallbackKey: "fallback.group" },
  direct: { labelKey: "kindLabel.direct", icon: "chat", fallbackKey: "fallback.direct" },
};

/** Icon for a last-message preview by kind (null = a plain text message, no icon). */
function previewIcon(kind: string): IconName | null {
  switch (kind) {
    case "venue_card": return "place";
    case "plan_card": return "plan";
    case "profile_card": return "person";
    case "image": return "photo";
    case "poll": return "poll";
    default: return null;
  }
}

/** The inbox preview line for a thread's last message ("You: …", or a label for a shared card). */
function previewText(t: ReturnType<typeof useTranslations>, last: LastMessage | null, myId: string | null): string {
  if (!last) return t("preview.noMessages");
  const mine = !!last.senderId && last.senderId === myId;
  let text: string;
  switch (last.kind) {
    case "text":
      text = last.body?.trim() || t("preview.message");
      break;
    case "venue_card":
      text = t("preview.sharedPlace");
      break;
    case "plan_card":
      text = t("preview.sharedPlan");
      break;
    case "profile_card":
      text = t("preview.sharedContact");
      break;
    case "image":
      text = t("preview.photo");
      break;
    case "poll":
      text = t("preview.poll");
      break;
    default:
      text = t("preview.message");
  }
  return mine ? t("preview.you", { text }) : text;
}

/** One conversation row (hi-fi mockup): avatar · name + snippet · time, tinted when open. */
function ThreadRowCard({ thread, myId, active, first }: { thread: ThreadRow; myId: string | null; active: boolean; first: boolean }) {
  const t = useTranslations("threadList");
  const meta = KIND_META[thread.kind];
  const name = thread.name?.trim() || thread.title?.trim() || t(meta.fallbackKey);
  const unread = thread.unreadCount > 0;
  const when = formatWhen(t, thread.lastMessage?.createdAt ?? thread.updatedAt);
  return (
    <Link
      href={`/threads/${thread.id}`}
      aria-current={active ? "page" : undefined}
      style={{
        textDecoration: "none",
        color: "inherit",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 12px",
        borderRadius: 14,
        background: active ? "var(--crimson-tint)" : "transparent",
        borderTop: first ? "none" : "1px solid var(--line)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 42,
          height: 42,
          borderRadius: "50%",
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          background: thread.kind === "plan" ? "var(--crimson-tint-2)" : "var(--paper-2)",
          color: thread.kind === "plan" ? "var(--crimson-700)" : "var(--ink-2)",
          fontSize: 16,
          fontWeight: 700,
        }}
      >
        {thread.kind === "plan" ? <Icon name="plan" size={18} /> : name.charAt(0).toUpperCase() || "·"}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15, color: "var(--ink-hi)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {name}
          </span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--muted)", whiteSpace: "nowrap", flexShrink: 0 }}>{when}</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, marginTop: 2 }}>
          {thread.lastMessage && previewIcon(thread.lastMessage.kind) ? (
            <Icon name={previewIcon(thread.lastMessage.kind) as IconName} size={13} style={{ flexShrink: 0, color: active ? "var(--crimson-700)" : unread ? "var(--ink)" : "var(--muted)" }} />
          ) : null}
          <span
            style={{
              fontSize: 13,
              color: active ? "var(--crimson-700)" : unread ? "var(--ink)" : "var(--muted)",
              fontWeight: unread || active ? 600 : 400,
              fontFamily: "var(--ui)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
          >
            {previewText(t, thread.lastMessage, myId)}
          </span>
          {unread ? (
            <span aria-label={t("unreadAria", { count: thread.unreadCount })} style={{ minWidth: 19, height: 19, padding: "0 6px", borderRadius: 999, background: "var(--crimson)", color: "#fff", fontFamily: "var(--ui)", fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {thread.unreadCount > 99 ? "99+" : thread.unreadCount}
            </span>
          ) : null}
        </span>
      </span>
    </Link>
  );
}

/** Compact relative-ish date — same helper shape as FeedList. */
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
  const t = useTranslations("threadList");
  return (
    <AuthPanel
      intro={t("signedOutIntro")}
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
  const t = useTranslations("threadList");
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
          color: "var(--crimson-700)",
        }}
      >
        <Icon name="chat" size={26} />
      </div>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        {t("empty.title")}
      </div>
      <p style={{ color: "var(--muted)", lineHeight: 1.55 }}>
        {t("empty.body")}
      </p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  const t = useTranslations("threadList");
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        {t("errorTitle")}
      </div>
      <p style={{ color: "var(--muted)" }}>{message}</p>
    </div>
  );
}
