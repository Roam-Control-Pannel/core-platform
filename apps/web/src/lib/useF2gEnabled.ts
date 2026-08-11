/**
 * useF2gEnabled — whether the Food to Go marketplace feature is switched on
 * (feature_flags.marketplace.f2g.enabled, read via trpc.f2g.config).
 *
 * Shared across the app: the vendor dashboard tab (VenueOwnerEditor) and the Roam-side order-ahead
 * affordances (discovery cards, venue page) all gate on this. Distinct from useChannel().isF2G —
 * that's "am I on the f2g-branded host"; this is the global feature switch. A Roam-side badge wants
 * this flag true AND per-venue channel membership, rendered on the ordinary Roam channel.
 *
 * Dormant by default: a failed/absent read keeps it false, so nothing F2G shows until launch.
 */
"use client";

import { useEffect, useState } from "react";
import { useTrpc } from "../components/TrpcProvider";

export function useF2gEnabled(): boolean {
  const trpc = useTrpc();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    trpc.f2g.config
      .query()
      .then((c) => {
        if (!cancelled) setEnabled(!!c.enabled);
      })
      .catch(() => {
        /* dormant by default */
      });
    return () => {
      cancelled = true;
    };
  }, [trpc]);
  return enabled;
}
