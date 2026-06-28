/**
 * BusinessLanding — /business, the public "business door".
 *
 * Roam has ONE kind of account (a person). "Business owner" isn't a separate account type —
 * it's a capability a person unlocks by CLAIMING + VERIFYING a venue. This page is the
 * intent-driven entry into that journey: it explains the offer (your venue is probably
 * already on Roam from public sources; claiming lets you keep it accurate) and routes into
 * the existing flow — find your venue → "Claim it free" → verify → manage in /dashboard.
 *
 * No new account model: signed-out visitors sign in with the same auth when they claim; the
 * claim/approve flow is the real trust boundary. (Teams / multi-owner "organizations" are a
 * later layer on top of this — deliberately not forked here.)
 */
"use client";

import Link from "next/link";
import { Button, Card } from "@roam/design";
import { useSession } from "./TrpcProvider";

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: "1",
    title: "Find your venue",
    body: "It's probably already on Roam, listed from public sources. Search for it in Explore and open its page.",
  },
  {
    n: "2",
    title: "Claim it free",
    body: "Tap “Claim it free” on the venue. Sign in (or create an account) — the same account you'd use to explore.",
  },
  {
    n: "3",
    title: "Verify & manage",
    body: "We auto-verify when your email matches the business's website; otherwise a quick manual check. Then add photos, hours, a description and links.",
  },
];

const PERKS = [
  "Add and reorder real photos, set your cover image",
  "Keep your opening hours accurate (live “open now”)",
  "Write your description and add your links",
  "Followers get notified when you post (coming soon)",
];

export function BusinessLanding() {
  const session = useSession();
  const signedIn = !!session?.user?.id;

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ padding: "var(--space-2) 0 var(--space-4)" }}>
        <Link href="/explore" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none" }}>
          <span aria-hidden>←</span> Explore
        </Link>
      </header>

      {/* Hero */}
      <section style={{ textAlign: "center", padding: "var(--space-6) 0 var(--space-8)" }}>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--crimson-700)",
          }}
        >
          For businesses
        </span>
        <h1
          className="t-h1"
          style={{ fontFamily: "var(--display)", fontWeight: 700, margin: "var(--space-2) 0 var(--space-3)", fontSize: 34, lineHeight: 1.1 }}
        >
          Run a local business? Claim it on Roam.
        </h1>
        <p style={{ maxWidth: 520, margin: "0 auto", color: "var(--ink-2)", lineHeight: 1.6, fontSize: 16 }}>
          People discover local places on Roam for free. Claiming your venue lets you keep it
          accurate — your photos, hours, description and links — and own how you show up.
        </p>

        <div style={{ display: "flex", gap: "var(--space-3)", justifyContent: "center", flexWrap: "wrap", marginTop: "var(--space-5)" }}>
          <Link href="/explore" style={{ textDecoration: "none" }}>
            <Button variant="pri">Find your business</Button>
          </Link>
          <Link href="/dashboard" style={{ textDecoration: "none" }}>
            <Button variant="neutral">{signedIn ? "Your dashboard" : "Already claimed? Sign in"}</Button>
          </Link>
        </div>
      </section>

      {/* How it works */}
      <section style={{ marginTop: "var(--space-4)" }}>
        <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-3)" }}>
          How it works
        </h2>
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {STEPS.map((s) => (
            <Card key={s.n} style={{ padding: "var(--space-4)" }}>
              <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}>
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 30,
                    height: 30,
                    borderRadius: "50%",
                    background: "var(--crimson-tint)",
                    color: "var(--crimson-700)",
                    display: "grid",
                    placeItems: "center",
                    fontFamily: "var(--mono)",
                    fontWeight: 700,
                    fontSize: 13,
                  }}
                >
                  {s.n}
                </span>
                <div>
                  <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600 }}>{s.title}</div>
                  <div style={{ marginTop: 2, color: "var(--ink-2)", lineHeight: 1.55, fontSize: 14 }}>{s.body}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* What you can do */}
      <section style={{ marginTop: "var(--space-6)" }}>
        <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-3)" }}>
          Once you've claimed
        </h2>
        <Card style={{ padding: "var(--space-4)" }}>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: "var(--space-2)" }}>
            {PERKS.map((p) => (
              <li key={p} style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-start", color: "var(--ink-2)", lineHeight: 1.5 }}>
                <span aria-hidden style={{ color: "var(--crimson-700)", fontWeight: 700 }}>✓</span>
                {p}
              </li>
            ))}
          </ul>
        </Card>
        <p style={{ marginTop: "var(--space-3)", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
          Roam lists venues from public sources so locals can find you whether or not you've
          claimed — claiming is free and just hands you the keys to your page.
        </p>
      </section>

      <div style={{ textAlign: "center", marginTop: "var(--space-8)" }}>
        <Link href="/explore" style={{ textDecoration: "none" }}>
          <Button variant="pri">Find your business</Button>
        </Link>
      </div>
    </main>
  );
}
