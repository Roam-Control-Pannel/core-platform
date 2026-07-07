/**
 * PlacePrefsSync — the headless cross-device sync engine for place preferences, mounted ONCE
 * in the root layout (inside TrpcProvider). It bridges the two localStorage place stores
 * (savedPlaces — the pinned set; currentPlace — the active browsing place) to
 * profiles.place_prefs for signed-in users:
 *
 *  LOAD (once per signed-in session):
 *   - Pinned places: server wins — the synced list lands locally (applySavedPlaces), so pins
 *     made on any device show everywhere.
 *   - Current place: SEED-ONLY — the server's `last` place applies only when this device has
 *     no local choice yet (hasStoredPlace() false). An actively-used device is never yanked
 *     to another device's town; a brand-new device starts where you left off elsewhere.
 *   - Guest migration: when the server has nothing and this device has local prefs, they're
 *     pushed up (first sign-in keeps the pins you made signed-out).
 *
 *  SAVE: the stores dispatch window events on every write (same-tab; `storage` covers other
 *  tabs). Edits debounce-save the full { saved, last } snapshot; tab-hide and unmount flush
 *  immediately so an edit made just before leaving still reaches other devices. Failures
 *  reset the synced marker so the next edit retries. Mirrors useHomeLayoutSync throughout.
 *
 * Renders nothing.
 */
"use client";

import { useCallback, useEffect, useRef } from "react";
import { useTrpc, useSession } from "./TrpcProvider";
import type { Place } from "./PlaceSwitcher";
import { readSavedPlaces, applySavedPlaces, SAVED_PLACES_EVENT } from "../lib/savedPlaces";
import {
  readCurrentPlace,
  applyCurrentPlace,
  hasStoredPlace,
  CURRENT_PLACE_EVENT,
} from "../lib/currentPlace";

interface PlacePrefs {
  saved: Place[];
  last: Place | null;
}

/** The exact snapshot we'd save — one serialization is both the payload and the echo guard. */
function serializeLocal(): string {
  return JSON.stringify({ saved: readSavedPlaces(), last: readCurrentPlace() });
}

export function PlacePrefsSync() {
  const session = useSession();
  const trpc = useTrpc();
  const uid = session?.user?.id ?? null;

  // All gating lives in refs (this component renders nothing, so state would only add renders).
  const uidRef = useRef<string | null>(null);
  uidRef.current = uid;
  const loadedFor = useRef<string | null>(null); // uid we've loaded the server prefs for
  const serverLoadDone = useRef(false);
  const lastSyncedRef = useRef<string | null>(null); // serialized prefs known to match the server
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Push the current local snapshot up immediately (optimistic marker, reset on failure).
  const doSave = useCallback(() => {
    if (!uidRef.current || !serverLoadDone.current) return;
    const serialized = serializeLocal();
    if (serialized === lastSyncedRef.current) return; // nothing new to save
    if (saveTimer.current) clearTimeout(saveTimer.current);
    lastSyncedRef.current = serialized;
    const api = trpc.profiles.setPlacePrefs as unknown as {
      mutate: (i: PlacePrefs) => Promise<{ ok: boolean }>;
    };
    api.mutate(JSON.parse(serialized) as PlacePrefs).catch(() => {
      lastSyncedRef.current = null; // failed — the next edit (or flush) retries
    });
  }, [trpc]);

  const scheduleSave = useCallback(() => {
    if (!uidRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(doSave, 800);
  }, [doSave]);

  // Load the server prefs once per signed-in session.
  useEffect(() => {
    if (!uid) {
      // Signed out → reset sync state so a later sign-in re-loads for that account.
      loadedFor.current = null;
      lastSyncedRef.current = null;
      serverLoadDone.current = false;
      return;
    }
    if (loadedFor.current === uid) return;
    loadedFor.current = uid;
    let cancelled = false;
    const api = trpc.profiles.placePrefs as unknown as {
      query: () => Promise<{ prefs: PlacePrefs | null }>;
    };
    api
      .query()
      .then((res) => {
        if (cancelled) return;
        const prefs = res?.prefs ?? null;
        if (prefs) {
          // Pinned places: server wins. Current place: seed only when this device has none.
          applySavedPlaces(prefs.saved);
          if (!hasStoredPlace() && prefs.last) applyCurrentPlace(prefs.last);
          // Mark the resulting LOCAL snapshot as synced: this device's own active place (when
          // it differs from the server's `last`) is not an edit — only real edits save up.
          lastSyncedRef.current = serializeLocal();
        } else {
          // Nothing on the server. Migrate a guest's local prefs up; a totally clean device
          // marks itself synced so no pointless empty save fires.
          const hasLocal = readSavedPlaces().length > 0 || readCurrentPlace() !== null;
          if (hasLocal) scheduleSave();
          else lastSyncedRef.current = serializeLocal();
        }
      })
      .catch(() => {
        /* offline / not provisioned — localStorage keeps working; edits retry via events */
      })
      .finally(() => {
        if (!cancelled) serverLoadDone.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [uid, trpc, scheduleSave]);

  // Subscribe to store edits (both stores dispatch on every write) + flush on tab-hide/unmount.
  useEffect(() => {
    const onChange = () => scheduleSave();
    const onHide = () => {
      if (document.visibilityState === "hidden") doSave();
    };
    window.addEventListener(SAVED_PLACES_EVENT, onChange);
    window.addEventListener(CURRENT_PLACE_EVENT, onChange);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener(SAVED_PLACES_EVENT, onChange);
      window.removeEventListener(CURRENT_PLACE_EVENT, onChange);
      document.removeEventListener("visibilitychange", onHide);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      doSave(); // unmount flush (rare — this lives in the root layout)
    };
  }, [scheduleSave, doSave]);

  return null;
}
