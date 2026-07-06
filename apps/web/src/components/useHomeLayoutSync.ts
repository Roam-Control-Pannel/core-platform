/**
 * useHomeLayoutSync — the ONE shared, server-synced widget layout, used by both surfaces that
 * render the widget registry: Home's rail and the Basecamp grid. Reordering or hiding a widget
 * on either page updates the same saved layout, so they never disagree.
 *
 * Wraps useHomeLayout (localStorage: instant, offline, guest-friendly) with the signed-in
 * cross-device sync to profiles.home_layout: server wins on load, edits debounce-save up, and
 * `flushLayout` pushes a pending save immediately (called on Customise-close; also wired here
 * to tab-hide and unmount so an edit made just before leaving still reaches other devices).
 * A guest layout migrates up on sign-in (no server layout → the local one is saved).
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTrpc, useSession } from "./TrpcProvider";
import { useHomeLayout, reconcile, type HomeLayout } from "../lib/homeLayout";

export function useHomeLayoutSync(registryIds: readonly string[]) {
  const session = useSession();
  const trpc = useTrpc();
  const { layout, loaded, move, reorder, toggle, reset, replace } = useHomeLayout(registryIds);
  const signedIn = !!session;

  const serverLoadedFor = useRef<string | null>(null); // uid we've loaded the server layout for
  const [serverLoadDone, setServerLoadDone] = useState(false);
  const lastSyncedRef = useRef<string | null>(null); // serialized layout known to match the server
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load the server layout once per signed-in session; server wins over the local cache.
  useEffect(() => {
    const uid = session?.user?.id ?? null;
    if (!uid) {
      // Signed out → reset sync state so a later sign-in re-loads for that account.
      serverLoadedFor.current = null;
      lastSyncedRef.current = null;
      setServerLoadDone(false);
      return;
    }
    if (!loaded || serverLoadedFor.current === uid) return;
    serverLoadedFor.current = uid;
    let cancelled = false;
    const api = trpc.profiles.homeLayout as unknown as {
      query: () => Promise<{ layout: HomeLayout | null }>;
    };
    api
      .query()
      .then((res) => {
        if (cancelled) return;
        if (res?.layout) {
          replace(res.layout);
          // Mark this as already-synced so it isn't echoed straight back to the server.
          lastSyncedRef.current = JSON.stringify(reconcile(res.layout, registryIds));
        }
        // If the server has nothing, leave lastSyncedRef null so the local layout migrates up.
      })
      .catch(() => {
        /* offline / not provisioned — localStorage keeps working */
      })
      .finally(() => {
        if (!cancelled) setServerLoadDone(true);
      });
    return () => {
      cancelled = true;
    };
    // registryIds is a stable module constant — intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, loaded, trpc, replace]);

  // Persist edits to the server (debounced) once the initial server load has settled — so we
  // never clobber the server layout with the local one before we've seen it.
  useEffect(() => {
    if (!signedIn || !loaded || !serverLoadDone) return;
    const serialized = JSON.stringify(layout);
    if (serialized === lastSyncedRef.current) return; // nothing new to save
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const api = trpc.profiles.setHomeLayout as unknown as {
        mutate: (i: { order: string[]; hidden: string[] }) => Promise<{ ok: boolean }>;
      };
      api
        .mutate({ order: layout.order, hidden: layout.hidden })
        .then(() => {
          lastSyncedRef.current = serialized;
        })
        .catch(() => {
          /* transient — will retry on the next edit */
        });
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [layout, signedIn, loaded, serverLoadDone, trpc]);

  // Flush any pending (debounced) layout save IMMEDIATELY. Reads live values via refs so it's a
  // stable callback and never fires a stale layout.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const flushLayout = useCallback(() => {
    if (!signedIn || !loaded || !serverLoadDone) return;
    const l = layoutRef.current;
    const serialized = JSON.stringify(l);
    if (serialized === lastSyncedRef.current) return; // already saved
    if (saveTimer.current) clearTimeout(saveTimer.current);
    lastSyncedRef.current = serialized; // optimistic: avoids a duplicate save from the debounce
    const api = trpc.profiles.setHomeLayout as unknown as {
      mutate: (i: { order: string[]; hidden: string[] }) => Promise<{ ok: boolean }>;
    };
    api.mutate({ order: l.order, hidden: l.hidden }).catch(() => {
      lastSyncedRef.current = null; // failed — let the next edit retry
    });
  }, [signedIn, loaded, serverLoadDone, trpc]);

  // Flush on unmount (SPA navigation) and when the tab is hidden (mobile background / close), so
  // the last edit isn't stranded in localStorage if the user leaves within the debounce window.
  const flushRef = useRef(flushLayout);
  flushRef.current = flushLayout;
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushRef.current();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      flushRef.current(); // unmount
    };
  }, []);

  return { layout, loaded, move, reorder, toggle, reset, flushLayout };
}
