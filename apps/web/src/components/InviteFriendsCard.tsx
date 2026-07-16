/**
 * InviteFriendsCard — the share side of the invite loop, on /friends. Emits the signed-in user's
 * personal invite link (/i/<their handle>) via the shared CopyLinkButton, so sharing it carries the
 * branded "…is inviting you to Roam" preview. Renders nothing until we know the user's handle.
 */
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@roam/design";
import { CopyLinkButton } from "./CopyLinkButton";
import { useTrpc, useSession } from "./TrpcProvider";

export function InviteFriendsCard() {
  const t = useTranslations("invite");
  const trpc = useTrpc();
  const session = useSession();
  const [handle, setHandle] = useState<string | null>(null);

  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    let cancelled = false;
    const q = trpc.profiles.byId as unknown as {
      query: (i: { userId: string }) => Promise<{ handle: string | null } | null>;
    };
    q.query({ userId: uid })
      .then((p) => {
        if (!cancelled) setHandle(p?.handle ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, trpc]);

  if (!session || !handle) return null;

  return (
    <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-5)" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-2)" }}>
        {t("cardTitle")}
      </div>
      <p style={{ margin: "0 0 var(--space-3)", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.45 }}>{t("cardBlurb")}</p>
      <CopyLinkButton path={`/i/${handle}`} label={t("copyCta")} title={t("shareTitle")} text={t("shareText")} variant="button" />
    </Card>
  );
}
