/**
 * /f2g/claim — the invite→claim landing page (B3-d).
 *
 * A roster member gets an emailed capability link (…/f2g/claim?token=…). The token names the
 * (member, venue) pair and a signed expiry; clicking it here, WHILE SIGNED IN, confers ownership of
 * the matched venue via f2g.claimWithInvite (which verifies the HMAC and calls the SECURITY DEFINER
 * conferral server-side). The OWNER is always the signed-in user — never anything the token names —
 * so a signed-out visitor is asked to sign in first (the magic-link returns them right back here with
 * the token intact), and the claim runs once a session exists.
 *
 * Outcomes are rendered, not thrown: claimed / already-claimed / already-claimed-by-someone-else /
 * expired-link / couldn't-complete each get their own gentle state.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTrpc, useSession } from "../../../components/TrpcProvider";
import { AuthModal } from "../../../components/AuthModal";

type State =
  | "no-token"
  | "need-signin"
  | "working"
  | "claimed"
  | "already-claimed"
  | "conflict"
  | "expired"
  | "error";

type ClaimResponse = { outcome: string; venueId: string | null };

export default function F2gClaimPage() {
  const trpc = useTrpc();
  const session = useSession();
  const [state, setState] = useState<State>("working");
  const [authOpen, setAuthOpen] = useState(false);
  const token = useRef<string>("");
  const attempted = useRef(false);

  // Read the token once on mount — it never changes for a given link.
  useEffect(() => {
    token.current = new URLSearchParams(window.location.search).get("token") ?? "";
    if (!token.current) setState("no-token");
  }, []);

  const runClaim = useCallback(() => {
    if (attempted.current || !token.current) return;
    attempted.current = true;
    setState("working");
    const call = trpc.f2g.claimWithInvite as unknown as {
      mutate: (i: { token: string }) => Promise<ClaimResponse>;
    };
    call
      .mutate({ token: token.current })
      .then((r) => {
        if (r.outcome === "claimed") setState("claimed");
        else if (r.outcome === "already_claimed") setState("already-claimed");
        else setState("error"); // venue_mismatch / not_claimable / not_found
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : "";
        if (/already been claimed by someone else/i.test(msg)) setState("conflict");
        else if (/invalid or has expired/i.test(msg)) setState("expired");
        else setState("error");
      });
  }, [trpc]);

  // Drive the flow off (token, session): no token → error; signed out → ask to sign in; signed in →
  // claim (once). A magic-link sign-in returns here and this effect re-fires with a live session.
  useEffect(() => {
    if (!token.current) return; // the mount effect already set no-token
    if (!session) {
      setState("need-signin");
      setAuthOpen(true);
      return;
    }
    runClaim();
  }, [session, runClaim]);

  const wrap = { minHeight: "70vh", display: "grid", placeItems: "center", padding: "var(--space-8) var(--space-4)" } as const;
  const h2 = { fontFamily: "var(--display)", marginBottom: "var(--space-2)" } as const;
  const body = { color: "var(--ink-2)", lineHeight: 1.5, margin: "0 0 var(--space-5)" } as const;
  const primaryBtn = { display: "inline-block", background: "var(--crimson)", color: "#fff", fontWeight: 600, fontSize: 14, textDecoration: "none", padding: "10px 18px", borderRadius: 999 } as const;
  const ghostBtn = { display: "inline-block", border: "1px solid var(--line)", color: "var(--ink)", fontWeight: 600, fontSize: 14, textDecoration: "none", padding: "10px 18px", borderRadius: 999 } as const;

  return (
    <main style={wrap}>
      <div style={{ maxWidth: 460, textAlign: "center" }}>
        {state === "working" && (
          <p style={{ color: "var(--ink-2)", fontSize: 15 }}>Claiming your listing…</p>
        )}

        {state === "need-signin" && (
          <>
            <div className="t-h2" style={h2}>Sign in to claim your listing</div>
            <p style={body}>
              Your listing is waiting. Sign in (or create an account) with this email and we'll finish
              claiming it for you.
            </p>
            <button style={{ ...primaryBtn, border: "none", cursor: "pointer" }} onClick={() => setAuthOpen(true)}>
              Sign in to continue
            </button>
          </>
        )}

        {state === "claimed" && (
          <>
            <div className="t-h2" style={h2}>Your listing is claimed 🎉</div>
            <p style={body}>
              You're now the owner. Head to your dashboard to add your menu, set collection or delivery,
              and go live.
            </p>
            <Link href="/dashboard" style={primaryBtn}>Go to your dashboard</Link>
          </>
        )}

        {state === "already-claimed" && (
          <>
            <div className="t-h2" style={h2}>You've already claimed this</div>
            <p style={body}>This listing is already yours. Manage it any time from your dashboard.</p>
            <Link href="/dashboard" style={primaryBtn}>Go to your dashboard</Link>
          </>
        )}

        {state === "conflict" && (
          <>
            <div className="t-h2" style={h2}>This listing is already claimed</div>
            <p style={body}>
              Someone else has already claimed this business. If you think that's a mistake, get in touch
              and we'll help sort it out.
            </p>
            <Link href="/dashboard" style={ghostBtn}>Go to your dashboard</Link>
          </>
        )}

        {state === "expired" && (
          <>
            <div className="t-h2" style={h2}>This invite link has expired</div>
            <p style={body}>
              For security, claim links expire after a while. Ask for a fresh invite and we'll send a new
              link to your email.
            </p>
            <Link href="/" style={ghostBtn}>Back to home</Link>
          </>
        )}

        {(state === "error" || state === "no-token") && (
          <>
            <div className="t-h2" style={h2}>We couldn't complete this</div>
            <p style={body}>
              This claim link didn't work. It may be incomplete or already used. Ask for a fresh invite
              and try again.
            </p>
            <Link href="/" style={ghostBtn}>Back to home</Link>
          </>
        )}
      </div>

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        // Return the visitor to this exact page (token intact) after a magic-link sign-in, so the
        // claim runs automatically on their way back.
        emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
        intro="Sign in to claim your Food to Go listing."
      />
    </main>
  );
}
