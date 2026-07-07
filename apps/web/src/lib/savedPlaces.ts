/**
 * Saved places — the user's pinned localities (Darlington, Yarm, Westminster…), persisted
 * per-device in localStorage and, for signed-in users, synced cross-device via
 * profiles.place_prefs (see PlacePrefsSync).
 *
 * WHY localStorage stays the primary store: choosing where to browse is part of the "browse
 * freely, auth on action" contract — it must work signed-out, with no round-trip. localStorage
 * gives that immediately and survives reloads; the server sync layers on top for accounts
 * (server wins on load, edits push up), so pins follow a signed-in user across devices.
 *
 * Same-tab consistency: every write dispatches CHANGE_EVENT so OTHER hook instances in the
 * same tab (and the sync engine) see the edit immediately — the native `storage` event only
 * fires in other tabs. readSavedPlaces/applySavedPlaces are the module-level seam the sync
 * engine uses to read local state and to land server state.
 *
 * SSR-safe: the store reads only after mount (localStorage doesn't exist on the server), so
 * the first render is empty and hydration-stable.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { Place } from "../components/PlaceSwitcher";

const STORAGE_KEY = "roam:saved-places";

/** Fired on window after every local write (storage events don't fire in the writing tab). */
export const SAVED_PLACES_EVENT = "roam:saved-places-changed";

/** Parse the persisted list defensively — never trust localStorage to hold valid Places. */
export function readSavedPlaces(): Place[] {
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
  window.dispatchEvent(new Event(SAVED_PLACES_EVENT));
}

/** Land a server-synced list locally (PlacePrefsSync) — same write path, so hooks update. */
export function applySavedPlaces(list: Place[]): void {
  write(list);
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

  // Load after mount (client-only). Stay in sync with other tabs (storage) AND other hook
  // instances / the server-sync engine in this tab (SAVED_PLACES_EVENT).
  useEffect(() => {
    setSaved(readSavedPlaces());
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setSaved(readSavedPlaces());
    }
    function onLocal() {
      setSaved(readSavedPlaces());
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener(SAVED_PLACES_EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SAVED_PLACES_EVENT, onLocal);
    };
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
