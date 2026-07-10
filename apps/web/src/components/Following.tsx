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

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Seg, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { EnableNotifications } from "./EnableNotifications";
import { FollowButton } from "./FollowButton";
import { venuePath } from "../lib/routes";

/** A row from myFollows: the follow's push pref + the embedded venue it points at. */
interface FollowRow {
  venueId: string;
  pushEnabled: boolean;
  venue: { id: string; name: string; category: string | null } | null;
}

export function Following() {
  const t = useTranslations("following");
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
          setError(res.error ?? t("loadFailed"));
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
        if (!cancelled) setError(e instanceof Error ? e.message : t("loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  // Only load when signed in (the query is protected; an anon call would 401).
  // Gate on the user IDENTITY, not the session object: Supabase emits a fresh Session
  // reference on every TOKEN_REFRESHED / focus event, and depending on the object would
  // re-run this effect (setRows(null) + refetch) on benign token churn — the query storm.
  // The user id is stable across refreshes, so we only reload on a real sign-in/out/switch.
  const userId = session?.user?.id ?? null;
  useEffect(() => {
    if (!userId) {
      setRows(null);
      return;
    }
    return load();
  }, [userId, load]);

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
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--muted)",
            textDecoration: "none",
          }}
        >
          <span aria-hidden>←</span> {t("back")}
        </Link>
        <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, margin: 0, fontSize: 22 }}>
          {t("title")}
        </h1>
        <span style={{ width: 1 }} />
      </header>

      {!session ? (
        <SignedOut />
      ) : (
        <>
          <p style={{ marginTop: 0, marginBottom: "var(--space-4)", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
            {t("intro")}
          </p>
          <div style={{ marginBottom: "var(--space-4)" }}>
            <EnableNotifications />
          </div>
          {error ? (
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
        </>
      )}
    </main>
  );
}

function FollowRowCard({ row }: { row: FollowRow }) {
  const t = useTranslations("following");
  const trpc = useTrpc();
  const name = row.venue?.name ?? t("unknownVenue");
  const [pushEnabled, setPushEnabled] = useState(row.pushEnabled);
  const [busy, setBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  // Synchronous in-flight latch. React state (busy) commits asynchronously, so a rapid
  // re-invocation of this handler — React StrictMode's intentional double-call in dev, or
  // any future re-entrancy — slips through the state guard before setBusy(true) commits.
  // A ref updates synchronously, so it blocks the duplicate write immediately. This makes
  // the mutation idempotent by construction rather than relying on prod stripping StrictMode.
  const inFlightRef = useRef(false);

  // Flip the per-venue push pref optimistically, reconciling against the server.
  //
  // Guarded so ONE user action is ONE write: ignore the call if a write is already in
  // flight, or if the requested value already matches state (a no-op re-fire from a
  // mid-interaction re-render). This is what collapses the observed 3x mutation burst
  // to a single deterministic write.
  //
  // Errors are SURFACED, never swallowed. The previous bare `catch {}` is precisely how
  // the 0014 silent-RLS bug hid: the toggle reported nothing while its writes vanished.
  // Now the server reads back rows-affected (ok:false on zero), and we revert + show why.
  const setPush = useCallback(
    async (next: boolean) => {
      if (inFlightRef.current || next === pushEnabled) return;
      inFlightRef.current = true;
      setPushError(null);
      setPushEnabled(next);
      setBusy(true);
      try {
        const res = (await trpc.social.setVenuePushEnabled.mutate({
          venueId: row.venueId,
          enabled: next,
        })) as { ok: boolean; error?: string; pushEnabled?: boolean };
        if (!res.ok) {
          setPushEnabled(!next); // revert to the pre-toggle value
          setPushError(res.error ?? t("pushUpdateFailed"));
        } else if (typeof res.pushEnabled === "boolean") {
          setPushEnabled(res.pushEnabled); // reconcile to the server's confirmed value
        }
      } catch (e: unknown) {
        setPushEnabled(!next); // revert
        setPushError(e instanceof Error ? e.message : t("pushUpdateFailed"));
      } finally {
        inFlightRef.current = false;
        setBusy(false);
      }
    },
    [trpc, row.venueId, pushEnabled],
  );

  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
        <Link
          href={venuePath(row.venueId)}
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
        <span style={{ display: "grid", gap: 1 }}>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            {t("offersPromotions")}
          </span>
          <span style={{ fontSize: 11.5, color: "var(--faint)" }}>
            {pushEnabled ? t("pushOnHint") : t("pushOffHint")}
          </span>
        </span>
        <div style={{ opacity: busy ? 0.7 : 1 }}>
          <Seg
            options={[
              { value: "on", label: t("on") },
              { value: "off", label: t("off") },
            ]}
            value={pushEnabled ? "on" : "off"}
            onChange={(v) => void setPush(v === "on")}
          />
        </div>
      </div>
      {pushError ? (
        <p
          role="alert"
          style={{
            marginTop: "var(--space-2)",
            marginBottom: 0,
            fontSize: 12,
            color: "var(--crimson-700)",
          }}
        >
          {pushError}
        </p>
      ) : null}
    </Card>
  );
}

function SignedOut() {
  const t = useTranslations("following");
  return (
    <AuthPanel
      intro={t("signedOutIntro")}
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
  const t = useTranslations("following");
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
          color: "var(--crimson-700)",
        }}
      >
        <Icon name="heart" size={24} />
      </div>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        {t("empty.title")}
      </div>
      <p style={{ color: "var(--muted)", lineHeight: 1.55 }}>
        {t("empty.body")}
      </p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  const t = useTranslations("following");
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        {t("errorTitle")}
      </div>
      <p style={{ color: "var(--muted)" }}>{message}</p>
    </div>
  );
}
