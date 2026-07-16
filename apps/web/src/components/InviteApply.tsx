/**
 * InviteApply — the second half of the invite loop, mounted once in the root layout. When a signed-in
 * session appears AND an inviter was stashed (by InviteLanding), it calls social.applyInvite once:
 * that records referral attribution (profiles.invited_by) and sends a friend request to the inviter,
 * so the graph fills itself. Renders a small, dismissible confirmation when it connects.
 *
 * Runs on every page but is a no-op for everyone without a stashed inviter (a single localStorage
 * read). The stash is cleared once applied (or on a definitive no-op) so it never re-fires; a
 * transient failure keeps it for the next load.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useTrpc, useSession } from "./TrpcProvider";
import { readInvitedBy, clearInvitedBy } from "../lib/invite";

export function InviteApply() {
  const t = useTranslations("invite");
  const trpc = useTrpc();
  const session = useSession();
  const [connectedName, setConnectedName] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (!session || attempted.current) return;
    const handle = readInvitedBy();
    if (!handle) return;
    attempted.current = true; // one attempt per load

    const m = trpc.social.applyInvite as unknown as {
      mutate: (i: { inviterHandle: string }) => Promise<{ applied: boolean; inviterName?: string }>;
    };
    m.mutate({ inviterHandle: handle })
      .then((res) => {
        clearInvitedBy(); // resolved either way — don't retry a self/unknown/existing case
        if (res.applied && res.inviterName) setConnectedName(res.inviterName);
      })
      .catch(() => {
        attempted.current = false; // transient — allow a retry on the next load (stash kept)
      });
  }, [session, trpc]);

  const dismiss = useCallback(() => setConnectedName(null), []);
  if (!connectedName) return null;

  return (
    <div style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: "calc(84px + env(safe-area-inset-bottom))", zIndex: 50, width: "min(92vw, 420px)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", padding: "12px 14px", borderRadius: "var(--r-lg)", background: "var(--card)", border: "1px solid var(--line)", boxShadow: "var(--shadow-pop)" }}>
        <span aria-hidden style={{ fontSize: 20 }}>🎉</span>
        <div style={{ flex: 1, minWidth: 0, fontSize: 14, color: "var(--ink)", lineHeight: 1.4 }}>
          {t("connected", { name: connectedName })}
        </div>
        <button type="button" onClick={dismiss} style={{ all: "unset", cursor: "pointer", color: "var(--muted)", fontSize: 13, fontWeight: 600, padding: "6px 8px" }}>
          {t("dismiss")}
        </button>
      </div>
    </div>
  );
}
