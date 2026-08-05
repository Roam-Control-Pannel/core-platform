/**
 * Overview — the Roam HQ front page (the editorial comp).
 *
 * Two heroes (new-member velocity + this-week engagement — the honest proxies for the
 * comp's "active users" / "subscribers"), a bordered KPI strip, the 30-day signups bar
 * chart, then Live Activity beside the Needs-You / Top-Places rail. Each panel fetches
 * its own slice so one slow/broken query never blanks the page.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTrpc } from "../TrpcProvider";
import { C, F } from "../../theme";
import {
  Bars,
  Chip,
  Delta,
  ErrorLine,
  Kicker,
  Kpi,
  Label,
  Panel,
  SkeletonBlock,
  clockTime,
  personLabel,
  timeAgo,
  type Bar,
} from "../ui";

export function OverviewView({ onGoModeration }: { onGoModeration: () => void }) {
  const [version, setVersion] = useState(0);
  return (
    <div style={{ display: "grid", gap: 20 }}>
      <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
        <div>
          <Kicker>Roam · Internal</Kicker>
          <h1 style={{ fontFamily: F.display, fontWeight: 700, fontSize: 40, letterSpacing: "-.03em", margin: "2px 0 0" }}>Overview</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted }}>Updated just now</span>
          <button type="button" onClick={() => setVersion((v) => v + 1)} style={refreshBtn}>Refresh</button>
        </div>
      </header>

      <StatsBlock version={version} />
      <SignupsChart version={version} />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.75fr) minmax(0, 1fr)", gap: 20 }} className="hq-overview-cols">
        <LiveActivityPanel version={version} />
        <div style={{ display: "grid", gap: 20, alignContent: "start" }}>
          <NeedsYouPanel version={version} onGoModeration={onGoModeration} />
          <TopPlacesPanel version={version} />
        </div>
      </div>

      <style>{`@media (max-width: 1040px){ .hq-overview-cols{ grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

/* ----------------------------------------------------------------- heroes + KPIs */

interface Overview {
  members: { total: number; new7d: number; new30d: number };
  venues: { total: number; new30d: number; claimed: number; claimedPct: number };
  forum: { topics: number; topics7d: number; replies: number; repliesPerTopic: number };
  offers: { redemptions: number; redemptions7d: number };
  engagement7d: { posts: number; forum: number; follows: number; total: number };
}
interface WeekPoint { weekStart: string; count: number }

const fmt = (n: number) => n.toLocaleString();

function StatsBlock({ version }: { version: number }) {
  const trpc = useTrpc();
  const [ov, setOv] = useState<Overview | undefined>(undefined);
  const [weekly, setWeekly] = useState<WeekPoint[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      trpc.adminMetrics.overview.query() as Promise<Overview>,
      trpc.adminMetrics.memberWeekly.query({ weeks: 14 }) as Promise<WeekPoint[]>,
    ])
      .then(([o, w]) => {
        if (cancelled) return;
        setOv(o);
        setWeekly(w);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load stats."));
    return () => {
      cancelled = true;
    };
  }, [trpc, version]);

  if (error) return <ErrorLine message={error} />;
  if (!ov || !weekly) {
    return (
      <div style={{ display: "grid", gap: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <SkeletonBlock height={210} /><SkeletonBlock height={210} />
        </div>
        <SkeletonBlock height={96} />
      </div>
    );
  }

  const last = weekly[weekly.length - 1]?.count ?? 0;
  const prev = weekly[weekly.length - 2]?.count ?? 0;
  const pct = prev > 0 ? ((last - prev) / prev) * 100 : last > 0 ? 100 : 0;
  const bars: Bar[] = weekly.map((w, i) => ({ value: w.count, highlight: i === weekly.length - 1, title: `${w.weekStart}: ${w.count}` }));

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} className="hq-heroes">
        {/* Left hero — new-member velocity (proxy for "active users"). */}
        <Panel style={{ padding: 24 }}>
          <Label>New members · last 7 days</Label>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 10 }}>
            <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 52, lineHeight: 1, letterSpacing: "-.03em" }}>{fmt(ov.members.new7d)}</div>
            <Delta>{pct >= 0 ? "+" : ""}{pct.toFixed(1)}% vs prior 7d</Delta>
          </div>
          <div style={{ marginTop: 20 }}>
            <Bars bars={bars} height={90} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontFamily: F.mono, fontSize: 10.5, color: C.muted }}>
              <span>14 weeks ago</span><span>this week</span>
            </div>
          </div>
        </Panel>

        {/* Right hero — this-week engagement (proxy for "subscribers"). */}
        <Panel style={{ padding: 24 }}>
          <Label>Engagement · last 7 days</Label>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 52, lineHeight: 1, letterSpacing: "-.03em", color: C.red }}>{fmt(ov.engagement7d.total)}</div>
            <div style={{ ...miniLabel, marginTop: 6 }}>interactions this week</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 22, paddingTop: 18, borderTop: `1px solid ${C.line}` }}>
            <MiniStat value={fmt(ov.engagement7d.posts)} label="Wall posts" />
            <MiniStat value={fmt(ov.engagement7d.forum)} label="Forum" />
            <MiniStat value={fmt(ov.engagement7d.follows)} label="Follows" />
          </div>
        </Panel>
      </div>

      {/* KPI strip — bordered cells sharing hairlines. */}
      <Panel style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", overflow: "hidden" }} >
        <div style={cell}><Kpi value={fmt(ov.members.total)} caption="Total members" note={`+${fmt(ov.members.new7d)} · 7d`} /></div>
        <div style={cell}><Kpi value={fmt(ov.venues.total)} caption="Venues" note={`+${fmt(ov.venues.new30d)} · 30d`} /></div>
        <div style={cell}><Kpi value={fmt(ov.venues.claimed)} caption="Claimed venues" note={`${ov.venues.claimedPct}% of venues`} /></div>
        <div style={cell}><Kpi value={fmt(ov.forum.topics)} caption="Forum topics" note={`+${fmt(ov.forum.topics7d)} · 7d`} /></div>
        <div style={cell}><Kpi value={fmt(ov.forum.replies)} caption="Forum replies" note={`${ov.forum.repliesPerTopic} per topic`} /></div>
        <div style={cellLast}><Kpi value={fmt(ov.offers.redemptions)} caption="Offer redemptions" note={`+${fmt(ov.offers.redemptions7d)} · 7d`} /></div>
      </Panel>
    </div>
  );
}

const miniLabel = { fontFamily: F.mono, fontSize: 11, color: C.muted } as const;
function MiniStat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 22, lineHeight: 1 }}>{value}</div>
      <div style={{ ...miniLabel, marginTop: 4, textTransform: "uppercase", letterSpacing: ".05em", fontSize: 10 }}>{label}</div>
    </div>
  );
}

const cell = { borderRight: `1px solid ${C.line}` } as const;
const cellLast = {} as const;

/* ----------------------------------------------------------------- signups chart */

interface TrendPoint { date: string; count: number }

function SignupsChart({ version }: { version: number }) {
  const trpc = useTrpc();
  const [points, setPoints] = useState<TrendPoint[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (trpc.adminMetrics.signupTrend.query({ days: 30 }) as Promise<TrendPoint[]>)
      .then((d) => !cancelled && setPoints(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load signups."));
    return () => {
      cancelled = true;
    };
  }, [trpc, version]);

  const info = useMemo(() => {
    if (!points || points.length === 0) return null;
    const total = points.reduce((s, p) => s + p.count, 0);
    let peakIdx = 0;
    points.forEach((p, i) => { if (p.count > points[peakIdx]!.count) peakIdx = i; });
    const bars: Bar[] = points.map((p, i) => ({ value: p.count, highlight: i === peakIdx, title: `${p.date}: ${p.count}` }));
    return { total, peak: points[peakIdx]!, bars, first: points[0]!.date, last: points[points.length - 1]!.date };
  }, [points]);

  return (
    <Panel style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <Label>Signups · last 30 days</Label>
        {info ? <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted }}>{info.total} total · peak {info.peak.count} on {new Date(info.peak.date).toLocaleDateString()}</span> : null}
      </div>
      {error ? <ErrorLine message={error} /> : !info ? <SkeletonBlock height={130} /> : (
        <>
          <Bars bars={info.bars} height={130} gap={info.bars.length > 20 ? 5 : 8} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontFamily: F.mono, fontSize: 10.5, color: C.muted }}>
            <span>{new Date(info.first).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" })}</span>
            <span>{new Date(info.last).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" })}</span>
          </div>
        </>
      )}
    </Panel>
  );
}

/* ----------------------------------------------------------------- live activity */

type ActivityKind = "signup" | "post" | "forum_topic" | "forum_reply" | "follow" | "event" | "venue_claim";
interface ActivityItem {
  id: string;
  kind: ActivityKind;
  createdAt: string;
  actor: { id: string; handle: string | null; displayName: string | null } | null;
  title: string;
  entity: { type: string; id: string } | null;
}

const GROUP: Array<{ key: "all" | "forum" | "signup" | "claim" | "follow" | "post"; label: string; kinds: ActivityKind[] }> = [
  { key: "all", label: "All", kinds: [] },
  { key: "forum", label: "Forum", kinds: ["forum_topic", "forum_reply"] },
  { key: "signup", label: "Signup", kinds: ["signup"] },
  { key: "claim", label: "Claim", kinds: ["venue_claim"] },
  { key: "follow", label: "Follow", kinds: ["follow"] },
  { key: "post", label: "Post", kinds: ["post"] },
];
const KIND_LABEL: Record<ActivityKind, string> = {
  signup: "Signup", post: "Post", forum_topic: "Forum", forum_reply: "Forum", follow: "Follow", event: "Event", venue_claim: "Claim",
};

function dayHeading(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const label = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }).toUpperCase();
  if (same(d, today)) return `Today · ${label}`;
  if (same(d, yest)) return `Yesterday · ${label}`;
  return label;
}

function LiveActivityPanel({ version }: { version: number }) {
  const trpc = useTrpc();
  const [items, setItems] = useState<ActivityItem[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof GROUP)[number]["key"]>("all");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    (trpc.adminActivity.feed.query({ limit: 40 }) as Promise<ActivityItem[]>)
      .then((d) => { setItems(d); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load activity."))
      .finally(() => setBusy(false));
  }, [trpc]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load, version]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const g of GROUP) map[g.key] = g.key === "all" ? items?.length ?? 0 : (items ?? []).filter((it) => g.kinds.includes(it.kind)).length;
    return map;
  }, [items]);

  const active = GROUP.find((g) => g.key === filter)!;
  const shown = (items ?? []).filter((it) => filter === "all" || active.kinds.includes(it.kind)).slice(0, 12);

  // Group shown items by day.
  const groups: Array<{ heading: string; rows: ActivityItem[] }> = [];
  for (const it of shown) {
    const h = dayHeading(it.createdAt);
    const g = groups[groups.length - 1];
    if (g && g.heading === h) g.rows.push(it);
    else groups.push({ heading: h, rows: [it] });
  }

  return (
    <Panel style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <Label>Live activity</Label>
        <span style={{ fontFamily: F.mono, fontSize: 11, color: C.muted }}>
          {items ? `${shown.length} of ${counts["all"]} shown` : ""}{busy ? " ·" : ""}
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
        {GROUP.map((g) => (
          <Chip key={g.key} active={filter === g.key} onClick={() => setFilter(g.key)}>
            {g.label} {counts[g.key] ?? 0}
          </Chip>
        ))}
      </div>

      {error ? <ErrorLine message={error} /> : !items ? (
        <div style={{ display: "grid", gap: 8 }}>{Array.from({ length: 6 }).map((_, i) => <SkeletonBlock key={i} height={34} />)}</div>
      ) : shown.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 13, padding: "8px 0" }}>Nothing here yet.</div>
      ) : (
        <div>
          {groups.map((g) => (
            <div key={g.heading}>
              <div style={{ fontFamily: F.mono, fontSize: 10.5, letterSpacing: ".08em", color: C.muted, margin: "14px 0 4px" }}>{g.heading}</div>
              {g.rows.map((it) => (
                <div key={it.id} style={{ display: "flex", alignItems: "baseline", gap: 14, padding: "10px 0", borderTop: `1px solid ${C.line}` }}>
                  <span style={{ width: 56, flexShrink: 0, fontFamily: F.mono, fontSize: 10.5, letterSpacing: ".06em", textTransform: "uppercase", color: C.red }}>{KIND_LABEL[it.kind]}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: C.inkSoft, lineHeight: 1.45 }}>
                    <strong style={{ color: C.ink }}>{personLabel(it.actor)}</strong> {it.title}
                  </span>
                  <span style={{ fontFamily: F.mono, fontSize: 11, color: C.faint, whiteSpace: "nowrap" }}>
                    {g.heading.startsWith("Today") ? timeAgo(it.createdAt) : clockTime(it.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ----------------------------------------------------------------- needs-you rail */

interface NeedsYou { reportsPending: number; claimsPending: number; flaggedProfiles: number; wallPosts7d: number }

function NeedsYouPanel({ version, onGoModeration }: { version: number; onGoModeration: () => void }) {
  const trpc = useTrpc();
  const [data, setData] = useState<NeedsYou | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (trpc.adminMetrics.needsYou.query() as Promise<NeedsYou>)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load."));
    return () => {
      cancelled = true;
    };
  }, [trpc, version]);

  return (
    <Panel style={{ padding: 24 }}>
      <Label>Needs you</Label>
      {error ? <div style={{ marginTop: 14 }}><ErrorLine message={error} /></div> : !data ? (
        <div style={{ display: "grid", gap: 8, marginTop: 14 }}>{Array.from({ length: 4 }).map((_, i) => <SkeletonBlock key={i} height={30} />)}</div>
      ) : (
        <>
          <div style={{ marginTop: 6 }}>
            <NeedRow label="Reports awaiting review" value={data.reportsPending} hot={data.reportsPending > 0} />
            <NeedRow label="Venue claims pending" value={data.claimsPending} hot={data.claimsPending > 0} />
            <NeedRow label="Flagged profiles" value={data.flaggedProfiles} hot={data.flaggedProfiles > 0} />
            <NeedRow label="Wall posts · 7d" value={data.wallPosts7d} />
          </div>
          <button type="button" onClick={onGoModeration} style={{ ...refreshBtn, width: "100%", boxSizing: "border-box", background: C.red, color: "#fff", border: "none", marginTop: 16, padding: "12px 14px", fontWeight: 700 }}>
            Open moderation queue
          </button>
        </>
      )}
    </Panel>
  );
}

function NeedRow({ label, value, hot = false }: { label: string; value: number; hot?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderTop: `1px solid ${C.line}` }}>
      <span style={{ fontSize: 13.5, color: C.inkSoft }}>{label}</span>
      <span style={{ fontFamily: F.display, fontWeight: 700, fontSize: 20, color: hot ? C.red : C.ink }}>{value.toLocaleString()}</span>
    </div>
  );
}

/* ----------------------------------------------------------------- top places */

interface PlaceCount { locality: string; count: number }

function TopPlacesPanel({ version }: { version: number }) {
  const trpc = useTrpc();
  const [places, setPlaces] = useState<PlaceCount[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (trpc.adminMetrics.topPlaces.query({ days: 7, limit: 5 }) as Promise<PlaceCount[]>)
      .then((d) => !cancelled && setPlaces(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load."));
    return () => {
      cancelled = true;
    };
  }, [trpc, version]);

  return (
    <Panel style={{ padding: 24 }}>
      <Label>Top places · 7 days</Label>
      {error ? <div style={{ marginTop: 14 }}><ErrorLine message={error} /></div> : !places ? (
        <div style={{ display: "grid", gap: 8, marginTop: 14 }}>{Array.from({ length: 5 }).map((_, i) => <SkeletonBlock key={i} height={26} />)}</div>
      ) : places.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 13, marginTop: 12 }}>No forum activity this week.</div>
      ) : (
        <div style={{ marginTop: 6 }}>
          {places.map((p, i) => (
            <div key={p.locality} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderTop: `1px solid ${C.line}` }}>
              <span style={{ fontFamily: F.mono, fontSize: 12, color: C.muted, width: 16 }}>{i + 1}</span>
              <span style={{ flex: 1, fontSize: 14, color: C.ink }}>{p.locality}</span>
              <span style={{ fontFamily: F.mono, fontSize: 12, color: C.muted }}>{p.count} topics</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

const refreshBtn: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  padding: "7px 14px",
  border: `1px solid ${C.ink}`,
  borderRadius: 4,
  fontFamily: F.ui,
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: ".04em",
  textTransform: "uppercase",
  color: C.ink,
  textAlign: "center",
};
