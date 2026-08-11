/**
 * useVenueOrderAhead — is this venue offering Food to Go order-ahead, and its prep time.
 *
 * The Roam-side bridge datum (Phase 4): a venue offers order-ahead when the F2G feature is on, the
 * venue is tagged into the f2g channel, and its collection settings have order_ahead on and aren't
 * paused. Powers the venue-page "Order ahead" hero chip + jump-to-menu CTA, and feeds prepMins to
 * the "Get here" journey planner so the prep time can meet the transit ETA.
 *
 * Dormant by default: with the flag off it never queries and reports unavailable.
 */
"use client";

import { useEffect, useState } from "react";
import { useTrpc } from "../components/TrpcProvider";
import { useF2gEnabled } from "./useF2gEnabled";

export interface VenueOrderAhead {
  available: boolean;
  prepMins: number;
  paused: boolean;
}

const NONE: VenueOrderAhead = { available: false, prepMins: 15, paused: false };

export function useVenueOrderAhead(venueId: string): VenueOrderAhead {
  const trpc = useTrpc();
  const enabled = useF2gEnabled();
  const [info, setInfo] = useState<VenueOrderAhead>(NONE);

  useEffect(() => {
    if (!enabled) {
      setInfo(NONE);
      return;
    }
    let cancelled = false;
    Promise.all([
      trpc.channels.venueChannels.query({ venueId }),
      trpc.f2g.collectionSettings.query({ venueId }),
    ])
      .then(([keys, c]) => {
        if (cancelled) return;
        const isF2G = Array.isArray(keys) && keys.includes("f2g");
        setInfo({
          available: isF2G && c.orderAhead && !c.paused,
          prepMins: c.prepTimeMins,
          paused: !!c.paused,
        });
      })
      .catch(() => {
        if (!cancelled) setInfo(NONE);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, enabled, venueId]);

  return info;
}
