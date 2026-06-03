/**
 * PlaceSwitcher — the live place selector that re-roots Explore.
 *
 * This is the slice that replaces Explore's HARDCODED Darlington centre with a
 * SELECTED place's centre. `venues.near` already takes lat/lng, so re-rooting is just
 * feeding it the chosen place's coordinates — no API change needed.
 *
 * Scope honesty: there is no `places` table yet (the build plan models locality as a
 * Stage-0 seam but Stage 1 hasn't lit it). So the selectable set here is a small,
 * explicit list of the localities the seed actually covers, plus the natural next step
 * — the user's own geolocation — offered when the browser supports it. When a real
 * places table lands, this component swaps its `PLACES` source for a query and keeps
 * the same onChange contract; Explore doesn't change.
 *
 * Presentation matches the existing Explore place header exactly (the crimson dot +
 * display-font name + caret), now as a real popover control rather than a static label.
 */
"use client";

import { useEffect, useRef, useState } from "react";

export interface Place {
  id: string;
  name: string;
  /** Sublabel under the name in the menu (region / hint). */
  hint?: string;
  lat: number;
  lng: number;
}

/**
 * Known place centres covering the seeded venues. Coordinates are the same locality
 * centres the seed clusters around (Darlington town centre; Stockton-on-Tees). When a
 * places table exists these become rows; the shape and the onChange contract stay.
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

export function PlaceSwitcher({ value, onChange }: PlaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape — a popover that traps focus would be overkill here.
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

  const supportsGeo = typeof navigator !== "undefined" && "geolocation" in navigator;

  function useMyLocation() {
    if (!supportsGeo) return;
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setOpen(false);
        onChange({
          id: "my-location",
          name: "Near me",
          hint: "Your location",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
      },
      () => {
        setLocating(false);
        setGeoError("Couldn't get your location. Pick a place instead.");
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  }

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--space-2)",
          fontFamily: "var(--display)",
          fontWeight: 600,
          fontSize: 20,
          color: "var(--ink-hi)",
        }}
      >
        <span
          aria-hidden
          style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--crimson)" }}
        />
        {value.name}
        <span style={{ color: "var(--muted)", fontSize: 14 }}>▾</span>
      </button>

      {open ? (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            insetInlineStart: 0,
            minWidth: 240,
            background: "#fff",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-md)",
            boxShadow: "var(--shadow-pop)",
            padding: "var(--space-2)",
            zIndex: 20,
          }}
        >
          {PLACES.map((p) => {
            const active = p.id === value.id;
            return (
              <button
                key={p.id}
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(p);
                  setOpen(false);
                }}
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
                  background: active ? "var(--crimson-tint)" : "transparent",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--ui)",
                    fontSize: 14,
                    fontWeight: 600,
                    color: active ? "var(--crimson-700)" : "var(--ink-hi)",
                  }}
                >
                  {p.name}
                </span>
                {p.hint ? (
                  <span style={{ fontFamily: "var(--ui)", fontSize: 12, color: "var(--muted)" }}>
                    {p.hint}
                  </span>
                ) : null}
              </button>
            );
          })}

          {supportsGeo ? (
            <>
              <div style={{ height: 1, background: "var(--line)", margin: "var(--space-2) 0" }} />
              <button
                onClick={useMyLocation}
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
                  style={{
                    fontFamily: "var(--ui)",
                    fontSize: 12,
                    color: "var(--crimson-700)",
                    padding: "0 11px 6px",
                  }}
                  role="alert"
                >
                  {geoError}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
