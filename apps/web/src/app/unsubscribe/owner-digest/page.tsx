/**
 * /unsubscribe/owner-digest — the one-click landing for the owner activity digest email's
 * unsubscribe link. Public (no login): the ?token in the URL is a signed capability the API
 * verifies. On load it calls ownerDigest.unsubscribe and confirms; a bad/expired token shows a
 * gentle failure with a link to manage notifications in-app.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTrpc } from "../../../components/TrpcProvider";

type Status = "working" | "done" | "error";

export default function OwnerDigestUnsubscribePage() {
  const trpc = useTrpc();
  const [status, setStatus] = useState<Status>("working");
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // once per mount — the token doesn't change
    ran.current = true;
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    if (!token) {
      setStatus("error");
      return;
    }
    const call = trpc.ownerDigest.unsubscribe as unknown as {
      mutate: (i: { token: string }) => Promise<{ ok: boolean }>;
    };
    call
      .mutate({ token })
      .then((r) => setStatus(r.ok ? "done" : "error"))
      .catch(() => setStatus("error"));
  }, [trpc]);

  return (
    <main style={{ minHeight: "70vh", display: "grid", placeItems: "center", padding: "var(--space-8) var(--space-4)" }}>
      <div style={{ maxWidth: 440, textAlign: "center" }}>
        {status === "working" ? (
          <p style={{ color: "var(--ink-2)", fontSize: 15 }}>Updating your email preferences…</p>
        ) : status === "done" ? (
          <>
            <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
              You're unsubscribed
            </div>
            <p style={{ color: "var(--ink-2)", lineHeight: 1.5, margin: "0 0 var(--space-5)" }}>
              You won't get the daily business-activity digest any more. You'll still see everything in your
              notifications when you're in Roam.
            </p>
            <Link
              href="/dashboard"
              style={{ display: "inline-block", background: "var(--crimson)", color: "#fff", fontWeight: 600, fontSize: 14, textDecoration: "none", padding: "10px 18px", borderRadius: 999 }}
            >
              Go to your dashboard
            </Link>
          </>
        ) : (
          <>
            <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
              This link didn't work
            </div>
            <p style={{ color: "var(--ink-2)", lineHeight: 1.5, margin: "0 0 var(--space-5)" }}>
              It may have expired or been changed. You can manage notifications any time from your account.
            </p>
            <Link
              href="/account"
              style={{ display: "inline-block", border: "1px solid var(--line)", color: "var(--ink)", fontWeight: 600, fontSize: 14, textDecoration: "none", padding: "10px 18px", borderRadius: 999 }}
            >
              Open your account
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
