/**
 * AddFriendButton — the friend affordance on another user's wall (/u/[id]). Reads the caller's
 * relationship (social.friendshipStatus) and renders the right control: Add friend / Requested /
 * Accept / Friends. Hidden when signed out or on your own wall (the caller gates that).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";

type Status = "none" | "pending_out" | "pending_in" | "friends" | "loading";

export function AddFriendButton({ userId }: { userId: string }) {
  const t = useTranslations("addFriendButton");
  const trpc = useTrpc();
  const session = useSession();
  const [status, setStatus] = useState<Status>("loading");
  const [busy, setBusy] = useState(false);
  const hasSession = !!session;

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    const q = trpc.social.friendshipStatus as unknown as {
      query: (i: { otherId: string }) => Promise<{ status: Exclude<Status, "loading"> }>;
    };
    q.query({ otherId: userId })
      .then((r) => {
        if (!cancelled) setStatus(r.status);
      })
      .catch(() => {
        if (!cancelled) setStatus("none");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, userId, hasSession]);

  const request = useCallback(async () => {
    setBusy(true);
    const m = trpc.social.requestFriend as unknown as { mutate: (i: { addresseeId: string }) => Promise<{ ok: boolean }> };
    try {
      await m.mutate({ addresseeId: userId });
      setStatus("pending_out");
    } catch {
      /* no-op */
    } finally {
      setBusy(false);
    }
  }, [trpc, userId]);

  const accept = useCallback(async () => {
    setBusy(true);
    const m = trpc.social.respondToFriend as unknown as { mutate: (i: { requesterId: string; accept: boolean }) => Promise<{ ok: boolean }> };
    try {
      await m.mutate({ requesterId: userId, accept: true });
      setStatus("friends");
    } catch {
      /* no-op */
    } finally {
      setBusy(false);
    }
  }, [trpc, userId]);

  if (!hasSession || status === "loading") return null;

  if (status === "friends") {
    return (
      <Button variant="neutral" size="sm" aria-disabled style={{ cursor: "default" }} onClick={(e) => e.preventDefault()}>
        {t("friends")}
      </Button>
    );
  }
  if (status === "pending_out") {
    return (
      <Button variant="neutral" size="sm" aria-disabled style={{ cursor: "default", opacity: 0.7 }} onClick={(e) => e.preventDefault()}>
        {t("requested")}
      </Button>
    );
  }
  if (status === "pending_in") {
    return (
      <Button variant="pri" size="sm" onClick={() => void accept()} disabled={busy}>
        {busy ? "…" : t("acceptRequest")}
      </Button>
    );
  }
  return (
    <Button variant="neutral" size="sm" onClick={() => void request()} disabled={busy}>
      {busy ? "…" : t("addFriend")}
    </Button>
  );
}
