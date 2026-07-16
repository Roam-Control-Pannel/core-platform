/**
 * InviteLanding — the /i/[handle] page body. Names the inviter, sells Roam in a line, and signs the
 * visitor up inline. Stashes the inviter's handle in localStorage on mount so InviteApply (in the
 * layout) can connect the two once a session exists — surviving the email-confirm / OAuth round-trip
 * on the same device (the common case; a cross-device email confirm is a best-effort miss).
 *
 * Already signed in? Then there's nothing to sign up for — we still stash the inviter (InviteApply
 * will connect them) and point them at Friends.
 */
"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card, Button } from "@roam/design";
import { AuthPanel } from "./AuthPanel";
import { useSession } from "./TrpcProvider";
import { INVITED_BY_KEY } from "../lib/invite";

export function InviteLanding({
  handle,
  inviterName,
  avatarUrl,
  known,
}: {
  handle: string;
  inviterName: string | null;
  avatarUrl: string | null;
  known: boolean;
}) {
  const t = useTranslations("invite");
  const session = useSession();
  const router = useRouter();
  const name = inviterName ?? t("aFriend");

  // Stash the inviter as early as possible, before any auth navigation.
  useEffect(() => {
    if (!known) return;
    try {
      localStorage.setItem(INVITED_BY_KEY, handle);
    } catch {
      /* private mode — best effort */
    }
  }, [handle, known]);

  const initial = name.replace(/^@/, "").charAt(0).toUpperCase() || "·";

  return (
    <main style={{ maxWidth: 460, margin: "0 auto", padding: "var(--space-6) var(--space-4) var(--space-12)" }}>
      <div style={{ textAlign: "center", marginBottom: "var(--space-5)" }}>
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
          <img src={avatarUrl} alt="" style={{ width: 72, height: 72, borderRadius: "50%", objectFit: "cover", margin: "0 auto var(--space-3)" }} />
        ) : (
          <span aria-hidden style={{ width: 72, height: 72, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 30, margin: "0 auto var(--space-3)" }}>
            {initial}
          </span>
        )}
        <h1 style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 23, letterSpacing: "-.02em", margin: "0 0 6px", lineHeight: 1.25 }}>
          {known ? t("titleNamed", { name }) : t("titleGeneric")}
        </h1>
        <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 14.5, lineHeight: 1.5 }}>{t("blurb")}</p>
      </div>

      {session ? (
        <Card style={{ padding: "var(--space-4)", textAlign: "center" }}>
          <p style={{ margin: "0 0 var(--space-3)", fontSize: 14, color: "var(--ink)" }}>{t("alreadyIn")}</p>
          <Button variant="pri" size="md" onClick={() => router.push("/friends")}>
            {t("goToFriends")}
          </Button>
        </Card>
      ) : (
        <Card style={{ padding: "var(--space-4)" }}>
          <AuthPanel
            intro={t("authIntro")}
            emailRedirectTo={typeof window !== "undefined" ? `${window.location.origin}/friends` : "/friends"}
            onAuthed={() => router.push("/friends")}
          />
        </Card>
      )}

      <p style={{ textAlign: "center", marginTop: "var(--space-5)" }}>
        <Link href="/" style={{ fontSize: 13, color: "var(--muted)", textDecoration: "none" }}>
          {t("justBrowse")}
        </Link>
      </p>
    </main>
  );
}
