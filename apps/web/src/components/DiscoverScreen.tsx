/**
 * DiscoverScreen — the /discover/{town}/{category} landing page (server component, no "use client").
 *
 * A single-intent, indexable listing: "Best places to eat & drink in Darlington". Server-rendered
 * into the initial HTML as a real H1 + lead + a ranked, numbered list of venues, each an internal
 * link to /venue/{slug}. Deliberately text-forward (no photo grid) — it loads instantly for crawlers
 * and readers, and the venue detail pages carry the imagery. Ranking mirrors the API: claimed venues
 * first, then Roam's weighted rating, so the list leads with the strongest local answers.
 *
 * An empty combo still renders (a short "nothing yet" note) but the page sets noindex upstream, so
 * Roam never publishes a thin town × category doorway page.
 */
import Link from "next/link";
import { Card } from "@roam/design";
import { categoryLabel } from "../lib/categories";
import { DISCOVER_CATEGORIES, type DiscoverCategory } from "../lib/discover";
import type { DiscoverVenue } from "../lib/serverApi";

export function DiscoverScreen({
  cat,
  localityLabel,
  locality,
  region,
  venues,
}: {
  cat: DiscoverCategory;
  localityLabel: string;
  locality: string;
  region: string | null;
  venues: DiscoverVenue[];
}) {
  const lead = cat.blurb.replace("{town}", localityLabel);
  const siblings = DISCOVER_CATEGORIES.filter((c) => c.slug !== cat.slug);
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      {/* Breadcrumb trail (Roam › Town › Category) — matches the BreadcrumbList JSON-LD. */}
      <nav aria-label="Breadcrumb" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", marginBottom: "var(--space-4)" }}>
        <Link href="/" style={{ color: "var(--muted)", textDecoration: "none" }}>Roam</Link>
        <span aria-hidden>›</span>
        <Link href={`/town-hall/${locality}`} style={{ color: "var(--muted)", textDecoration: "none" }}>{localityLabel}</Link>
        <span aria-hidden>›</span>
        <span style={{ color: "var(--ink-2)" }}>{cat.heading}</span>
      </nav>

      <header style={{ marginBottom: "var(--space-6)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--crimson-700)", marginBottom: 6 }}>
          {region ? `${localityLabel}, ${region}` : localityLabel}
        </div>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 30, letterSpacing: "-.02em", margin: 0 }}>
          {cat.intent} in {localityLabel}
        </h1>
        <p style={{ margin: "var(--space-2) 0 var(--space-4)", color: "var(--ink-2)", fontSize: 14.5, lineHeight: 1.55 }}>
          {lead}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
          <Link href="/explore" style={{ textDecoration: "none" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 999, background: "var(--crimson-tint)", border: "1px solid var(--crimson-tint-2)", color: "var(--crimson-700)", fontWeight: 600, fontSize: 13.5 }}>
              Explore the map
            </span>
          </Link>
        </div>
      </header>

      <section>
        <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 18, margin: "0 0 var(--space-3)" }}>
          {cat.heading} in {localityLabel}
          {venues.length > 0 ? <span style={{ color: "var(--muted)", fontWeight: 400 }}> · {venues.length}</span> : null}
        </h2>

        {venues.length === 0 ? (
          <Card flat style={{ padding: "var(--space-6)", textAlign: "center", borderStyle: "dashed", borderColor: "var(--line)", background: "var(--paper-2)" }}>
            <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>Nothing here yet</div>
            <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5 }}>
              We don&rsquo;t have {cat.heading.toLowerCase()} in {localityLabel} on Roam yet — check back soon, or explore the map.
            </p>
          </Card>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
            {venues.map((v, i) => (
              <li key={v.id}>
                <Link href={`/venue/${v.slug ?? v.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                  <Card style={{ padding: "var(--space-3) var(--space-4)", display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                    <span aria-hidden style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700, color: "var(--muted)", width: 22, textAlign: "right", flexShrink: 0 }}>
                      {i + 1}
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 16, lineHeight: 1.3 }}>{v.name}</div>
                      <div style={{ marginTop: 2, fontSize: 12.5, color: "var(--muted)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span>{v.typeLabel ?? (v.category ? categoryLabel(v.category) : "Local place")}</span>
                        {v.status === "claimed" ? (
                          <>
                            <span aria-hidden>·</span>
                            <span style={{ color: "var(--crimson-700)", fontWeight: 600 }}>On Roam</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    {v.rating != null ? (
                      <span style={{ display: "inline-flex", alignItems: "baseline", gap: 4, flexShrink: 0 }}>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>★ {v.rating.toFixed(1)}</span>
                        {v.ratingCount > 0 ? <span style={{ fontSize: 11.5, color: "var(--muted)" }}>({v.ratingCount})</span> : null}
                      </span>
                    ) : null}
                  </Card>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Sibling categories — sideways links to the town's other discovery pages, so crawlers and
          readers can move between "eat & drink", "things to do", etc. within the same town. */}
      <section style={{ marginTop: "var(--space-8)", paddingTop: "var(--space-5)", borderTop: "1px solid var(--line)" }}>
        <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 18, margin: "0 0 var(--space-3)" }}>
          More in {localityLabel}
        </h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
          {siblings.map((c) => (
            <Link
              key={c.slug}
              href={`/discover/${locality}/${c.slug}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 999, background: "var(--paper-2)", border: "1px solid var(--line)", textDecoration: "none", color: "var(--ink)", fontWeight: 600, fontSize: 13.5 }}
            >
              {c.heading} <span aria-hidden style={{ color: "var(--muted)" }}>→</span>
            </Link>
          ))}
          <Link
            href={`/town-hall/${locality}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 999, background: "var(--crimson-tint)", border: "1px solid var(--crimson-tint-2)", textDecoration: "none", color: "var(--crimson-700)", fontWeight: 600, fontSize: 13.5 }}
          >
            All of {localityLabel} <span aria-hidden>→</span>
          </Link>
        </div>
      </section>
    </main>
  );
}
