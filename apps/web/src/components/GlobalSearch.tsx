/**
 * GlobalSearch — the site-wide search bar in the TopBar (persistent on every page). Debounced
 * typeahead over search.global: as you type it shows grouped results (People · Places · Events ·
 * Community · Marketplace) in a dropdown; Enter (or "See all") goes to the /search results page.
 *
 * Local-first: passes the current browsing place's lat/lng so nearby businesses rank first. Stale
 * responses are dropped (a seq guard), the dropdown closes on outside-click / Escape / navigation.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { useCurrentPlace } from "../lib/currentPlace";
import { formatEventWhen } from "../lib/events";
import {
  EMPTY_RESULTS,
  totalCount,
  listingPrice,
  distanceLabel,
  type SearchResultsData,
} from "../lib/searchResult";
import styles from "./GlobalSearch.module.css";

export function GlobalSearch() {
  const t = useTranslations("chrome.search");
  const trpc = useTrpc();
  const router = useRouter();
  const { place } = useCurrentPlace();

  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResultsData>(EMPTY_RESULTS);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // Debounced fan-out query; a seq guard drops out-of-order (stale) responses.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(EMPTY_RESULTS);
      setLoading(false);
      return;
    }
    setLoading(true);
    const mine = ++seq.current;
    const run = trpc.search.global as unknown as {
      query: (i: { q: string; lat?: number; lng?: number; limitPer?: number }) => Promise<SearchResultsData>;
    };
    const timer = setTimeout(() => {
      run
        .query({ q: term, lat: place.lat, lng: place.lng, limitPer: 5 })
        .then((r) => {
          if (mine === seq.current) {
            setResults(r);
            setLoading(false);
          }
        })
        .catch(() => {
          if (mine === seq.current) setLoading(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [q, trpc, place.lat, place.lng]);

  // Close on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const goToResults = useCallback(() => {
    const term = q.trim();
    if (term.length < 2) return;
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(term)}`);
  }, [q, router]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") goToResults();
      else if (e.key === "Escape") setOpen(false);
    },
    [goToResults],
  );

  const total = totalCount(results);
  const showDropdown = open && q.trim().length >= 2;

  return (
    <div ref={rootRef} className={styles.root}>
      <div className={styles.bar}>
        <span aria-hidden className={styles.icon}><Icon name="search" size={16} /></span>
        <input
          className={styles.input}
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t("placeholder")}
          aria-label={t("placeholder")}
          type="search"
          enterKeyHint="search"
        />
      </div>

      {showDropdown ? (
        <div className={styles.dropdown} role="listbox">
          {loading && total === 0 ? (
            <div className={styles.hint}>{t("searching")}</div>
          ) : total === 0 ? (
            <div className={styles.hint}>{t("noResults", { q: q.trim() })}</div>
          ) : (
            <>
              {results.people.length > 0 ? (
                <Group label={t("groups.people")}>
                  {results.people.map((p) => (
                    <Row key={p.id} href={p.url} onNavigate={() => setOpen(false)} icon="person" primary={p.name} secondary={p.handle ? `@${p.handle}` : undefined} avatarUrl={p.avatarUrl} />
                  ))}
                </Group>
              ) : null}

              {results.venues.length > 0 ? (
                <Group label={t("groups.places")}>
                  {results.venues.map((v) => (
                    <Row key={v.id} href={v.url} onNavigate={() => setOpen(false)} icon="place" primary={v.name} secondary={[v.category, distanceLabel(v.distanceM)].filter(Boolean).join(" · ") || undefined} />
                  ))}
                </Group>
              ) : null}

              {results.events.length > 0 ? (
                <Group label={t("groups.events")}>
                  {results.events.map((e) => (
                    <Row key={e.id} href={e.url} onNavigate={() => setOpen(false)} icon="event" primary={e.title} secondary={`${formatEventWhen(e.startsAt, null)} · ${e.localityLabel}`} />
                  ))}
                </Group>
              ) : null}

              {results.topics.length > 0 ? (
                <Group label={t("groups.community")}>
                  {results.topics.map((tp) => (
                    <Row key={tp.id} href={tp.url} onNavigate={() => setOpen(false)} icon="landmark" primary={tp.title} secondary={tp.localityLabel} />
                  ))}
                </Group>
              ) : null}

              {results.listings.length > 0 ? (
                <Group label={t("groups.marketplace")}>
                  {results.listings.map((l) => (
                    <Row key={l.id} href={l.url} onNavigate={() => setOpen(false)} icon="shop" primary={l.title} secondary={[listingPrice(l.pricePence, l.mode), l.locality].filter(Boolean).join(" · ")} />
                  ))}
                </Group>
              ) : null}

              {results.plans.length > 0 ? (
                <Group label={t("groups.plans")}>
                  {results.plans.map((pl) => (
                    <Row key={pl.id} href={pl.url} onNavigate={() => setOpen(false)} icon="plan" primary={pl.title} />
                  ))}
                </Group>
              ) : null}

              {results.deals.length > 0 ? (
                <Group label={t("groups.deals")}>
                  {results.deals.map((d) => (
                    <Row key={d.id} href={d.url} onNavigate={() => setOpen(false)} icon="tag" primary={d.title} secondary={d.merchant ?? undefined} />
                  ))}
                </Group>
              ) : null}

              <button type="button" className={styles.seeAll} onClick={goToResults}>
                {t("seeAll", { q: q.trim() })} <span aria-hidden>→</span>
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.group}>
      <div className={styles.groupLabel}>{label}</div>
      {children}
    </div>
  );
}

function Row({
  href,
  onNavigate,
  icon,
  primary,
  secondary,
  avatarUrl,
}: {
  href: string;
  onNavigate: () => void;
  icon: "person" | "place" | "event" | "landmark" | "shop" | "plan" | "tag";
  primary: string;
  secondary?: string | undefined;
  avatarUrl?: string | null;
}) {
  return (
    <Link href={href} className={styles.row} onClick={onNavigate}>
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- tiny avatar in a dropdown row
        <img src={avatarUrl} alt="" className={styles.avatar} />
      ) : (
        <span aria-hidden className={styles.rowIcon}><Icon name={icon} size={15} /></span>
      )}
      <span className={styles.rowText}>
        <span className={styles.primary}>{primary}</span>
        {secondary ? <span className={styles.secondary}>{secondary}</span> : null}
      </span>
    </Link>
  );
}
