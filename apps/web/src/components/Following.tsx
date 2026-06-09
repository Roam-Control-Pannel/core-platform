/**
 * Following — the /following home. Venues the caller follows, newest first, each with
 * a per-venue push toggle and an unfollow control. Surfaces the Stage 3b follow edge +
 * push preference to users.
 *
 * Following is PRIVATE (your follows are yours), so this gates on useSession() like
 * ThreadList: signed out shows the just-in-time auth prompt (the claim-flow pattern);
 * signed in shows the list. Ships every state (States matrix): content-shaped skeleton
 * while loading, an honest first-run empty state, and an error state.
 *
 * Data comes from social.myFollows, which returns each follow's venue_id, push_enabled,
 * and an embedded venue (id, name, category). The push toggle calls setVenuePushEnabled
 * optimistically; unfollow reuses FollowButton (initialFollowing) — removing a row from
 * the list on success would need a refetch, so we keep the row and let the button show
 * "Follow" after unfollow (re-follow is one tap; no surprise disappearance mid-interaction).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Seg } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { FollowButton } from "./FollowButton";

/** A row from myFollows: the follow's push pref + the embedded venue it points at. */
interface FollowRow {
  venueId: string;
  pushEnabled: boolean;
  venue: { id: string; name: string; category: string | null } | null;
}

export function Following() {
  const trpc = useTrpc();
  const session = useSession();
  const [rows, setRows] = useState<FollowRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    // myFollows returns an embedded `venues` relation; the inferred type is deep, so we
    // widen the call to the shape we read (same documented idiom as venues.byId).
    const myFollows = trpc.social.myFollows as unknown as {
      query: () => Promise<{
        ok: boolean;
        error?: string;
        follows?: {
          venue_id: string;
          push_enabled: boolean;
          venues: { id: string; name: string; category: string | null } | null;
        }[];
      }>;
    };
    myFollows
      .query()
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error ?? "Failed to load your follows.");
          return;
        }
        setRows(
          (res.follows ?? []).map((f) => ({
            venueId: f.venue_id,
            pushEnabled: f.push_enabled,
            venue: f.venues,
          })),
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load your follows.");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  // Only load when signed in (the query is protected; an anon call would 401).
  useEffect(() => {
    if (!session) {
      setRows(null);
      return;
    }
    return load();
  }, [session, load]);

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
          href="/"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--muted)",
            textDecoration: "none",
          }}
        >
          <span aria-hidden>←</span> Explore
        </Link>
        <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, margin: 0, fontSize: 22 }}>
          Following
        </h1>
        <span style={{ width: 1 }} />
      </header>

      {!session ? (
        <SignedOut />
      ) : error ? (
        <ErrorState message={error} />
      ) : rows === null ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {rows.map((r) => (
            <FollowRowCard key={r.venueId} row={r} />
          ))}
        </div>
      )}
    </main>
  );
}

function FollowRowCard({ row }: { row: FollowRow }) {
  const trpc = useTrpc();
  const name = row.venue?.name ?? "Unknown venue";
  const [pushEnabled, setPushEnabled] = useState(row.pushEnabled);
  const [busy, setBusy] = useState(false);

  // Flip the per-venue push pref optimistically, reverting on failure.
  const setPush = useCallback(
    async (next: boolean) => {
      setPushEnabled(next);
      setBusy(true);
      try {
        await trpc.social.setVenuePushEnabled.mutate({ venueId: row.venueId, enabled: next });
      } catch {
        setPushEnabled(!next); // revert
      } finally {
        setBusy(false);
      }
    },
    [trpc, row.venueId],
  );

  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
        <Link
          href={`/venue/${row.venueId}`}
          style={{ textDecoration: "none", color: "inherit", flex: 1, minWidth: 0 }}
        >
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600 }}>
            {name}
          </div>
          {row.venue?.category ? (
            <div style={{ marginTop: 2, fontSize: 12.5, color: "var(--ink-2)" }}>{row.venue.category}</div>
          ) : null}
        </Link>
        <FollowButton
          venueId={row.venueId}
          initialFollowing
          emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
        />
      </div>

      <div
        style={{
          marginTop: "var(--space-3)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-3)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            color: "var(--muted)",
          }}
        >
          Push when it posts
        </span>
        <div style={{ opacity: busy ? 0.7 : 1 }}>
          <Seg
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            value={pushEnabled ? "on" : "off"}
            onChange={(v) => void setPush(v === "on")}
          />
        </div>
      </div>
    </Card>
  );
}

function SignedOut() {
  return (
    <AuthPanel
      intro="Your follows are private. Sign in to see the venues you follow and manage their notifications."
      emailRedirectTo={signedOutReturnUrl()}
      onAuthed={() => {
        // The session change re-runs the list effect automatically; nothing to do.
      }}
    />
  );
}

/** Return here after email confirmation (sign-up). Landing on /following signed in is
 *  enough; the list loads on the session change. */
function signedOutReturnUrl(): string {
  const origin =
    (typeof window !== "undefined" ? window.location.origin : undefined) ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "http://localhost:3000";
  return `${origin}/following`;
}

function ListSkeleton() {
  return (
    <div style={{ display: "grid", gap: "var(--space-3)" }}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          style={{
            borderRadius: 16,
            border: "1px solid var(--line)",
            background: "var(--card)",
            padding: "var(--space-4)",
            display: "grid",
            gap: "var(--space-2)",
          }}
        >
          <div style={{ height: 16, width: "55%", background: "var(--paper-2)", borderRadius: 6 }} />
          <div style={{ height: 11, width: "30%", background: "var(--paper-2)", borderRadius: 6 }} />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)", maxWidth: 420, margin: "0 auto" }}>
      <div
        aria-hidden
        style={{
          width: 56,
          height: 56,
          margin: "0 auto var(--space-4)",
          borderRadius: "50%",
          background: "var(--crimson-tint)",
          display: "grid",
          placeItems: "center",
          fontSize: 24,
          color: "var(--crimson-700)",
        }}
      >
        ◍
      </div>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Not following anything yet
      </div>
      <p style={{ color: "var(--muted)", lineHeight: 1.55 }}>
        Follow a venue from Explore to get a heads-up when it posts. The venues you follow show up here.
      </p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Couldn&apos;t load your follows
      </div>
      <p style={{ color: "var(--muted)" }}>{message}</p>
    </div>
  );
}
