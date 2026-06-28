/**
 * Saved places — the user's pinned localities (Darlington, Yarm, Westminster…), persisted
 * per-device in localStorage.
 *
 * WHY localStorage (not the DB): choosing where to browse is part of the "browse freely, auth
 * on action" contract — it must work signed-out, with no round-trip. localStorage gives that
 * immediately and survives reloads. If we later want saved places to follow an account across
 * devices, this hook is the single seam to swap for a tRPC-backed store; the PlaceSwitcher
 * contract (saved / toggle / remove) stays the same.
 *
 * SSR-safe: the store reads only after mount (localStorage doesn't exist on the server), so
 * the first render is empty and hydration-stable.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { Place } from "../components/PlaceSwitcher";

const STORAGE_KEY = "roam:saved-places";

/** Parse the persisted list defensively — never trust localStorage to hold valid Places. */
function readStored(): Place[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is Place =>
        !!p &&
        typeof (p as Place).id === "string" &&
        typeof (p as Place).name === "string" &&
        typeof (p as Place).lat === "number" &&
        typeof (p as Place).lng === "number",
    );
  } catch {
    return [];
  }
}

function write(list: Place[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* private mode / quota — saving is best-effort, never throws into the UI */
  }
}

export interface SavedPlacesStore {
  saved: Place[];
  isSaved: (id: string) => boolean;
  /** Add the place if absent, remove it if already saved (by id). */
  toggle: (place: Place) => void;
  remove: (id: string) => void;
}

export function useSavedPlaces(): SavedPlacesStore {
  const [saved, setSaved] = useState<Place[]>([]);

  // Load after mount (client-only). Also sync across tabs/windows.
  useEffect(() => {
    setSaved(readStored());
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setSaved(readStored());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const isSaved = useCallback((id: string) => saved.some((p) => p.id === id), [saved]);

  const toggle = useCallback((place: Place) => {
    setSaved((prev) => {
      const next = prev.some((p) => p.id === place.id)
        ? prev.filter((p) => p.id !== place.id)
        : [...prev, place];
      write(next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setSaved((prev) => {
      const next = prev.filter((p) => p.id !== id);
      write(next);
      return next;
    });
  }, []);

  return { saved, isSaved, toggle, remove };
}
