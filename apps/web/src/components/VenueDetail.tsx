/**
 * VenueDetail — the full-page venue surface. The natural next slice after Explore:
 * `venues.byId` already existed in the API; this is its first consumer and the entry
 * point to the claim flow.
 *
 * Two first-class states, mirroring VenueCard's split but at full-page depth:
 *
 *  - CLAIMED (owner_id set): hero, name, ★rating (gold) + category, description,
 *    a Links row (Order/Book/Menu from the venue's `links` jsonb), Details
 *    (address/locality/opening times where present). The richer the record, the
 *    fuller the page — but it degrades gracefully when fields are null.
 *  - UNCLAIMED: the global-launch median experience at full size — honest
 *    "From public sources" provenance, locality context, and the claim entry point
 *    presented as the page's single primary CTA. NO rating (over-claiming confidence
 *    on unverified scraped data is the exact thing VenueCard's design intent forbids).
 *
 * Claim is an ENTRY POINT this slice, not a flow: the primary CTA is present and
 * labelled, but wiring just-in-time auth + the claim mutation is a deliberately
 * separate next step. The button is disabled with an honest "coming soon" affordance
 * rather than a dead click or a half-built flow.
 *
 * All four states ship with the screen (States matrix): loading (content-shaped
 * skeleton, not a spinner), error, not-found, and the two loaded states.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Pill, Rate, Button } from "@roam/design";
import { useTrpc } from "./TrpcProvider";

/**
 * The byId result is the full venues Row (select("*")). We read it loosely here —
 * the fields we render are a stable subset; `geo` (PostGIS `unknown`) is never touched
 * client-side (proximity is the RPC's job, not this page's).
 */
interface VenueDetailData {
  id: string;
  name: string;
  owner_id: string | null;
  status: string;
  category: string | null;
  categories: string[];
  rating: number | null;
  rating_count: number;
  description: string | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  opening_times: unknown;
  links: Record<string, unknown> | null;
  source_attribution: string | null;
}

export function VenueDetail({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [venue, setVenue] = useState<VenueDetailData | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setVenue(undefined);
    setError(null);
    trpc.venues.byId
      .query({ venueId })
      .then((row) => {
        if (cancelled) return;
        // null = not found (maybeSingle returned no row).
        setVenue((row as VenueDetailData | null) ?? null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load venue.");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, venueId]);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <BackLink />
      {error ? (
        <ErrorState message={error} />
      ) : venue === undefined ? (
        <DetailSkeleton />
      ) : venue === null ? (
        <NotFoundState />
      ) : venue.owner_id !== null ? (
        <ClaimedDetail venue={venue} />
      ) : (
        <UnclaimedDetail venue={venue} />
      )}
    </main>
  );
}

function BackLink() {
  return (
    <Link
      href="/"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
        color: "var(--muted)",
        textDecoration: "none",
        marginBottom: "var(--space-4)",
      }}
    >
      <span aria-hidden>←</span> Explore
    </Link>
  );
}

function Hero({ claimed }: { claimed: boolean }) {
  return (
    <div
      aria-hidden
      style={{
        height: 200,
        borderRadius: 16,
        marginBottom: "var(--space-4)",
        ...(claimed
          ? {
              background:
                "radial-gradient(120% 90% at 20% 10%, #e7b48a 0%, transparent 55%)," +
                "radial-gradient(120% 120% at 90% 90%, #7c3a2a 0%, transparent 60%)," +
                "linear-gradient(150deg, #c96b43, #8f3f29)",
            }
          : {
              background: "var(--crimson-tint)",
              display: "grid",
              placeItems: "center",
              border: "1px dashed var(--line-2)",
            }),
      }}
    >
      {claimed ? null : (
        <span style={{ fontSize: 40, color: "var(--crimson-700)", opacity: 0.5 }}>◍</span>
      )}
    </div>
  );
}

function TitleRow({ name }: { name: string }) {
  return (
    <h1
      className="t-h1"
      style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 30, letterSpacing: "-.02em", margin: 0 }}
    >
      {name}
    </h1>
  );
}

function ClaimedDetail({ venue }: { venue: VenueDetailData }) {
  const links = linkEntries(venue.links);
  return (
    <>
      <Hero claimed />
      <TitleRow name={venue.name} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          marginTop: "var(--space-2)",
          fontSize: 13.5,
          color: "var(--ink-2)",
        }}
      >
        {/* Claimed shows ★rating (gold) — the sanctioned confidence signal on a verified venue. */}
        {venue.rating != null ? (
          <Rate value={`${venue.rating.toFixed(1)}${venue.rating_count ? ` (${venue.rating_count})` : ""}`} />
        ) : null}
        {venue.category ? <span>{venue.category}</span> : null}
      </div>

      {venue.description ? (
        <p style={{ marginTop: "var(--space-4)", lineHeight: 1.6, color: "var(--ink-1)" }}>{venue.description}</p>
      ) : null}

      {links.length > 0 ? (
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-4)" }}>
          {links.map(([label, url]) => (
            <a key={label} href={url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
              <Pill variant="ghost-crim">{capitalise(label)}</Pill>
            </a>
          ))}
        </div>
      ) : null}

      <DetailsBlock venue={venue} />
    </>
  );
}

function UnclaimedDetail({ venue }: { venue: VenueDetailData }) {
  return (
    <>
      <Hero claimed={false} />
      <TitleRow name={venue.name} />
      <div style={{ marginTop: "var(--space-2)", fontSize: 13.5, color: "var(--ink-2)" }}>
        {venue.category ? <span>{venue.category}</span> : null}
        {venue.category && venue.locality ? <span> · </span> : null}
        {venue.locality ? <span>{venue.locality}</span> : null}
      </div>

      {/* Provenance, stated plainly — "new, not dead". NO rating by design. */}
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          letterSpacing: ".04em",
          textTransform: "uppercase",
          color: "var(--muted)",
          marginTop: "var(--space-3)",
        }}
      >
        {venue.source_attribution ?? "From public sources"}
      </div>

      {/* Claim entry point — the page's single primary CTA. Flow + JIT auth are the
          next slice, so the CTA is present and honest, not a dead click. */}
      <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-5)" }}>
        <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
          Is this your venue?
        </div>
        <p style={{ color: "var(--ink-2)", lineHeight: 1.5, marginBottom: "var(--space-4)" }}>
          Claim it free to add photos, opening times, your menu and links — and post offers
          and events to people nearby.
        </p>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
          <Button variant="pri" disabled title="Claiming opens soon">
            Claim it free
          </Button>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--muted)" }}>Coming soon</span>
        </div>
      </Card>

      <DetailsBlock venue={venue} />
    </>
  );
}

function DetailsBlock({ venue }: { venue: VenueDetailData }) {
  const rows: Array<[string, string]> = [];
  if (venue.address) rows.push(["Address", venue.address]);
  if (venue.locality) rows.push(["Locality", venue.locality]);
  if (venue.region) rows.push(["Region", venue.region]);
  if (rows.length === 0) return null;
  return (
    <Card flat style={{ marginTop: "var(--space-6)", padding: "var(--space-4)" }}>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: "var(--muted)",
          marginBottom: "var(--space-3)",
        }}
      >
        Details
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "var(--space-2) var(--space-4)", margin: 0 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt style={{ color: "var(--muted)", fontSize: 13 }}>{k}</dt>
            <dd style={{ margin: 0, fontSize: 13.5, color: "var(--ink-1)" }}>{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <div>
      <div style={{ height: 200, borderRadius: 16, background: "var(--paper-2)", marginBottom: "var(--space-4)" }} />
      <div style={{ height: 28, width: "55%", background: "var(--paper-2)", borderRadius: 8 }} />
      <div style={{ height: 14, width: "30%", background: "var(--paper-2)", borderRadius: 6, marginTop: "var(--space-3)" }} />
      <div style={{ height: 60, background: "var(--paper-2)", borderRadius: 10, marginTop: "var(--space-4)" }} />
    </div>
  );
}

function NotFoundState() {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Venue not found
      </div>
      <p style={{ color: "var(--muted)", marginBottom: "var(--space-4)" }}>
        This venue may have been removed, or the link is wrong.
      </p>
      <Link href="/" style={{ textDecoration: "none" }}>
        <Pill variant="ghost-crim">← Back to Explore</Pill>
      </Link>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Couldn&apos;t load this venue
      </div>
      <p style={{ color: "var(--muted)" }}>{message}</p>
    </div>
  );
}

/** Pull renderable string links from the venue `links` jsonb (Order/Book/Menu URLs). */
function linkEntries(links: Record<string, unknown> | null): Array<[string, string]> {
  if (!links || typeof links !== "object") return [];
  return Object.entries(links).filter(
    (e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0,
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
