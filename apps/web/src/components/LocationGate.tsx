/**
 * LocationGate — first-visit location handling, mounted once in the root layout (inside
 * TrpcProvider). Three jobs, all non-blocking (Roam's browse-freely ethos):
 *
 *  1. Cold-start default (permission-free): a SIGNED-OUT visitor with no local place choice opens
 *     Explore near where they are, from the coarse /api/geo IP guess — instead of a hard-coded
 *     town. Signed-in users are left to PlacePrefsSync (their saved/last place wins); a returning
 *     device with a stored choice is never overridden.
 *
 *  2. First-run chooser (zero signal): when the IP guess yields NOTHING (local dev, a host with no
 *     geo headers, an un-geolocatable IP) we must not silently assert a town — a visitor in Atlanta
 *     should never be told their location is Belfast. So instead of falling back to a hard-coded
 *     default, we show a neutral "where would you like to explore?" chooser: share precise location,
 *     or search any town/city worldwide. Prominent but dismissible — skipping asserts nothing and
 *     persists nothing (the in-memory default renders and the contextual card keeps nudging).
 *
 *  3. Contextual precise-location card: while we're only GUESSING the place (source "detected" or
 *     "default") — i.e. an IP guess landed but isn't a deliberate choice — a small dismissible card
 *     invites the visitor to share precise location. Shown at most once per device.
 *
 * Renders the chooser (2) and the card (3); job (1) renders nothing.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@roam/design";
import { useSession, useTrpc } from "./TrpcProvider";
import { useCurrentPlace, hasStoredPlace } from "../lib/currentPlace";
import { detectPlaceFromIp } from "../lib/detectPlace";
import type { Place } from "./PlaceSwitcher";
import styles from "./LocationGate.module.css";

const SNOOZE_KEY = "roam:locationPrompt:snooze";
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

type SearchResult = { id: string; name: string; hint?: string; lat: number; lng: number };
type PlaceSearch = { query: (i: { q: string }) => Promise<SearchResult[]> };

export function LocationGate() {
  const t = useTranslations("locationGate");
  const session = useSession();
  const trpc = useTrpc();
  const { place, setPlace } = useCurrentPlace();
  const [show, setShow] = useState(false);
  const [locating, setLocating] = useState(false);
  // The zero-signal first-run chooser (job 2). Distinct from the contextual card (job 3).
  const [needsLocation, setNeedsLocation] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const bootstrapped = useRef(false);
  // Latest session, read at apply-time. `session` is null on first render for EVERYONE (it
  // populates after getSession resolves), so we can't trust it synchronously — but getSession
  // (a localStorage read) resolves before the /api/geo fetch, so by apply-time this is accurate.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // (1)+(2) Cold-start — fresh, signed-out device with no local choice.
  useEffect(() => {
    if (bootstrapped.current || hasStoredPlace()) return;
    bootstrapped.current = true;
    detectPlaceFromIp()
      .then((p) => {
        // Only act on a still-fresh signed-out device: no session appeared and no choice was made
        // while /api/geo was in flight (signed-in users get their place via PlacePrefsSync).
        if (sessionRef.current || hasStoredPlace()) return;
        if (p) {
          // (1) We know roughly where they are — open there.
          setPlace(p);
        } else {
          // (2) Zero signal — ask rather than assert a town.
          setNeedsLocation(true);
        }
      })
      .catch(() => {
        // Fetch failed outright (offline / off-platform) — still ask rather than assert a town.
        if (!sessionRef.current && !hasStoredPlace()) setNeedsLocation(true);
      });
  }, [setPlace]);

  // (3) Contextual card — only while we're GUESSING the place (no deliberate choice), geolocation is
  // available, and the first-run chooser (2) is NOT up (they're mutually exclusive).
  const guessing = !place.source || place.source === "default" || place.source === "detected";
  useEffect(() => {
    if (needsLocation) return;
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return;
    if (!guessing) return;
    try {
      const until = Number(localStorage.getItem(SNOOZE_KEY) ?? "0");
      if (until && Date.now() < until) return;
    } catch {
      /* private mode — just show it */
    }
    setShow(true);
  }, [guessing, needsLocation]);

  // First-run chooser search — worldwide (unfenced) geocode, debounced. Mirrors the PlaceSwitcher
  // search contract, but purpose-built here so the chooser never has to render a trigger labelled
  // with a town we haven't earned the right to assert.
  useEffect(() => {
    if (!needsLocation) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      (trpc.geo.search as unknown as PlaceSearch)
        .query({ q })
        .then((rows) => {
          if (!cancelled) {
            setResults(rows);
            setSearching(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResults([]);
            setSearching(false);
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, needsLocation, trpc]);

  const snooze = useCallback(() => {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    } catch {
      /* private mode */
    }
    setShow(false);
  }, []);

  const useMyLocation = useCallback(() => {
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setPlace({
          id: "my-location",
          name: t("nearMe"),
          hint: t("yourLocation"),
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          source: "current",
        });
        setNeedsLocation(false);
        snooze();
      },
      () => {
        // Denied or failed — don't nag again this device. If this was the first-run chooser, leave
        // it up so they can still search a place instead (we assert nothing on their behalf).
        setLocating(false);
        if (!needsLocation) snooze();
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  }, [t, setPlace, snooze, needsLocation]);

  // A searched place is a DELIBERATE choice (source "search") — it clears the chooser and, in
  // Explore, is allowed to pull fresh coverage for a cold area.
  const pickSearched = useCallback(
    (r: SearchResult) => {
      const chosen: Place = { ...r, source: "search" };
      setPlace(chosen);
      setNeedsLocation(false);
    },
    [setPlace],
  );

  const skipChooser = useCallback(() => {
    // Assert nothing: don't persist a place. The in-memory default renders and the contextual card
    // (job 3) will still gently nudge for precise location.
    setNeedsLocation(false);
  }, []);

  // ── (2) First-run chooser: a prominent, dismissible scrim. Asserts no town. ──
  if (needsLocation) {
    const q = query.trim();
    return (
      <div className={styles.scrim} role="dialog" aria-modal="false" aria-label={t("chooseTitle")}>
        <div className={styles.dialog}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)" }}>
            <span
              aria-hidden
              style={{ width: 38, height: 38, flexShrink: 0, borderRadius: 12, background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center" }}
            >
              <Icon name="locate" size={20} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 16, lineHeight: 1.3 }}>{t("chooseTitle")}</div>
              <div style={{ fontSize: 13.5, color: "var(--muted)", marginTop: 3, lineHeight: 1.4 }}>{t("chooseBody")}</div>
            </div>
          </div>

          <Button variant="pri" size="md" onClick={useMyLocation} disabled={locating}>
            {locating ? t("locating") : t("allow")}
          </Button>

          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", color: "var(--muted)", fontSize: 12 }}>
            <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
            {t("chooseOr")}
            <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
          </div>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("chooseSearchPlaceholder")}
            aria-label={t("chooseSearchPlaceholder")}
            autoComplete="off"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "11px 13px",
              background: "var(--paper-2)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-full)",
              fontFamily: "var(--ui)",
              fontSize: 16, // ≥16px so iOS Safari doesn't zoom on focus
              color: "var(--ink)",
              outline: "none",
            }}
          />

          {q.length >= 2 ? (
            <div className={styles.results} role="listbox" aria-label={t("chooseTitle")}>
              {searching ? (
                <div style={{ fontSize: 13, color: "var(--muted)", padding: "8px 4px" }}>{t("chooseSearching")}</div>
              ) : results && results.length > 0 ? (
                results.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => pickSearched(r)}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "9px 11px",
                      borderRadius: "var(--r-sm)",
                    }}
                  >
                    <span style={{ fontFamily: "var(--ui)", fontSize: 14, fontWeight: 600, color: "var(--ink-hi)" }}>{r.name}</span>
                    {r.hint ? <span style={{ fontFamily: "var(--ui)", fontSize: 12, color: "var(--muted)" }}>{r.hint}</span> : null}
                  </button>
                ))
              ) : (
                <div style={{ fontSize: 13, color: "var(--muted)", padding: "8px 4px" }}>{t("chooseNoResults", { query: q })}</div>
              )}
            </div>
          ) : null}

          <button
            type="button"
            onClick={skipChooser}
            style={{ all: "unset", cursor: "pointer", textAlign: "center", fontSize: 13, fontWeight: 600, color: "var(--muted)", padding: "6px 10px" }}
          >
            {t("chooseSkip")}
          </button>
        </div>
      </div>
    );
  }

  // ── (3) Contextual precise-location card ──
  if (!show) return null;

  return (
    <div className={styles.wrap}>
      <div className={styles.inner}>
      <div role="dialog" aria-label={t("title")} className={styles.card}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)" }}>
          <span
            aria-hidden
            style={{ width: 38, height: 38, flexShrink: 0, borderRadius: 12, background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center" }}
          >
            <Icon name="locate" size={20} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5, lineHeight: 1.3 }}>{t("title")}</div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2, lineHeight: 1.4 }}>{t("body")}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <button
            type="button"
            onClick={snooze}
            style={{ all: "unset", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--muted)", padding: "8px 10px" }}
          >
            {t("dismiss")}
          </button>
          <Button variant="pri" size="sm" onClick={useMyLocation} disabled={locating}>
            {locating ? t("locating") : t("allow")}
          </Button>
        </div>
      </div>
      </div>
    </div>
  );
}
