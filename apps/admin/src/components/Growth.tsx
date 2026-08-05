/**
 * Growth — a dependency-free inline-SVG sparkline of daily signups over 30 days
 * (adminMetrics.signupTrend). No chart library; just a polyline + area fill on the
 * design tokens. Shows the 30-day total and the peak day.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { ErrorLine, Kicker, SkeletonBlock } from "./ui";

interface TrendPoint {
  date: string;
  count: number;
}

const W = 640;
const H = 120;
const PAD = 6;

export function Growth() {
  const trpc = useTrpc();
  const [points, setPoints] = useState<TrendPoint[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (trpc.adminMetrics.signupTrend.query({ days: 30 }) as Promise<TrendPoint[]>)
      .then((d) => !cancelled && setPoints(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load trend."));
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  const shape = useMemo(() => {
    if (!points || points.length === 0) return null;
    const max = Math.max(1, ...points.map((p) => p.count));
    const n = points.length;
    const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(1, n - 1);
    const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
    const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.count).toFixed(1)}`).join(" ");
    const area = `${line} L${x(n - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`;
    const total = points.reduce((s, p) => s + p.count, 0);
    const peak = points.reduce((a, b) => (b.count > a.count ? b : a), points[0]!);
    return { line, area, total, max, peak };
  }, [points]);

  return (
    <Card style={{ padding: "var(--space-5)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "var(--space-3)" }}>
        <Kicker tone="crimson">Signups · last 30 days</Kicker>
        {shape ? (
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)" }}>
            {shape.total.toLocaleString()} total · peak {shape.peak.count} on {new Date(shape.peak.date).toLocaleDateString()}
          </div>
        ) : null}
      </div>
      {error ? (
        <ErrorLine message={error} />
      ) : !points ? (
        <SkeletonBlock height={H} />
      ) : shape ? (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Daily signups over the last 30 days">
          <path d={shape.area} fill="var(--crimson-tint)" />
          <path d={shape.line} fill="none" stroke="var(--crimson)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      ) : null}
    </Card>
  );
}
