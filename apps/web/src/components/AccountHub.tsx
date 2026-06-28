/**
 * AccountHub — the /account home: the signed-in user's hub. Edit your profile, and jump to
 * the other "you" surfaces (Following, your Business dashboard). Signed out shows the same
 * just-in-time AuthPanel as /following.
 *
 * The Business link is always present — the dashboard itself handles the "you own nothing
 * yet, here's how to claim" state, so the hub stays simple and doesn't need its own query.
 */
"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card } from "@roam/design";
import { useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { ProfileEditor } from "./ProfileEditor";
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

      {!userId ? (
        <AuthPanel
          intro="Sign in to set up your profile and manage your account."
          emailRedirectTo={returnUrl()}
          onAuthed={() => {
            /* session change re-renders this hub signed-in */
          }}
        />
      ) : (
        <>
          <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
            <ProfileEditor userId={userId} />
          </Card>

          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <HubLink href={`/u/${userId}`} title="Your wall" hint="Your public profile — post updates and photos, and see likes and comments." />
            <HubLink href="/dashboard" title="Business dashboard" hint="Manage venues you've claimed — details, hours and photos." />
            <HubLink href="/following" title="Following" hint="Venues you follow and their notifications." />
          </div>

          <div style={{ marginTop: "var(--space-6)", textAlign: "center" }}>
            <Button variant="neutral" onClick={() => void signOut()} disabled={signingOut}>
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
          </div>
        </>
      )}
    </main>
  );
}

function HubLink({ href, title, hint }: { href: string; title: string; hint: string }) {
  return (
    <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>
      <Card style={{ padding: "var(--space-4)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
          <div style={{ minWidth: 0 }}>
            <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600 }}>{title}</div>
            <div style={{ marginTop: 2, fontSize: 12.5, color: "var(--ink-2)" }}>{hint}</div>
          </div>
          <span aria-hidden style={{ color: "var(--muted)", fontSize: 18 }}>→</span>
        </div>
      </Card>
    </Link>
  );
}

function returnUrl(): string {
  const origin =
    (typeof window !== "undefined" ? window.location.origin : undefined) ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "http://localhost:3000";
  return `${origin}/account`;
}
