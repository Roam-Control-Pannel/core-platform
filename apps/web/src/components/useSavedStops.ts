/**
 * useSavedStops — client state for the user's saved Translink stops (Stage 5 · Slice E).
 *
 * Two hooks over the `savedStops` tRPC router, sharing a module-level cache + change emitter so
 * every mounted Save button and the "Saved stops" widget stay in sync without prop-drilling:
 *
 *   useSavedStops()     → { hasSession, ready, isSaved, save, remove } for the toggle buttons.
 *   useSavedStopsList() → { hasSession, stops } — the full list for the widget, refetched on change.
 *
 * Saves/removes are optimistic (the cache flips immediately, reverting on error), so the star
 * responds instantly. Signed-out callers get hasSession=false and render nothing.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTrpc, useSession } from "./TrpcProvider";

export interface SavedStop {
  stop_id: string;
  name: string;
  lat: number;
  lng: number;
  created_at: string;
}

export interface StopRef {
  stopId: string;
  name: string;
  lat: number;
  lng: number;
}

// Module-level cache of the saved stop ids + a tiny pub/sub so all instances re-render on change.
let idCache: Set<string> | null = null;
let loading = false;
const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

/** Subscribe to save/remove changes (used by the list hook to refetch full rows). */
function useSavedStopsChange(onChange: () => void): void {
  useEffect(() => {
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, [onChange]);
}

/** Toggle state for Save buttons. */
export function useSavedStops() {
  const trpc = useTrpc();
  const session = useSession();
  const hasSession = !!session;
  const [, force] = useState(0);
  useSavedStopsChange(useCallback(() => force((n) => n + 1), []));

  // Load the id set once per session.
  useEffect(() => {
    if (!hasSession || idCache || loading) return;
    loading = true;
    const q = trpc.savedStops.list as unknown as {
      query: () => Promise<{ ok: boolean; stops?: { stop_id: string }[] }>;
    };
    q.query()
      .then((r) => {
        idCache = new Set((r.stops ?? []).map((s) => s.stop_id));
      })
      .catch(() => {
        idCache = new Set();
      })
      .finally(() => {
        loading = false;
        emit();
      });
  }, [trpc, hasSession]);

  const isSaved = useCallback((stopId: string) => idCache?.has(stopId) ?? false, []);

  const save = useCallback(
    async (stop: StopRef) => {
      if (!idCache) idCache = new Set();
      idCache.add(stop.stopId);
      emit();
      const m = trpc.savedStops.save as unknown as { mutate: (i: StopRef) => Promise<{ ok: boolean }> };
      try {
        await m.mutate(stop);
      } catch {
        idCache?.delete(stop.stopId);
        emit();
      }
    },
    [trpc],
  );

  const remove = useCallback(
    async (stopId: string) => {
      idCache?.delete(stopId);
      emit();
      const m = trpc.savedStops.remove as unknown as { mutate: (i: { stopId: string }) => Promise<{ ok: boolean }> };
      try {
        await m.mutate({ stopId });
      } catch {
        idCache?.add(stopId);
        emit();
      }
    },
    [trpc],
  );

  return { hasSession, ready: idCache !== null, isSaved, save, remove };
}

/** The full saved-stops list for the widget, refetched whenever a save/remove fires. */
export function useSavedStopsList() {
  const trpc = useTrpc();
  const session = useSession();
  const hasSession = !!session;
  const [stops, setStops] = useState<SavedStop[] | null>(null);

  const load = useCallback(() => {
    if (!hasSession) {
      setStops([]);
      return;
    }
    const q = trpc.savedStops.list as unknown as {
      query: () => Promise<{ ok: boolean; stops?: SavedStop[] }>;
    };
    q.query()
      .then((r) => setStops(r.ok ? r.stops ?? [] : []))
      .catch(() => setStops([]));
  }, [trpc, hasSession]);

  useEffect(() => {
    load();
  }, [load]);
  useSavedStopsChange(load);

  return { hasSession, stops };
}
