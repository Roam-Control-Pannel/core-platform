/**
 * Storefront place — the place the Food to Go storefront is centred on, kept SEPARATE from Roam's
 * shared current-place (lib/currentPlace).
 *
 * Why separate: the storefront is fenced to Northern Ireland, but Roam's current-place roams the
 * whole UK. Sharing one store let a London/England centre chosen while browsing Roam bleed onto
 * the storefront (the "FOOD TO GO NEAR CITY OF LONDON" bug). This store has its own key, defaults
 * to Belfast, and CLAMPS any out-of-NI value back to the default — so the storefront can only ever
 * be centred inside Northern Ireland, and choosing a storefront town never moves Roam's Explore.
 *
 * Same device-local, signed-out-friendly, SSR-safe idiom as useCurrentPlace: localStorage is the
 * store, a same-tab event keeps hook instances in sync, and the first render is the default.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { Place } from "../components/PlaceSwitcher";
import { NI_DEFAULT_PLACE, isInNI } from "./ni";

const STORAGE_KEY = "f2g:current-place";

/** Fired on window after every local write (storage events don't fire in the writing tab). */
const CHANGE_EVENT = "f2g:current-place-changed";

/** Read the stored storefront place, but only if it's valid AND inside Northern Ireland. */
function readStorefrontPlace(): Place | null {
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
      typeof p.lng === "number" &&
      isInNI(p.lat, p.lng)
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
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export interface StorefrontPlaceStore {
  place: Place;
  setPlace: (place: Place) => void;
}

export function useStorefrontPlace(): StorefrontPlaceStore {
  const [place, setPlaceState] = useState<Place>(NI_DEFAULT_PLACE);

  useEffect(() => {
    const stored = readStorefrontPlace();
    if (stored) setPlaceState(stored);
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        const next = readStorefrontPlace();
        if (next) setPlaceState(next);
      }
    }
    function onLocal() {
      const next = readStorefrontPlace();
      if (next) setPlaceState(next);
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, onLocal);
    };
  }, []);

  const setPlace = useCallback((next: Place) => {
    // Belt-and-braces: the switcher is NI-fenced, but never let a non-NI centre land here.
    const safe = isInNI(next.lat, next.lng) ? next : NI_DEFAULT_PLACE;
    setPlaceState(safe);
    write(safe);
  }, []);

  return { place, setPlace };
}
