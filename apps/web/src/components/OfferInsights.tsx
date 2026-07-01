/**
 * OfferInsights — the "what's working" panel on a venue's dashboard. Shows, per offer THEME, how
 * many offers you've run and the saves + redemptions they've drawn — so a business can see which
 * kinds of deal (2-for-1 vs % off vs free item) actually land with locals. Reads offers.engagement
 * (owner-gated). This is the first, own-trends view; a local benchmark ("vs venues near you")
 * comes later once there's enough data to be fair.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTrpc } from "./TrpcProvider";
import { offerTypeLabel } from "../lib/offerTypes";

interface ThemeRow {
  offerType: string;
  offers: number;
  saves: number;
  redemptions: number;
}
interface Engagement {
  themes: ThemeRow[];
  totals: { offers: number; saves: number; redemptions: number };
}

export function OfferInsights({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [data, setData] = useState<Engagement | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const q = trpc.offers.engagement as unknown as { query: (i: { venueId: string }) => Promise<Engagement> };
    return q.query({ venueId });
  }, [trpc, venueId]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [load]);

  if (failed) {
    return <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>Couldn&apos;t load insights just now.</p>;
  }
  if (data === undefined) {
    return <div style={{ height: 80, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />;
  }
  if (data.totals.offers === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
        No offer data yet. Publish a few deals and tag their type — once people save and redeem them,
        you&apos;ll see which kinds work best here.
      </p>
    );
  }

  // Scale bars to the busiest theme (by saves+redemptions) so the comparison reads at a glance.
  const peak = Math.max(1, ...data.themes.map((t) => t.saves + t.redemptions));
  const best = data.themes[0];

  return (
    <div>
      {best && best.saves + best.redemptions > 0 ? (
        <p style={{ margin: "0 0 var(--space-3)", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
          Your <strong style={{ color: "var(--ink)" }}>{offerTypeLabel(best.offerType)}</strong> deals are pulling the most
          interest so far — {best.saves} saves and {best.redemptions} redemptions.
        </p>
      ) : null}

      <div style={{ display: "grid", gap: "var(--space-3)" }}>
        {data.themes.map((t) => {
          const total = t.saves + t.redemptions;
          const w = Math.round((total / peak) * 100);
          return (
            <div key={t.offerType}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                <span style={{ fontFamily: "var(--ui)", fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>
                  {offerTypeLabel(t.offerType)}
                </span>
                <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
                  {t.offers} offer{t.offers === 1 ? "" : "s"} · ♡ {t.saves} · ♻ {t.redemptions}
                </span>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: "var(--paper-2)", overflow: "hidden" }}>
                <div style={{ width: `${w}%`, height: "100%", background: "var(--crimson)", borderRadius: 999, transition: "width .3s ease" }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
