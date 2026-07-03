/**
 * useThreadRealtime — live chat delivery for one thread.
 *
 * Subscribes to Postgres changes on chat_messages scoped to a single thread and invokes
 * `onChange` on any insert / update / delete, so the open conversation reflects new, edited and
 * removed messages without a manual refresh. The subscription runs over the browser Supabase
 * client's authenticated socket, and postgres_changes is evaluated under RLS per-subscriber — so
 * a user only ever receives events for threads they participate in (same guarantee as the
 * listMessages query). No-op while signed out (null token) or with no thread.
 *
 * We deliberately signal-then-refetch rather than reconstruct rows from the change payload: the
 * enriched message shape (sender profile, avatar, payload snapshot) comes from listMessages, so a
 * refetch is always server-truth and never drifts from the join.
 */
"use client";

import { useEffect } from "react";
import { getSupabaseBrowser } from "./supabase";

export function useThreadRealtime(
  threadId: string | null,
  token: string | null,
  onChange: () => void,
): void {
  useEffect(() => {
    if (!threadId || !token) return;
    const supabase = getSupabaseBrowser();
    // Authorise the realtime socket with the caller's JWT so RLS can scope the change stream.
    void supabase.realtime.setAuth(token);

    const channel = supabase
      .channel(`thread:${threadId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chat_messages", filter: `thread_id=eq.${threadId}` },
        () => onChange(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [threadId, token, onChange]);
}
