/**
 * VenueAudience — the aggregate "who follows you" panel on a business dashboard.
 *
 * Reads venueAudience.stats (counts only, owner-gated, k-anonymised server-side). Shows headline
 * numbers (followers, new, engaged, push reach), the reachable "birthdays this month", and an age
 * distribution — but ONLY when the server deems the sample large enough to be non-identifying;
 * otherwise it says so. No individual follower is ever shown here (by design).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTrpc } from "./TrpcProvider";

interface AudienceStats {
  followers: number;
  new30: number;
  engaged30: number;
  pushReach: number;
  birthdaysThisMonth: number | null;
  ageBands: Record<string, number> | null;
  dobSample: number;
}

const BAND_ORDER: { key: string; label: string }[] = [
  { key: "under_18", label: "Under 18" },
  { key: "age_18_24", label: "18–24" },
  { key: "age_25_34", label: "25–34" },
  { key: "age_35_44", label: "35–44" },
  { key: "age_45_54", label: "45–54" },
  { key: "age_55_64", label: "55–64" },
  { key: "age_65_plus", label: "65+" },
];

export function VenueAudience({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [stats, setStats] = useState<AudienceStats | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const q = trpc.venueAudience.stats as unknown as { query: (i: { venueId: string }) => Promise<AudienceStats> };
    return q.query({ venueId });
  }, [trpc, venueId]);

  useEffect(() => {
    let cancelled = false;
    load().then((s) => { if (!cancelled) setStats(s); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [load]);

  if (failed) return <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>Couldn&apos;t load audience insights just now.</p>;
  if (stats === undefined) return <div style={{ height: 120, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />;

  const bands = stats.ageBands;
  const bandPeak = bands ? Math.max(1, ...Object.values(bands)) : 1;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
        <Tile label="Followers" value={stats.followers} />
        <Tile label="New (30 days)" value={stats.new30} accent />
        <Tile label="Engaged (30 days)" value={stats.engaged30} />
        <Tile label="Push reach" value={stats.pushReach} />
      </div>

      {stats.birthdaysThisMonth != null ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: "var(--r-md)", background: "var(--crimson-tint)", border: "1px solid var(--crimson-tint-2)", marginBottom: "var(--space-4)" }}>
          <span aria-hidden style={{ fontSize: 18 }}>🎂</span>
          <span style={{ fontSize: 13.5, color: "var(--ink)" }}>
            <strong>{stats.birthdaysThisMonth}</strong> follower{stats.birthdaysThisMonth === 1 ? "" : "s"} opted in
            {" "}have a birthday this month.
          </span>
        </div>
      ) : null}

      <div style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--mono)", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "var(--space-2)" }}>
        Age
      </div>
      {bands ? (
        <div style={{ display: "grid", gap: 8 }}>
          {BAND_ORDER.filter((b) => (bands[b.key] ?? 0) > 0).map((b) => {
            const n = bands[b.key] ?? 0;
            const w = Math.round((n / bandPeak) * 100);
            return (
              <div key={b.key}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--ink-2)", marginBottom: 3 }}>
                  <span>{b.label}</span>
                  <span>{n}</span>
                </div>
                <div style={{ height: 8, borderRadius: 999, background: "var(--paper-2)", overflow: "hidden" }}>
                  <div style={{ width: `${w}%`, height: "100%", background: "var(--crimson)", borderRadius: 999 }} />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
          Not enough followers have shared a birthday yet to show an age breakdown (kept private until
          the group is large enough to stay anonymous).
        </p>
      )}
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div style={{ padding: "12px 14px", borderRadius: "var(--r-md)", border: "1px solid var(--line)", background: "var(--card)" }}>
      <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 24, color: accent ? "var(--crimson-700)" : "var(--ink)", lineHeight: 1 }}>{value}</div>
      <div style={{ marginTop: 4, fontSize: 12, color: "var(--muted)" }}>{label}</div>
    </div>
  );
}
