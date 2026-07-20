/**
 * AccountHub — the /account "You" surface. Signed in, it LEADS WITH YOUR OWN WALL: the
 * ProfileWall rendered in `editable` mode, so your profile (avatar, header, name, handle, bio,
 * links) edits inline via its "Edit profile" toggle, and your posts compose right there. The
 * other "you" surfaces (Business dashboard — for owners —, Settings, Notifications, Orders) ride
 * along in the wall header's "…" overflow menu; Sign out sits in the slim top bar.
 *
 * Signed out shows the same just-in-time AuthPanel as before.
 */
"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@roam/design";
import { useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { ProfileWall } from "./ProfileWall";
import { getSupabaseBrowser } from "../lib/supabase";

export function AccountHub() {
  const t = useTranslations("accountHub");
  const session = useSession();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await getSupabaseBrowser().auth.signOut();
      router.push("/");
    } finally {
      setSigningOut(false);
    }
  }, [router]);

  const userId = session?.user?.id ?? null;

  if (!userId) {
    return (
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "var(--space-2) 0 var(--space-4)",
          }}
        >
          <Link
            href="/explore"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none" }}
          >
            <span aria-hidden>←</span> {t("explore")}
          </Link>
          <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, margin: 0, fontSize: 22 }}>
            {t("title")}
          </h1>
          <span style={{ width: 1 }} />
        </header>

        <AuthPanel
          intro={t("signedOutIntro")}
          emailRedirectTo={returnUrl()}
          onAuthed={() => {
            /* session change re-renders this hub signed-in */
          }}
        />
      </main>
    );
  }

  // The secondary "you" surfaces (Business dashboard, Settings, Notifications, Orders) live in the
  // ProfileWall header's "…" overflow menu — no extra nav here.
  return (
    <>
      <div
        style={{
          maxWidth: 680,
          margin: "0 auto",
          padding: "var(--space-3) var(--space-4)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Link
          href="/explore"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none" }}
        >
          <span aria-hidden>←</span> {t("explore")}
        </Link>
        <Button variant="neutral" size="sm" onClick={() => void signOut()} disabled={signingOut}>
          {signingOut ? t("signingOut") : t("signOut")}
        </Button>
      </div>

      <ProfileWall userId={userId} editable />
    </>
  );
}

function returnUrl(): string {
  const origin =
    (typeof window !== "undefined" ? window.location.origin : undefined) ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "http://localhost:3000";
  return `${origin}/account`;
}
