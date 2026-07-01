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
import { Button } from "@roam/design";
import { OwnerMediaManager } from "./OwnerMediaManager";
import { OwnerDetailsEditor } from "./OwnerDetailsEditor";
import { OwnerHoursEditor } from "./OwnerHoursEditor";
import { LocalPosts } from "./LocalPosts";
import { BusinessStats } from "./BusinessStats";
import { VenueNotify } from "./VenueNotify";
import { VenueOffers } from "./VenueOffers";
import { OfferInsights } from "./OfferInsights";
import { VenueActivity } from "./VenueActivity";
import { venuePath } from "../lib/routes";

/** The venue fields we read to seed the editors (byId returns the full row). */
interface OwnerVenue {
  id: string;
  slug: string | null;
  name: string;
  status: string;
  owner_id: string | null;
  description: string | null;
  links: Record<string, unknown> | null;
  opening_times: { periods?: unknown[] | null } | null;
  rating: number | null;
  rating_count: number | null;
  locality: string | null;
  region: string | null;
  category: string | null;
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
        <span style={{ width: 1 }} />
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
          {/* Hero */}
          <div style={{ marginBottom: "var(--space-5)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: 4, flexWrap: "wrap" }}>
                  <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, margin: 0, fontSize: 30, letterSpacing: "-.02em" }}>
                    {venue.name}
                  </h1>
                  <StatusPill status={venue.status} />
                </div>
                <div style={{ fontSize: 13.5, color: "var(--ink-2)" }}>
                  {[venue.category, [venue.locality, venue.region].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}
                </div>
              </div>
              <Link href={venuePath(venue.slug ?? venueId)} style={{ textDecoration: "none", flexShrink: 0 }}>
                <Button variant="neutral" size="sm">View public page →</Button>
              </Link>
            </div>
            <p style={{ margin: "var(--space-3) 0 0", fontSize: 14, color: "var(--ink-2)", lineHeight: 1.5 }}>
              Post local updates, manage photos, details and hours. Everything here shows on your public venue page.
            </p>
          </div>

          <BusinessStats venueId={venueId} rating={venue.rating} ratingCount={venue.rating_count} />

          <div style={{ display: "grid", gap: "var(--space-4)" }}>
            <DashSection
              icon="🔔"
              title="Activity"
              subtitle="What locals are doing with your business — new follows, offer saves and redemptions."
            >
              <VenueActivity venueId={venueId} />
            </DashSection>

            <DashSection
              icon="📣"
              title="Local posts"
              subtitle="Post news, offers and events on behalf of your business. Each appears on your page and in your town's local news feed."
            >
              <LocalPosts venueId={venueId} />
            </DashSection>

            <DashSection
              icon="🎟"
              title="Offers"
              subtitle="Publish exclusive deals. Followers get notified; anyone can save them and redeem in-venue. You see the redemption count."
            >
              <VenueOffers venueId={venueId} />
            </DashSection>

            <DashSection
              icon="📊"
              title="Offer insights"
              subtitle="Which kinds of deal land best with locals — saves and redemptions by offer type."
            >
              <OfferInsights venueId={venueId} />
            </DashSection>

            <DashSection
              icon="📨"
              title="Send a notification"
              subtitle="Message your followers' notifications inbox — everyone at once, or one person individually."
            >
              <VenueNotify venueId={venueId} />
            </DashSection>

            <DashSection icon="✦" title="Photos" subtitle="Upload your own — they take priority over public-source photos. Set a cover and reorder.">
              <OwnerMediaManager venueId={venueId} />
            </DashSection>

            <DashSection icon="✎" title="Details" subtitle="A description and the links people need — menu, booking, website.">
              <OwnerDetailsEditor
                venueId={venueId}
                initialDescription={venue.description}
                initialLinks={venue.links}
                onSaved={load}
              />
            </DashSection>

            <DashSection icon="◷" title="Opening hours" subtitle="Set when you're open — powers the live “Open now” status on your page.">
              <OwnerHoursEditor
                venueId={venueId}
                initialPeriods={(venue.opening_times?.periods ?? null) as never}
                onSaved={load}
              />
            </DashSection>
          </div>
        </>
      )}
    </main>
  );
}

/** A dashboard section shell — icon chip + title + subtitle, then the editor. Matches the
 *  consumer Home dashboard's section rhythm. */
function DashSection({ icon, title, subtitle, children }: { icon: string; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <header style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
        <span aria-hidden style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 10, background: "var(--crimson-tint)", color: "var(--crimson-700)", fontSize: 16, flexShrink: 0 }}>
          {icon}
        </span>
        <div style={{ minWidth: 0 }}>
          <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, margin: 0 }}>{title}</h2>
          <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.45 }}>{subtitle}</p>
        </div>
      </header>
      {children}
    </Card>
  );
}

function StatusPill({ status }: { status: string }) {
  const claimed = status === "claimed";
  return (
    <span style={{ flexShrink: 0, padding: "3px 10px", borderRadius: 999, fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".04em", textTransform: "uppercase", fontWeight: 700, color: claimed ? "var(--crimson-700)" : "var(--muted)", background: claimed ? "var(--crimson-tint)" : "var(--paper-2)", border: `1px solid ${claimed ? "var(--crimson-tint-2)" : "var(--line)"}` }}>
      {claimed ? "Claimed" : status.replace(/_/g, " ")}
    </span>
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
