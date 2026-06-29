/**
 * PlaceSwitcher — the live place selector that re-roots Explore.
 *
 * Re-roots Explore by feeding `venues.near` a chosen centre (lat/lng). Three ways to choose:
 *   1. SEARCH — type a town or postcode; geocoded server-side via geo.search (Nominatim,
 *      debounced + cached). Pick a result to browse there.
 *   2. SAVED — pin localities (Darlington, Yarm, Westminster…) kept per-device (localStorage,
 *      via useSavedPlaces) so they're one tap away. Save the current place, or any result.
 *   3. SUGGESTED / geolocation — the built-in seed centres, plus "Use my location".
 *
 * `PLACES` / `DEFAULT_PLACE` remain exported (MeetupPanel consumes them) — they're now the
 * "suggested" set rather than the only set.
 */
"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTrpc } from "./TrpcProvider";
import { useSavedPlaces } from "../lib/savedPlaces";
import styles from "./PlaceSwitcher.module.css";

/** Small filled location pin — crisper than an ambiguous dot for the location chip. */
function PinIcon() {
  return (
    <span className={styles.pin} aria-hidden>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" />
      </svg>
    </span>
  );
}

export interface Place {
  id: string;
  name: string;
  /** Sublabel under the name in the menu (region / hint). */
  hint?: string;
  lat: number;
  lng: number;
}

/**
 * Suggested place centres covering the seeded venues. Search + saved places extend this; it
 * is no longer the only way to choose a place. (When a places table exists these become rows.)
 */
export const PLACES: readonly Place[] = [
  { id: "darlington", name: "Darlington", hint: "County Durham", lat: 54.5253, lng: -1.5536 },
  { id: "stockton", name: "Stockton-on-Tees", hint: "County Durham", lat: 54.5705, lng: -1.311 },
] as const;

/** The default place when none is chosen — Darlington, the seed's centre of gravity. */
export const DEFAULT_PLACE: Place = PLACES[0]!;

export interface PlaceSwitcherProps {
  value: Place;
  onChange: (place: Place) => void;
}

/* ── shared row styles (hoisted) ─────────────────────────────────────────────── */
const rowBase: CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  flex: 1,
  minWidth: 0,
  boxSizing: "border-box",
  padding: "9px 11px",
  borderRadius: "var(--r-sm)",
};
const sectionLabel: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--muted)",
  padding: "6px 11px 2px",
};
const nameText = (active: boolean): CSSProperties => ({
  fontFamily: "var(--ui)",
  fontSize: 14,
  fontWeight: 600,
  color: active ? "var(--crimson-700)" : "var(--ink-hi)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
const hintText: CSSProperties = {
  fontFamily: "var(--ui)",
  fontSize: 12,
  color: "var(--muted)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const iconBtn: CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "grid",
  placeItems: "center",
  width: 30,
  height: 30,
  borderRadius: "var(--r-sm)",
  fontSize: 15,
  flexShrink: 0,
};

/** A selectable place row + an optional trailing action (save star / remove ✕). */
function PlaceRow({
  place,
  active,
  onSelect,
  trailing,
}: {
  place: Place;
  active: boolean;
  onSelect: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        borderRadius: "var(--r-sm)",
        background: active ? "var(--crimson-tint)" : "transparent",
      }}
    >
      <button role="option" aria-selected={active} onClick={onSelect} style={rowBase}>
        <span style={nameText(active)}>{place.name}</span>
        {place.hint ? <span style={hintText}>{place.hint}</span> : null}
      </button>
      {trailing}
    </div>
  );
}

export function PlaceSwitcher({ value, onChange }: PlaceSwitcherProps) {
  const trpc = useTrpc();
  const { saved, isSaved, toggle, remove } = useSavedPlaces();
  const [open, setOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  // Search state.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reqIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus the search field when the popover opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Debounced geocode. Each keystroke bumps a generation id so a slow earlier response can't
  // overwrite a newer one; queries under 2 chars clear the results.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    const id = ++reqIdRef.current;
    const search = trpc.geo.search as unknown as {
      query: (input: { q: string }) => Promise<Place[]>;
    };
    const t = setTimeout(() => {
      search
        .query({ q })
        .then((res) => {
          if (!mountedRef.current || reqIdRef.current !== id) return;
          setResults(res ?? []);
          setSearching(false);
        })
        .catch(() => {
          if (!mountedRef.current || reqIdRef.current !== id) return;
          setSearchError("Couldn't search just now. Try again.");
          setSearching(false);
        });
    }, 350);
    return () => clearTimeout(t);
  }, [query, trpc]);

  function pick(place: Place) {
    onChange(place);
    setOpen(false);
    setQuery("");
    setResults(null);
  }

  const supportsGeo = typeof navigator !== "undefined" && "geolocation" in navigator;

  function handleUseMyLocation() {
    if (!supportsGeo) return;
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!mountedRef.current) return;
        setLocating(false);
        pick({
          id: "my-location",
          name: "Near me",
          hint: "Your location",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
      },
      () => {
        if (!mountedRef.current) return;
        setLocating(false);
        setGeoError("Couldn't get your location. Pick a place instead.");
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  }

  const star = (place: Place) => (
    <button
      type="button"
      aria-label={isSaved(place.id) ? `Unsave ${place.name}` : `Save ${place.name}`}
      title={isSaved(place.id) ? "Saved" : "Save this place"}
      onClick={(e) => {
        e.stopPropagation();
        toggle(place);
      }}
      style={{ ...iconBtn, color: isSaved(place.id) ? "var(--gold)" : "var(--faint)" }}
    >
      {isSaved(place.id) ? "★" : "☆"}
    </button>
  );

  const searchMode = query.trim().length >= 2;
  const suggested = PLACES.filter((p) => !saved.some((s) => s.id === p.id));

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Browsing ${value.name} — change place`}
        className={styles.trigger}
      >
        <PinIcon />
        <span className={styles.label}>{value.name}</span>
        <span className={`${styles.caret} ${open ? styles.caretOpen : ""}`} aria-hidden>▾</span>
      </button>

      {open ? (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            insetInlineStart: 0,
            width: 300,
            maxWidth: "calc(100vw - 32px)",
            background: "#fff",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-md)",
            boxShadow: "var(--shadow-pop)",
            padding: "var(--space-2)",
            zIndex: 20,
          }}
        >
          {/* search */}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search town or postcode…"
            aria-label="Search for a place"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "10px 12px",
              marginBottom: "var(--space-2)",
              background: "var(--paper-2)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-full)",
              fontFamily: "var(--ui)",
              fontSize: 16, // ≥16px so iOS Safari doesn't zoom on focus
              color: "var(--ink)",
              outline: "none",
            }}
          />

          {searchMode ? (
            /* ── search results ── */
            searching ? (
              <div style={{ ...sectionLabel, textTransform: "none", padding: "8px 11px" }}>Searching…</div>
            ) : searchError ? (
              <div style={{ ...hintText, color: "var(--crimson-700)", padding: "6px 11px" }} role="alert">
                {searchError}
              </div>
            ) : results && results.length > 0 ? (
              results.map((p) => (
                <PlaceRow key={p.id} place={p} active={false} onSelect={() => pick(p)} trailing={star(p)} />
              ))
            ) : (
              <div style={{ ...hintText, padding: "8px 11px" }}>No matches for “{query.trim()}”.</div>
            )
          ) : (
            /* ── saved · suggested · locate ── */
            <>
              {/* Save the current place (when it isn't already saved). */}
              {!isSaved(value.id) ? (
                <button
                  type="button"
                  onClick={() => toggle(value)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px 11px",
                    borderRadius: "var(--r-sm)",
                    fontFamily: "var(--ui)",
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--ink-2)",
                  }}
                >
                  <span aria-hidden style={{ color: "var(--faint)", fontSize: 15 }}>☆</span>
                  Save “{value.name}”
                </button>
              ) : null}

              {saved.length > 0 ? (
                <>
                  <div style={sectionLabel}>Saved</div>
                  {saved.map((p) => (
                    <PlaceRow
                      key={p.id}
                      place={p}
                      active={p.id === value.id}
                      onSelect={() => pick(p)}
                      trailing={
                        <button
                          type="button"
                          aria-label={`Remove ${p.name}`}
                          title="Remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            remove(p.id);
                          }}
                          style={{ ...iconBtn, color: "var(--faint)" }}
                        >
                          ✕
                        </button>
                      }
                    />
                  ))}
                </>
              ) : null}

              {suggested.length > 0 ? (
                <>
                  <div style={sectionLabel}>Suggested</div>
                  {suggested.map((p) => (
                    <PlaceRow
                      key={p.id}
                      place={p}
                      active={p.id === value.id}
                      onSelect={() => pick(p)}
                      trailing={star(p)}
                    />
                  ))}
                </>
              ) : null}

              {supportsGeo ? (
                <>
                  <div style={{ height: 1, background: "var(--line)", margin: "var(--space-2) 0" }} />
                  <button
                    onClick={handleUseMyLocation}
                    disabled={locating}
                    style={{
                      all: "unset",
                      cursor: locating ? "default" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "9px 11px",
                      borderRadius: "var(--r-sm)",
                      fontFamily: "var(--ui)",
                      fontSize: 14,
                      fontWeight: 600,
                      color: "var(--ink-hi)",
                    }}
                  >
                    <span aria-hidden style={{ color: "var(--crimson)" }}>◎</span>
                    {locating ? "Locating…" : "Use my location"}
                  </button>
                  {geoError ? (
                    <div
                      style={{ fontFamily: "var(--ui)", fontSize: 12, color: "var(--crimson-700)", padding: "0 11px 6px" }}
                      role="alert"
                    >
                      {geoError}
                    </div>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
