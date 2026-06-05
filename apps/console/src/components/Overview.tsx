/**
 * Overview — the Business console root. Answers one question: which venues does the
 * signed-in user OWN, and what should they do next?
 *
 * Reads venues.myVenues (protected, owner-scoped: owner_id = auth.uid()). The console
 * is private, so this gates on useSession() like the consumer chat surfaces: signed
 * out -> a sign-in prompt (no public browse here); signed in -> the owner''s venues.
 *
 * State ladder per the codebase idiom: error -> undefined(skeleton) -> empty -> content.
 * The EMPTY state is the median launch case for the console too — a freshly signed-up
 * business owner who hasn''t claimed a venue yet. It must read "here''s how to start",
 * not "broken": it points them at the consumer app to find and claim their venue
 * (claiming lives there, on the venue detail page — VenueDetail''s claim flow).
 *
 * Each owned venue gets a next-best-action: the data-led console''s job is to always
 * suggest the most useful next step. For this first slice that''s "Post an update"
 * (the composer is the next console slice); the card is the seam it will hang from.
 *
 * Dates/handles: myVenues returns no timestamps; rating is numeric|null, formatted here.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Pill, Button, Rate } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";

interface OwnedVenue {
  id: string;
  name: string;
  status: string;
  category: string | null;
  locality: string | null;
  region: string | null;
  rating: number | null;
  ratingCount: number;
}

/** The consumer web app origin — where claiming a venue happens (VenueDetail). */
function consumerAppUrl(): string {
  return process.env.NEXT_PUBLIC_WEB_URL ?? "http://localhost:3000";
}

export function Overview() {
  const trpc = useTrpc();
  const session = useSession();
  const [venues, setVenues] = useState<OwnedVenue[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setVenues(undefined);
    setError(null);
    trpc.venues.myVenues
      .query()
      .then((rows) => {
        if (!cancelled) setVenues(rows as OwnedVenue[]);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load your venues.");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  useEffect(() => {
    if (!session) {
      setVenues(undefined);
      return;
    }
    return load();
  }, [session, load]);

  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ padding: "var(--space-2) 0 var(--space-6)" }}>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--crimson-700)",
            marginBottom: 4,
          }}
        >
          Roam for Business
        </div>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 30, margin: 0 }}>
          Overview
        </h1>
      </header>

      {!session ? (
        <SignedOut />
      ) : error ? (
        <ErrorState message={error} />
      ) : venues === undefined ? (
        <OverviewSkeleton />
      ) : venues.length === 0 ? (
        <NoVenues />
      ) : (
        <div style={{ display: "grid", gap: "var(--space-4)" }}>
          <SectionLabel>
            {venues.length} {venues.length === 1 ? "venue" : "venues"}
          </SectionLabel>
          {venues.map((v) => (
            <VenueOverviewCard key={v.id} venue={v} />
          ))}
        </div>
      )}
    </main>
  );
}

function VenueOverviewCard({ venue }: { venue: OwnedVenue }) {
  const place = [venue.locality, venue.region].filter(Boolean).join(", ");
  return (
    <Card style={{ padding: "var(--space-5)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--space-3)" }}>
        <div style={{ display: "grid", gap: 4 }}>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600 }}>
            {venue.name}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: 13, color: "var(--ink-2)" }}>
            {venue.rating != null ? (
              <Rate value={`${venue.rating.toFixed(1)}${venue.ratingCount ? ` (${venue.ratingCount})` : ""}`} />
            ) : null}
            {venue.category ? <span>{venue.category}</span> : null}
            {place ? <span>· {place}</span> : null}
          </div>
        </div>
        <Pill variant={venue.status === "claimed" ? "ghost-crim" : "neutral"} size="sm">
          {venue.status === "claimed" ? "Claimed" : venue.status}
        </Pill>
      </div>

      {/* Next-best-action. The composer is the next console slice; this is its seam. */}
      <div
        style={{
          marginTop: "var(--space-4)",
          paddingTop: "var(--space-4)",
          borderTop: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-3)",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
          <strong style={{ color: "var(--ink-hi)" }}>Next:</strong> post news, an offer or an event to people nearby.
        </div>
        <Button variant="pri" disabled title="Posting arrives in the next console slice">
          Post an update
        </Button>
      </div>
    </Card>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--mono)",
        fontSize: 10,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        color: "var(--muted)",
      }}
    >
      {children}
    </div>
  );
}

function SignedOut() {
  return (
    <Card flat style={{ padding: "var(--space-5)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
        Sign in to manage your venue
      </div>
      <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
        Roam for Business lets you manage the venues you''ve claimed — post updates,
        and (soon) see how people are finding you. Sign in with the account you used
        to claim your venue.
      </p>
      <a href={consumerAppUrl()} style={{ textDecoration: "none" }}>
        <Pill variant="ghost-crim">Go to Roam to sign in &amp; claim →</Pill>
      </a>
    </Card>
  );
}

function NoVenues() {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)", maxWidth: 520, margin: "0 auto" }}>
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
        You haven&apos;t claimed a venue yet
      </div>
      <p style={{ color: "var(--muted)", lineHeight: 1.55, marginBottom: "var(--space-4)" }}>
        Once you claim your business on Roam and it&apos;s verified, it shows up here and you
        can start posting to people nearby. Claiming is free and takes a minute.
      </p>
      <a href={consumerAppUrl()} style={{ textDecoration: "none" }}>
        <Pill variant="ghost-crim">Find &amp; claim your venue on Roam →</Pill>
      </a>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      {Array.from({ length: 2 }).map((_, i) => (
        <div
          key={i}
          style={{
            borderRadius: 16,
            border: "1px solid var(--line)",
            background: "var(--card)",
            padding: "var(--space-5)",
            display: "grid",
            gap: "var(--space-3)",
          }}
        >
          <div style={{ height: 18, width: "45%", background: "var(--paper-2)", borderRadius: 6 }} />
          <div style={{ height: 12, width: "30%", background: "var(--paper-2)", borderRadius: 6 }} />
          <div style={{ height: 36, width: "100%", background: "var(--paper-2)", borderRadius: 10, marginTop: "var(--space-2)" }} />
        </div>
      ))}
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Couldn&apos;t load your venues
      </div>
      <p style={{ color: "var(--muted)" }}>{message}</p>
    </div>
  );
}
