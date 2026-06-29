/**
 * AccountHub — the /account "You" surface. Signed in, it LEADS WITH YOUR OWN WALL: the
 * ProfileWall rendered in `editable` mode, so your profile (avatar, header, name, handle, bio,
 * links) edits inline via its "Edit profile" toggle, and your posts compose right there. The
 * other "you" surfaces (Following, Business dashboard) and Sign out ride along as secondary
 * controls in the wall header + a slim top bar.
 *
 * Signed out shows the same just-in-time AuthPanel as before.
 */
"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Pill } from "@roam/design";
import { useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { ProfileWall } from "./ProfileWall";
import { getSupabaseBrowser } from "../lib/supabase";

export function AccountHub() {
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
            <span aria-hidden>←</span> Explore
          </Link>
          <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, margin: 0, fontSize: 22 }}>
            Your account
          </h1>
          <span style={{ width: 1 }} />
        </header>

        <AuthPanel
          intro="Sign in to set up your profile and post to your wall."
          emailRedirectTo={returnUrl()}
          onAuthed={() => {
            /* session change re-renders this hub signed-in */
          }}
        />
      </main>
    );
  }

  // The secondary "you" surfaces, surfaced beneath the profile header on your own wall.
  const ownerNav = (
    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
      <Link href="/notifications" style={{ textDecoration: "none" }}>
        <Pill variant="neutral">Notifications</Pill>
      </Link>
      <Link href="/friends" style={{ textDecoration: "none" }}>
        <Pill variant="neutral">Friends</Pill>
      </Link>
      <Link href="/plans" style={{ textDecoration: "none" }}>
        <Pill variant="neutral">Plans</Pill>
      </Link>
      <Link href="/following" style={{ textDecoration: "none" }}>
        <Pill variant="neutral">Following</Pill>
      </Link>
      <Link href="/dashboard" style={{ textDecoration: "none" }}>
        <Pill variant="neutral">Business dashboard</Pill>
      </Link>
    </div>
  );

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
          <span aria-hidden>←</span> Explore
        </Link>
        <Button variant="neutral" size="sm" onClick={() => void signOut()} disabled={signingOut}>
          {signingOut ? "Signing out…" : "Sign out"}
        </Button>
      </div>

      <ProfileWall userId={userId} editable ownerNav={ownerNav} />
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
