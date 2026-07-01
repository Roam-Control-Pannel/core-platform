/**
 * AuthCallback — the landing surface for an OAuth (SSO) redirect.
 *
 * signInWithOAuth sends the provider back here with the session in the URL (hash, implicit flow).
 * The browser client picks it up (detectSessionInUrl) and fires SIGNED_IN; we wait for that (or a
 * direct getSession fallback) and then forward the user to the `next` destination they were headed
 * for. If the provider returned an error (e.g. the user cancelled, or the provider isn't
 * configured), we show a gentle failure with a way back — never a blank screen.
 *
 * `next` is validated to be SAME-ORIGIN before we redirect, so a crafted `?next=` can't turn this
 * into an open redirect.
 */
"use client";

import { useEffect, useState } from "react";
import { Button, Card } from "@roam/design";
import { getSupabaseBrowser } from "../lib/supabase";

/** Only allow same-origin destinations; anything else falls back to home. */
function safeNext(raw: string | null): string {
  if (!raw) return "/";
  try {
    const u = new URL(raw, window.location.origin);
    if (u.origin === window.location.origin) return u.pathname + u.search + u.hash;
  } catch {
    /* fall through */
  }
  return "/";
}

export function AuthCallback() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowser();

    // Providers report failure via ?error / #error. Detect either and bail early.
    const search = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (search.get("error") || search.get("error_description") || hash.get("error")) {
      setFailed(true);
      return;
    }

    const dest = safeNext(search.get("next"));
    let settled = false;
    const go = () => {
      if (settled) return;
      settled = true;
      // Replace so the callback URL (with its token hash) never sits in history.
      window.location.replace(dest);
    };

    // The session lands asynchronously (detectSessionInUrl). Catch it via the auth event or a
    // direct getSession check shortly after mount, mirroring the reset-password landing.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) go();
    });
    const timer = setTimeout(() => {
      if (settled) return;
      void supabase.auth.getSession().then(({ data }) => {
        if (data.session) go();
        else setFailed(true);
      });
    }, 3000);

    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "var(--space-8) var(--space-4)" }}>
      {failed ? (
        <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)" }}>
          <div
            className="t-h3"
            style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}
          >
            Sign-in didn&apos;t complete
          </div>
          <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
            We couldn&apos;t finish signing you in — you may have cancelled, or the link expired.
            Please try again.
          </p>
          <a href="/account" style={{ textDecoration: "none" }}>
            <Button variant="pri" block>
              Back to sign in
            </Button>
          </a>
        </Card>
      ) : (
        <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)", textAlign: "center" }}>
          <p style={{ color: "var(--ink-2)" }}>Completing sign-in…</p>
        </Card>
      )}
    </main>
  );
}
