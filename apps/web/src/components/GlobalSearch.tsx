/**
 * GlobalSearch — the site-wide search bar in the TopBar (persistent on every page). Debounced
 * typeahead over search.global: grouped results as you type (People · Places · Events · Community ·
 * Marketplace · Plans · Deals), Enter / "See all" → /search. Local-first (passes the current place's
 * lat/lng). Before you type it offers your Recent searches. Full keyboard nav: ↑/↓ move the
 * highlight through the rows (and the "see all" action), Enter activates it, Escape closes.
 *
 * Stale responses are dropped (a seq guard); the dropdown closes on outside-click / Escape / nav.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Icon, type IconName } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { useCurrentPlace } from "../lib/currentPlace";
import { useRecentSearches } from "../lib/recentSearches";
import { formatEventWhen } from "../lib/events";
import { EMPTY_RESULTS, totalCount, listingPrice, distanceLabel, type SearchResultsData } from "../lib/searchResult";
import styles from "./GlobalSearch.module.css";

interface RowData {
  key: string;
  icon: IconName;
  primary: string;
  secondary?: string | undefined;
  avatarUrl?: string | null;
  url: string;
  onRemove?: (() => void) | undefined;
}
interface SectionData {
  label: string;
  rows: RowData[];
}

export function GlobalSearch() {
  const t = useTranslations("chrome.search");
  const trpc = useTrpc();
  const router = useRouter();
  const { place } = useCurrentPlace();
  const { recent, add: addRecent, remove: removeRecent, clear: clearRecent } = useRecentSearches();

  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResultsData>(EMPTY_RESULTS);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const seq = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const term = q.trim();
  const isResultsMode = term.length >= 2;

  // Debounced fan-out; a seq guard drops out-of-order (stale) responses.
  useEffect(() => {
    if (!isResultsMode) {
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
        .then((r) => { if (mine === seq.current) { setResults(r); setLoading(false); } })
        .catch(() => { if (mine === seq.current) setLoading(false); });
    }, 250);
    return () => clearTimeout(timer);
  }, [term, isResultsMode, trpc, place.lat, place.lng]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Build the dropdown's sections: recent searches before you type, grouped results after.
  const sections: SectionData[] = useMemo(() => {
    if (!isResultsMode) {
      if (recent.length === 0) return [];
      return [
        {
          label: t("recent"),
          rows: recent.map((r) => ({
            key: `recent:${r}`,
            icon: "clock" as IconName,
            primary: r,
            url: `/search?q=${encodeURIComponent(r)}`,
            onRemove: () => removeRecent(r),
          })),
        },
      ];
    }
    const s: SectionData[] = [];
    if (results.people.length) s.push({ label: t("groups.people"), rows: results.people.map((p) => ({ key: p.id, icon: "person", primary: p.name, secondary: p.handle ? `@${p.handle}` : undefined, avatarUrl: p.avatarUrl, url: p.url })) });
    if (results.venues.length) s.push({ label: t("groups.places"), rows: results.venues.map((v) => ({ key: v.id, icon: "place", primary: v.name, secondary: [v.category, distanceLabel(v.distanceM)].filter(Boolean).join(" · ") || undefined, url: v.url })) });
    if (results.events.length) s.push({ label: t("groups.events"), rows: results.events.map((e) => ({ key: e.id, icon: "event", primary: e.title, secondary: `${formatEventWhen(e.startsAt, null)} · ${e.localityLabel}`, url: e.url })) });
    if (results.topics.length) s.push({ label: t("groups.community"), rows: results.topics.map((tp) => ({ key: tp.id, icon: "landmark", primary: tp.title, secondary: tp.localityLabel, url: tp.url })) });
    if (results.listings.length) s.push({ label: t("groups.marketplace"), rows: results.listings.map((l) => ({ key: l.id, icon: "shop", primary: l.title, secondary: [listingPrice(l.pricePence, l.mode), l.locality].filter(Boolean).join(" · "), url: l.url })) });
    if (results.plans.length) s.push({ label: t("groups.plans"), rows: results.plans.map((pl) => ({ key: pl.id, icon: "plan", primary: pl.title, url: pl.url })) });
    if (results.offers.length) s.push({ label: t("groups.offers"), rows: results.offers.map((of) => ({ key: of.id, icon: "redeem", primary: of.title, secondary: [of.venueName, of.locality].filter(Boolean).join(" · ") || undefined, url: of.url })) });
    if (results.deals.length) s.push({ label: t("groups.deals"), rows: results.deals.map((d) => ({ key: d.id, icon: "tag", primary: d.title, secondary: d.merchant ?? undefined, url: d.url })) });
    return s;
  }, [isResultsMode, recent, results, t, removeRecent]);

  const flatRows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const total = totalCount(results);
  const hasSeeAll = isResultsMode && total > 0;
  const navCount = flatRows.length + (hasSeeAll ? 1 : 0);

  // Reset the highlight whenever what's shown changes.
  useEffect(() => { setActive(-1); }, [term, flatRows.length]);

  const goToResults = useCallback(() => {
    if (term.length < 2) return;
    addRecent(term);
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(term)}`);
  }, [term, addRecent, router]);

  const activate = useCallback(
    (row: RowData) => {
      if (isResultsMode) addRecent(term);
      else addRecent(row.primary); // a recent row: bump it to the top
      setOpen(false);
      router.push(row.url);
    },
    [isResultsMode, term, addRecent, router],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
        setActive((i) => Math.min(i + 1, navCount - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, -1));
      } else if (e.key === "Enter") {
        if (active >= 0 && active < flatRows.length) activate(flatRows[active]!);
        else goToResults();
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    },
    [navCount, active, flatRows, activate, goToResults],
  );

  const showDropdown = open && (isResultsMode || recent.length > 0);
  let idx = -1; // running flat index while rendering

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
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls="global-search-dropdown"
        />
      </div>

      {showDropdown ? (
        <div id="global-search-dropdown" className={styles.dropdown} role="listbox">
          {isResultsMode && loading && total === 0 ? (
            <div className={styles.hint}>{t("searching")}</div>
          ) : isResultsMode && total === 0 ? (
            <div className={styles.hint}>{t("noResults", { q: term })}</div>
          ) : (
            <>
              {sections.map((s) => (
                <div key={s.label} className={styles.group}>
                  <div className={styles.groupHead}>
                    <span className={styles.groupLabel}>{s.label}</span>
                    {!isResultsMode ? (
                      <button type="button" className={styles.clear} onClick={() => clearRecent()}>{t("clear")}</button>
                    ) : null}
                  </div>
                  {s.rows.map((row) => {
                    idx += 1;
                    const rowIndex = idx;
                    return (
                      <Row
                        key={row.key}
                        row={row}
                        active={rowIndex === active}
                        onActivate={() => activate(row)}
                        onHover={() => setActive(rowIndex)}
                      />
                    );
                  })}
                </div>
              ))}

              {hasSeeAll ? (
                <button
                  type="button"
                  className={`${styles.seeAll} ${active === flatRows.length ? styles.seeAllActive : ""}`}
                  onMouseEnter={() => setActive(flatRows.length)}
                  onClick={goToResults}
                >
                  {t("seeAll", { q: term })} <span aria-hidden>→</span>
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Row({
  row,
  active,
  onActivate,
  onHover,
}: {
  row: RowData;
  active: boolean;
  onActivate: () => void;
  onHover: () => void;
}) {
  return (
    <Link
      href={row.url}
      role="option"
      aria-selected={active}
      className={`${styles.row} ${active ? styles.rowActive : ""}`}
      onClick={onActivate}
      onMouseEnter={onHover}
    >
      {row.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- tiny avatar in a dropdown row
        <img src={row.avatarUrl} alt="" className={styles.avatar} />
      ) : (
        <span aria-hidden className={styles.rowIcon}><Icon name={row.icon} size={15} /></span>
      )}
      <span className={styles.rowText}>
        <span className={styles.primary}>{row.primary}</span>
        {row.secondary ? <span className={styles.secondary}>{row.secondary}</span> : null}
      </span>
      {row.onRemove ? (
        <button
          type="button"
          className={styles.remove}
          aria-label="Remove"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); row.onRemove?.(); }}
        >
          <Icon name="close" size={13} />
        </button>
      ) : null}
    </Link>
  );
}
