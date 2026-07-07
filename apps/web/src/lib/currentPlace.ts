/**
 * Current place — the place the user is browsing, persisted per-device so it FOLLOWS them
 * between surfaces (Explore ↔ Town Hall) and survives a reload. Without this, each route's
 * own `useState(DEFAULT_PLACE)` would reset to Darlington on every navigation, and a
 * per-locality Town Hall would never agree with the Explore you just came from.
 *
 * WHY localStorage stays the primary store: choosing where to browse is part of the "browse
 * freely, auth on action" contract — it must work signed-out with no round-trip. Same storage
 * idiom as useSavedPlaces; this is the single ACTIVE place, that hook is the saved SET.
 *
 * Cross-device: for signed-in users the sync engine (PlacePrefsSync) mirrors this value up to
 * profiles.place_prefs.last, and SEEDS a brand-new device from it — but only when the device
 * has no local choice yet (hasStoredPlace). An actively-used device is never yanked to another
 * device's town mid-browse.
 *
 * Same-tab consistency: every write dispatches CHANGE_EVENT so other hook instances in this
 * tab (and the sync engine) see the change immediately — the native `storage` event only
 * fires in other tabs.
 *
 * SSR-safe: reads only after mount (localStorage doesn't exist on the server), so the first
 * render is the default and hydration-stable; the stored value lands on the next tick.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PLACE, type Place } from "../components/PlaceSwitcher";

const STORAGE_KEY = "roam:current-place";

/** Fired on window after every local write (storage events don't fire in the writing tab). */
export const CURRENT_PLACE_EVENT = "roam:current-place-changed";

export function readCurrentPlace(): Place | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Place;
    if (
      p &&
      typeof p.id === "string" &&
      typeof p.name === "string" &&
      typeof p.lat === "number" &&
      typeof p.lng === "number"
    ) {
      return p;
    }
    return null;
  } catch {
    return null;
  }
}

/** Whether this device has an explicit local choice (drives the seed-new-devices-only rule). */
export function hasStoredPlace(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) != null;
  } catch {
    return false;
  }
}

function write(place: Place): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(place));
  } catch {
    /* private mode / quota — best-effort, never throws into the UI */
  }
  window.dispatchEvent(new Event(CURRENT_PLACE_EVENT));
}

/** Land a server-seeded place locally (PlacePrefsSync) — same write path, so hooks update. */
export function applyCurrentPlace(place: Place): void {
  write(place);
}

export interface CurrentPlaceStore {
  place: Place;
  setPlace: (place: Place) => void;
}

export function useCurrentPlace(): CurrentPlaceStore {
  const [place, setPlaceState] = useState<Place>(DEFAULT_PLACE);

  // Hydrate after mount. Stay in sync with other tabs (storage) AND other hook instances /
  // the server-sync engine in this tab (CURRENT_PLACE_EVENT).
  useEffect(() => {
    const stored = readCurrentPlace();
    if (stored) setPlaceState(stored);
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        const next = readCurrentPlace();
        if (next) setPlaceState(next);
      }
    }
    function onLocal() {
      const next = readCurrentPlace();
      if (next) setPlaceState(next);
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener(CURRENT_PLACE_EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CURRENT_PLACE_EVENT, onLocal);
    };
  }, []);

  const setPlace = useCallback((next: Place) => {
    setPlaceState(next);
    write(next);
  }, []);

  return { place, setPlace };
}
