/**
 * VenueOwnerEditor — the /dashboard/[venueId] surface: a claimed venue's full owner editor in
 * one place, reusing the SAME battle-tested editors the public venue page uses inline:
 * OwnerMediaManager (photos/cover), OwnerDetailsEditor (description + links) and
 * OwnerHoursEditor (opening hours). Seeded from venues.byId; re-loads after each save.
 *
 * Ownership is gated by RLS on every write (owner_id = auth.uid() AND status = 'claimed'), so
 * this is presentation only — but we still check owner_id here to show the right state (a
 * non-owner gets a clear message instead of dead editors).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { OwnerMediaManager } from "./OwnerMediaManager";
import { OwnerDetailsEditor } from "./OwnerDetailsEditor";
import { OwnerHoursEditor } from "./OwnerHoursEditor";
import { venuePath } from "../lib/routes";

/** The venue fields we read to seed the editors (byId returns the full row). */
interface OwnerVenue {
  id: string;
  name: string;
  status: string;
  owner_id: string | null;
  description: string | null;
  links: Record<string, unknown> | null;
  opening_times: { periods?: unknown[] | null } | null;
}

type ByIdQuery = { query: (input: { venueId: string }) => Promise<OwnerVenue | null> };

export function VenueOwnerEditor({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const session = useSession();
  const [venue, setVenue] = useState<OwnerVenue | null | "missing">(null);
  const [error, setError] = useState<string | null>(null);
  const userId = session?.user?.id ?? null;

  const load = useCallback(async () => {
    setError(null);
    try {
      const v = await (trpc.venues.byId as unknown as ByIdQuery).query({ venueId });
      setVenue(v ?? "missing");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't load this venue.");
    }
  }, [trpc, venueId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isOwner = venue !== null && venue !== "missing" && !!userId && venue.owner_id === userId;

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "var(--space-2) 0 var(--space-4)" }}>
        <Link href="/dashboard" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none" }}>
          <span aria-hidden>←</span> Business
        </Link>
        {venue !== null && venue !== "missing" ? (
          <Link href={venuePath(venueId)} style={{ fontSize: 13, color: "var(--crimson-700)", textDecoration: "none" }}>
            View public page →
          </Link>
        ) : (
          <span style={{ width: 1 }} />
        )}
      </header>

      {error ? (
        <p role="alert" style={{ color: "var(--crimson-700)" }}>{error}</p>
      ) : venue === null ? (
        <div style={{ height: 320, borderRadius: 16, background: "var(--paper-2)" }} aria-hidden />
      ) : venue === "missing" ? (
        <Message title="Venue not found" body="This venue doesn’t exist or is no longer available." />
      ) : !isOwner ? (
        <Message
          title="You don’t manage this venue"
          body="Only the venue’s owner can edit it. If you claimed it, your claim may still be under review."
        />
      ) : (
        <>
          <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, margin: "0 0 var(--space-1)", fontSize: 24 }}>
            {venue.name}
          </h1>
          <p style={{ marginTop: 0, marginBottom: "var(--space-4)", fontSize: 13, color: "var(--muted)" }}>
            Add photos, a description, links and opening hours. Changes appear on your public venue page.
          </p>

          <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
            <OwnerMediaManager venueId={venueId} />
          </Card>

          <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
            <OwnerDetailsEditor
              venueId={venueId}
              initialDescription={venue.description}
              initialLinks={venue.links}
              onSaved={load}
            />
          </Card>

          <Card style={{ padding: "var(--space-4)" }}>
            <OwnerHoursEditor
              venueId={venueId}
              initialPeriods={(venue.opening_times?.periods ?? null) as never}
              onSaved={load}
            />
          </Card>
        </>
      )}
    </main>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)", maxWidth: 440, margin: "0 auto" }}>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>{title}</div>
      <p style={{ color: "var(--muted)", lineHeight: 1.55 }}>{body}</p>
    </div>
  );
}
