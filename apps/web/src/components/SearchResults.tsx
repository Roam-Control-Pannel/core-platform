/**
 * SearchResults — the /search results page body. Reads ?q, runs search.global (local-first via the
 * current place), and renders grouped results with a tab filter (All · People · Places · Events ·
 * Community · Marketplace). Client component: results depend on the browsing place (client-only) and
 * the query reacts to URL changes from the TopBar bar.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card, Icon, type IconName } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { useCurrentPlace } from "../lib/currentPlace";
import { formatEventWhen } from "../lib/events";
import { EMPTY_RESULTS, totalCount, listingPrice, distanceLabel, type SearchResultsData } from "../lib/searchResult";

type Tab = "all" | "people" | "venues" | "events" | "topics" | "listings";
const TABS: { id: Tab; labelKey: string }[] = [
  { id: "all", labelKey: "all" },
  { id: "people", labelKey: "people" },
  { id: "venues", labelKey: "places" },
  { id: "events", labelKey: "events" },
  { id: "topics", labelKey: "community" },
  { id: "listings", labelKey: "marketplace" },
];

export function SearchResults() {
  const t = useTranslations("chrome.search");
  const trpc = useTrpc();
  const { place } = useCurrentPlace();
  const params = useSearchParams();
  const q = (params.get("q") ?? "").trim();

  const [results, setResults] = useState<SearchResultsData>(EMPTY_RESULTS);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("all");

  useEffect(() => {
    if (q.length < 2) {
      setResults(EMPTY_RESULTS);
      return;
    }
    let live = true;
    setLoading(true);
    const run = trpc.search.global as unknown as {
      query: (i: { q: string; lat?: number; lng?: number; limitPer?: number }) => Promise<SearchResultsData>;
    };
    run
      .query({ q, lat: place.lat, lng: place.lng, limitPer: 12 })
      .then((r) => { if (live) { setResults(r); setLoading(false); } })
      .catch(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [q, trpc, place.lat, place.lng]);

  const total = totalCount(results);
  const show = (g: Tab) => tab === "all" || tab === g;

  const counts = useMemo(
    () => ({
      people: results.people.length,
      venues: results.venues.length,
      events: results.events.length,
      topics: results.topics.length,
      listings: results.listings.length,
    }),
    [results],
  );

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ marginBottom: "var(--space-4)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--crimson-700)", marginBottom: 6 }}>
          {t("kicker")}
        </div>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 26, letterSpacing: "-.02em", margin: 0 }}>
          {q ? t("resultsFor", { q }) : t("titleEmpty")}
        </h1>
      </header>

      {/* Tabs */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: "var(--space-4)" }}>
        {TABS.map((tb) => {
          const c = tb.id === "all" ? total : (counts as Record<string, number>)[tb.id];
          if (tb.id !== "all" && c === 0) return null;
          const on = tab === tb.id;
          return (
            <button
              key={tb.id}
              type="button"
              onClick={() => setTab(tb.id)}
              aria-pressed={on}
              style={{
                all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "6px 13px", borderRadius: 999,
                fontFamily: "var(--ui)", fontSize: 12.5, fontWeight: 600,
                border: `1px solid ${on ? "var(--crimson-tint-2)" : "var(--line-2)"}`,
                background: on ? "var(--crimson-tint)" : "#fff",
                color: on ? "var(--crimson-700)" : "var(--ink-2)",
              }}
            >
              {t(`groups.${tb.labelKey}`)}{tb.id !== "all" ? ` · ${c}` : ""}
            </button>
          );
        })}
      </div>

      {q.length < 2 ? (
        <Empty body={t("typeToSearch")} />
      ) : loading && total === 0 ? (
        <Empty body={t("searching")} />
      ) : total === 0 ? (
        <Empty body={t("noResults", { q })} />
      ) : (
        <div style={{ display: "grid", gap: "var(--space-5)" }}>
          {show("people") && results.people.length > 0 ? (
            <Section title={t("groups.people")}>
              {results.people.map((p) => (
                <ResultCard key={p.id} href={p.url} icon="person" avatarUrl={p.avatarUrl} primary={p.name} secondary={p.handle ? `@${p.handle}` : undefined} />
              ))}
            </Section>
          ) : null}
          {show("venues") && results.venues.length > 0 ? (
            <Section title={t("groups.places")}>
              {results.venues.map((v) => (
                <ResultCard key={v.id} href={v.url} icon="place" primary={v.name} secondary={[v.category, distanceLabel(v.distanceM)].filter(Boolean).join(" · ") || undefined} trailing={v.rating != null ? `★ ${v.rating.toFixed(1)}` : undefined} />
              ))}
            </Section>
          ) : null}
          {show("events") && results.events.length > 0 ? (
            <Section title={t("groups.events")}>
              {results.events.map((e) => (
                <ResultCard key={e.id} href={e.url} icon="event" primary={e.title} secondary={`${formatEventWhen(e.startsAt, null)} · ${e.where ?? e.localityLabel}`} />
              ))}
            </Section>
          ) : null}
          {show("topics") && results.topics.length > 0 ? (
            <Section title={t("groups.community")}>
              {results.topics.map((tp) => (
                <ResultCard key={tp.id} href={tp.url} icon="landmark" primary={tp.title} secondary={tp.localityLabel} />
              ))}
            </Section>
          ) : null}
          {show("listings") && results.listings.length > 0 ? (
            <Section title={t("groups.marketplace")}>
              {results.listings.map((l) => (
                <ResultCard key={l.id} href={l.url} icon="shop" primary={l.title} secondary={l.locality ?? undefined} trailing={listingPrice(l.pricePence, l.mode)} />
              ))}
            </Section>
          ) : null}
        </div>
      )}
    </main>
  );
}

function Empty({ body }: { body: string }) {
  return (
    <Card flat style={{ padding: "var(--space-6)", textAlign: "center", color: "var(--ink-2)", lineHeight: 1.5 }}>{body}</Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 16, margin: "0 0 var(--space-3)" }}>{title}</h2>
      <div style={{ display: "grid", gap: "var(--space-2)" }}>{children}</div>
    </section>
  );
}

function ResultCard({
  href,
  icon,
  primary,
  secondary,
  trailing,
  avatarUrl,
}: {
  href: string;
  icon: IconName;
  primary: string;
  secondary?: string | undefined;
  trailing?: string | undefined;
  avatarUrl?: string | null;
}) {
  return (
    <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>
      <Card style={{ padding: "var(--space-3) var(--space-4)", display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- small avatar in a result row
          <img src={avatarUrl} alt="" style={{ width: 38, height: 38, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
        ) : (
          <span aria-hidden style={{ display: "grid", placeItems: "center", width: 38, height: 38, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", flexShrink: 0 }}>
            <Icon name={icon} size={17} />
          </span>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{primary}</div>
          {secondary ? <div style={{ fontSize: 12.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{secondary}</div> : null}
        </div>
        {trailing ? <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)", flexShrink: 0 }}>{trailing}</span> : null}
      </Card>
    </Link>
  );
}
