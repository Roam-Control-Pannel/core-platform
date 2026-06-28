/**
 * Current place — the place the user is browsing, persisted per-device so it FOLLOWS them
 * between surfaces (Explore ↔ Town Hall) and survives a reload. Without this, each route's
 * own `useState(DEFAULT_PLACE)` would reset to Darlington on every navigation, and a
 * per-locality Town Hall would never agree with the Explore you just came from.
 *
 * WHY localStorage (not the DB): choosing where to browse is part of the "browse freely, auth
 * on action" contract — it must work signed-out with no round-trip. Same rationale and storage
 * idiom as useSavedPlaces; this is the single ACTIVE place, that hook is the saved SET.
 *
 * SSR-safe: reads only after mount (localStorage doesn't exist on the server), so the first
 * render is the default and hydration-stable; the stored value lands on the next tick.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PLACE, type Place } from "../components/PlaceSwitcher";

const STORAGE_KEY = "roam:current-place";

function readStored(): Place | null {
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

function write(place: Place): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(place));
  } catch {
    /* private mode / quota — best-effort, never throws into the UI */
  }
}

export interface CurrentPlaceStore {
  place: Place;
  setPlace: (place: Place) => void;
}

export function useCurrentPlace(): CurrentPlaceStore {
  const [place, setPlaceState] = useState<Place>(DEFAULT_PLACE);

  // Hydrate after mount; also sync if another tab changes the active place.
  useEffect(() => {
    const stored = readStored();
    if (stored) setPlaceState(stored);
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        const next = readStored();
        if (next) setPlaceState(next);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPlace = useCallback((next: Place) => {
    setPlaceState(next);
    write(next);
  }, []);

  return { place, setPlace };
}
