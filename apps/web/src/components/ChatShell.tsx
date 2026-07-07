/**
 * ChatShell — the chat surface's two-pane frame (hi-fi mockup): the Chats list docked left,
 * the conversation right, one continuous card. Both /threads (mode="list") and /threads/[id]
 * (mode="detail") render through it; on desktop both panes always show, on mobile only the
 * pane the route is about. The list marks the open thread (activeThreadId) with the tint row.
 */
"use client";

import { ThreadList } from "./ThreadList";
import styles from "./ChatShell.module.css";

export function ChatShell({
  mode,
  activeThreadId = null,
  children,
}: {
  mode: "list" | "detail";
  activeThreadId?: string | null;
  children: React.ReactNode;
}) {
  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-10)" }}>
      <div className={`${styles.shell} ${mode === "detail" ? styles.detailMode : styles.listMode}`}>
        <div className={styles.listPane}>
          <ThreadList activeThreadId={activeThreadId} />
        </div>
        <div className={styles.detailPane}>{children}</div>
      </div>
    </main>
  );
}

/** The desktop placeholder for /threads before a chat is picked. */
export function EmptyThreadPane() {
  return (
    <div style={{ flex: 1, display: "grid", placeItems: "center", minHeight: 320 }}>
      <div style={{ textAlign: "center", maxWidth: 320 }}>
        <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 18, color: "var(--ink-2)", marginBottom: 6 }}>
          Pick a conversation
        </div>
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>
          Choose a chat from the left, or start a new one.
        </p>
      </div>
    </div>
  );
}
