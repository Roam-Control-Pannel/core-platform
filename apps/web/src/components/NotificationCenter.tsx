/**
 * NotificationCenter — the /notifications surface. Lists the signed-in user's notifications
 * (wall comments, Town Hall replies, new venue follows — produced by the 0032 triggers),
 * newest first, each linking to its target. Opening the center marks everything read (so the
 * bell badge clears) while still showing this visit's unread items highlighted.
 *
 * Private (protected). Signed out shows the just-in-time sign-in nudge.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { timeAgo } from "../lib/townHall";

interface Notification {
  id: string;
  type: string;
  text: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

const GLYPH: Record<string, string> = {
  wall_comment: "💬",
  townhall_reply: "🏛",
  venue_follow: "✦",
};

export function NotificationCenter() {
  const trpc = useTrpc();
  const session = useSession();
  const [items, setItems] = useState<Notification[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const hasSession = !!session;

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    const list = trpc.notifications.list as unknown as {
      query: (i: { limit: number }) => Promise<{ notifications: Notification[] }>;
    };
    const markAllRead = trpc.notifications.markAllRead as unknown as { mutate: () => Promise<{ ok: true }> };
    list
      .query({ limit: 40 })
      .then((res) => {
        if (cancelled) return;
        setItems(res.notifications ?? []);
        // Clear the badge for next time (this view keeps its loaded read state).
        void markAllRead.mutate().catch(() => {});
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load notifications.");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, hasSession]);

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link
        href="/"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-4)" }}
      >
        <span aria-hidden>←</span> Home
      </Link>
      <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 24, letterSpacing: "-.02em", margin: "0 0 var(--space-4)" }}>
        Notifications
      </h1>

      {!hasSession ? (
        <Card style={{ padding: "var(--space-4)" }}>
          <AuthPanel
            intro="Sign in to see your notifications."
            emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
            onAuthed={() => {}}
          />
        </Card>
      ) : error ? (
        <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>{error}</p>
        </Card>
      ) : items === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <div style={{ height: 56, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
          <div style={{ height: 56, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
        </div>
      ) : items.length === 0 ? (
        <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
          <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5 }}>
            Nothing yet. When people reply to you, comment on your posts, or follow a venue you own, it&apos;ll show up here.
          </p>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          {items.map((n) => (
            <NotificationRow key={n.id} n={n} />
          ))}
        </div>
      )}
    </main>
  );
}

function NotificationRow({ n }: { n: Notification }) {
  const unread = n.readAt == null;
  const body = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "12px 12px",
        borderRadius: "var(--r-md)",
        background: unread ? "var(--crimson-tint)" : "transparent",
      }}
    >
      <span aria-hidden style={{ fontSize: 18, flexShrink: 0 }}>{GLYPH[n.type] ?? "•"}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, color: "var(--ink)", lineHeight: 1.4 }}>{n.text}</div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 1 }}>{timeAgo(n.createdAt)}</div>
      </div>
      {unread ? <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--crimson)", flexShrink: 0 }} /> : null}
    </div>
  );
  return n.href ? (
    <Link href={n.href} style={{ textDecoration: "none", color: "inherit" }}>
      {body}
    </Link>
  ) : (
    body
  );
}

/**
 * NotificationBell — the TopBar badge. Fetches the unread count once for the signed-in user and
 * links to the center. A quiet crimson dot when there's anything unread.
 */
export function NotificationBell() {
  const trpc = useTrpc();
  const session = useSession();
  const [count, setCount] = useState(0);
  const hasSession = !!session;

  const load = useCallback(() => {
    if (!hasSession) return;
    const unreadCount = trpc.notifications.unreadCount as unknown as { query: () => Promise<{ count: number }> };
    unreadCount
      .query()
      .then((r) => setCount(r.count ?? 0))
      .catch(() => {});
  }, [trpc, hasSession]);

  useEffect(() => {
    load();
  }, [load]);

  if (!hasSession) return null;
  return (
    <Link
      href="/notifications"
      aria-label={count > 0 ? `Notifications (${count} unread)` : "Notifications"}
      style={{ position: "relative", display: "inline-grid", placeItems: "center", width: 36, height: 36, borderRadius: 11, background: "var(--paper-2)", color: "var(--ink-2)", textDecoration: "none", fontSize: 16 }}
    >
      <span aria-hidden>🔔</span>
      {count > 0 ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            minWidth: 8,
            height: 8,
            borderRadius: 999,
            background: "var(--crimson)",
          }}
        />
      ) : null}
    </Link>
  );
}
