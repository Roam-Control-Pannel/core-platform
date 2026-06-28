/**
 * BusinessDashboard — the /dashboard home: the venues this user has CLAIMED, each a link into
 * its owner editor (/dashboard/[venueId]). Protected (myVenues is owner-scoped): signed out
 * shows the just-in-time AuthPanel; the empty state explains how to claim a venue.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";

interface MyVenue {
  id: string;
  name: string;
  status: string;
  category: string | null;
  locality: string | null;
  region: string | null;
}

type MyVenuesQuery = { query: () => Promise<MyVenue[]> };

export function BusinessDashboard() {
  const trpc = useTrpc();
  const session = useSession();
  const [venues, setVenues] = useState<MyVenue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const userId = session?.user?.id ?? null;

  const load = useCallback(() => {
    let cancelled = false;
    setVenues(null);
    setError(null);
    (trpc.venues.myVenues as unknown as MyVenuesQuery)
      .query()
      .then((rows) => {
        if (!cancelled) setVenues(rows ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load your venues.");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  useEffect(() => {
    if (!userId) {
      setVenues(null);
      return;
    }
    return load();
  }, [userId, load]);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-2) 0 var(--space-4)" }}>
        <Link href="/account" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none" }}>
          <span aria-hidden>←</span> Account
        </Link>
        <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, margin: 0, fontSize: 22 }}>
          Business
        </h1>
        <span style={{ width: 1 }} />
      </header>

      {!userId ? (
        <AuthPanel
          intro="Sign in to manage the venues you've claimed."
          emailRedirectTo={returnUrl()}
          onAuthed={() => {}}
        />
      ) : error ? (
        <p role="alert" style={{ color: "var(--crimson-700)" }}>{error}</p>
      ) : venues === null ? (
        <Skeleton />
      ) : venues.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {venues.map((v) => (
            <Link key={v.id} href={`/dashboard/${v.id}`} style={{ textDecoration: "none", color: "inherit" }}>
              <Card style={{ padding: "var(--space-4)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600 }}>{v.name}</div>
                    <div style={{ marginTop: 2, fontSize: 12.5, color: "var(--ink-2)" }}>
                      {[v.category, [v.locality, v.region].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <StatusBadge status={v.status} />
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const claimed = status === "claimed";
  return (
    <span
      style={{
        flexShrink: 0,
        padding: "3px 9px",
        borderRadius: 999,
        fontFamily: "var(--mono)",
        fontSize: 10,
        letterSpacing: ".04em",
        textTransform: "uppercase",
        fontWeight: 700,
        color: claimed ? "var(--crimson-700)" : "var(--muted)",
        background: claimed ? "var(--crimson-tint)" : "var(--paper-2)",
      }}
    >
      {claimed ? "Claimed" : status.replace(/_/g, " ")}
    </span>
  );
}

function Skeleton() {
  return (
    <div style={{ display: "grid", gap: "var(--space-3)" }}>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} style={{ height: 76, borderRadius: 16, border: "1px solid var(--line)", background: "var(--card)" }} />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)", maxWidth: 440, margin: "0 auto" }}>
      <div
        aria-hidden
        style={{ width: 56, height: 56, margin: "0 auto var(--space-4)", borderRadius: "50%", background: "var(--crimson-tint)", display: "grid", placeItems: "center", fontSize: 24, color: "var(--crimson-700)" }}
      >
        ◍
      </div>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        No claimed venues yet
      </div>
      <p style={{ color: "var(--muted)", lineHeight: 1.55 }}>
        Find your business in <Link href="/" style={{ color: "var(--crimson-700)" }}>Explore</Link>, open its page and tap
        “Claim it free”. Once it’s approved it shows up here, ready to edit.
      </p>
    </div>
  );
}

function returnUrl(): string {
  const origin =
    (typeof window !== "undefined" ? window.location.origin : undefined) ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "http://localhost:3000";
  return `${origin}/dashboard`;
}
