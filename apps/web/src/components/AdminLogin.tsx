/**
 * AdminLogin — /admin-login: the named front door for a partner organisation's officers.
 *
 * WHY A SEPARATE ROUTE. `/association` already handles a signed-out visitor, but it is not something
 * you can tell someone over the phone, and it reads as a destination rather than an entrance. This
 * route is the address the Association is given: it signs you in and then sends you on.
 *
 * WHAT IT IS NOT. It confers nothing. Authority lives in one place and one place only — a row in
 * `channel_admins` (0156), which no client credential can write and which only an audited Roam HQ
 * action can create. This page reads that appointment through `association.me` and routes on the
 * answer; a visitor who signs in here and is not an officer ends up exactly where they would have
 * without it. There is deliberately no second door.
 *
 * WHAT IT DOES NOT SAY. The refusal never mentions whether the address typed is known, whether it is
 * an officer of some other organisation, or which organisation exists here. "Not an officer" is the
 * whole answer, and it is phrased as an explanation because for most signed-in people it is simply
 * true rather than a failure.
 */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { getSupabaseBrowser } from "../lib/supabase";

/** What `association.me` answers with when the caller holds an appointment. */
interface Me {
  channelId: string;
  channelKey: string | null;
  channelName: string | null;
  role: string;
}

/** undefined = still asking, null = signed in but not an officer. */
type MeState = Me | null | undefined;

export function AdminLogin() {
  const trpc = useTrpc();
  const session = useSession();
  const router = useRouter();
  const [me, setMe] = useState<MeState>(undefined);

  useEffect(() => {
    if (!session) {
      // Signing out returns here rather than leaving a stale "not an officer" on screen.
      setMe(undefined);
      return;
    }
    let cancelled = false;
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    (trpc as any).association.me
      .query()
      .then((r: Me) => {
        if (cancelled) return;
        setMe(r);
        // Replace, not push: the back button should leave the portal, not bounce through the door.
        router.replace("/association");
      })
      // A FORBIDDEN here is the ordinary answer for a signed-in user with no appointment, not an
      // error worth showing as one.
      .catch(() => {
        if (!cancelled) setMe(null);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, session, router]);

  if (!session) {
    return (
      <main style={wrap}>
        <h1 style={h1}>Organisation sign-in</h1>
        <p style={lede}>
          For officers of a partner organisation. Sign in with your own account — the same one you
          would use anywhere on this site.
        </p>
        <AuthPanel
          intro="Sign in to open your organisation's portal."
          emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
          onAuthed={() => {}}
        />
      </main>
    );
  }

  if (me === undefined) {
    return (
      <main style={wrap}>
        <div style={skeleton} aria-hidden />
        <p style={{ ...lede, marginTop: "var(--space-3)" }}>Checking your access…</p>
      </main>
    );
  }

  if (me === null) {
    return (
      <main style={wrap}>
        <h1 style={h1}>You&rsquo;re signed in, but not as an officer</h1>
        <p style={lede}>
          This area is for officers of a partner organisation. If you should have access, ask your
          organisation&rsquo;s contact at Roam to appoint you — it cannot be granted from here.
        </p>
        <p style={{ ...lede, marginTop: "var(--space-3)" }}>
          Signed in with the wrong account?{" "}
          <button
            type="button"
            style={linkBtn}
            onClick={() => {
              void getSupabaseBrowser().auth.signOut();
            }}
          >
            Sign out and try another
          </button>
          .
        </p>
      </main>
    );
  }

  // Appointment confirmed; the replace() above is already in flight. A brief line rather than a
  // flash of nothing.
  return (
    <main style={wrap}>
      <div style={skeleton} aria-hidden />
      <p style={{ ...lede, marginTop: "var(--space-3)" }}>
        Opening {me.channelName ?? "your organisation"}&rsquo;s portal…
      </p>
    </main>
  );
}

const wrap: React.CSSProperties = {
  maxWidth: 520,
  margin: "0 auto",
  padding: "var(--space-5) var(--space-4) var(--space-12)",
};
const h1: React.CSSProperties = {
  fontFamily: "var(--display)",
  fontWeight: 600,
  fontSize: 26,
  letterSpacing: "-.02em",
  margin: 0,
};
const lede: React.CSSProperties = {
  margin: "var(--space-2) 0 var(--space-4)",
  color: "var(--ink-2)",
  fontSize: 14,
  lineHeight: 1.55,
};
const skeleton: React.CSSProperties = {
  height: 120,
  borderRadius: 12,
  background: "var(--paper-2)",
};
const linkBtn: React.CSSProperties = {
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  color: "var(--ink)",
  textDecoration: "underline",
  cursor: "pointer",
};
