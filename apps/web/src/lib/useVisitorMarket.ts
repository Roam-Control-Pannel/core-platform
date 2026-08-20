/**
 * useVisitorMarket — the visitor's own MARKET (country), resolved once per session.
 *
 * This is "which country is the visitor actually in", NOT "which place are they browsing"
 * (useCurrentPlace). It's the stable signal that gates country-specific surfaces — e.g. Deals is
 * UK-only affiliate supply, so it must be hidden outside the UK — and that frames the seeding /
 * pioneer experience for a market we don't fully operate yet.
 *
 * Resolution: the coarse, permission-free IP guess (/api/geo → country code + coarse coords) is
 * handed to the api (trpc geo.market), which owns the authoritative markets registry (@roam/core)
 * and returns a portable descriptor. The api is the single source of truth; the web never mirrors
 * the registry. `known:false` means we don't operate a registered market there yet (seeding).
 *
 * Cached at module scope so every consumer shares one resolution (and one /api/geo hit) per load.
 * Off-platform / no headers → country unknown → an "unknown, seeding" descriptor (Deals hidden),
 * which is the safe default.
 */
"use client";

import { useEffect, useState } from "react";
import { useTrpc } from "../components/TrpcProvider";

export interface VisitorMarket {
  /** Whether we operate a registered market for the visitor's country. */
  known: boolean;
  /** ISO-3166-1 alpha-2 (uppercase), or null if we couldn't determine it. */
  countryCode: string | null;
  name: string | null;
  currency: string | null;
  units: "metric" | "imperial";
  status: "live" | "seeding";
  defaultPlace: { name: string; hint?: string; lat: number; lng: number } | null;
}

type MarketQuery = {
  query: (i: { country?: string; lat?: number; lng?: number }) => Promise<VisitorMarket>;
};

let cached: VisitorMarket | null = null;
let inflight: Promise<VisitorMarket | null> | null = null;

async function resolveVisitorMarket(marketQ: MarketQuery): Promise<VisitorMarket | null> {
  let country: string | undefined;
  let lat: number | undefined;
  let lng: number | undefined;
  try {
    const res = await fetch("/api/geo", { headers: { accept: "application/json" } });
    if (res.ok) {
      const d = (await res.json()) as { detected?: boolean; lat?: unknown; lng?: unknown; country?: unknown };
      if (d?.detected) {
        if (typeof d.country === "string" && d.country.trim()) country = d.country.trim();
        if (typeof d.lat === "number" && Number.isFinite(d.lat)) lat = d.lat;
        if (typeof d.lng === "number" && Number.isFinite(d.lng)) lng = d.lng;
      }
    }
  } catch {
    /* off-platform / offline — resolve with no signal (unknown market) */
  }
  try {
    return await marketQ.query({
      ...(country ? { country } : {}),
      ...(lat != null ? { lat } : {}),
      ...(lng != null ? { lng } : {}),
    });
  } catch {
    return null;
  }
}

export function useVisitorMarket(): { market: VisitorMarket | null; loading: boolean } {
  const trpc = useTrpc();
  const [market, setMarket] = useState<VisitorMarket | null>(cached);
  const [loading, setLoading] = useState<boolean>(cached === null);

  useEffect(() => {
    if (cached) {
      setMarket(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const marketQ = trpc.geo.market as unknown as MarketQuery;
    inflight = inflight ?? resolveVisitorMarket(marketQ);
    inflight
      .then((m) => {
        cached = m;
        inflight = null;
        if (!cancelled) {
          setMarket(m);
          setLoading(false);
        }
      })
      .catch(() => {
        inflight = null;
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  return { market, loading };
}

/**
 * Whether the visitor is in the United Kingdom — the gate for UK-only surfaces (Deals). While the
 * market is still resolving we return `undefined` (unknown yet) so callers can avoid a flash of
 * UK-only content before we know; once resolved it's a definite true/false.
 */
export function useIsUkVisitor(): boolean | undefined {
  const { market, loading } = useVisitorMarket();
  if (loading && !market) return undefined;
  return market?.countryCode === "GB";
}
