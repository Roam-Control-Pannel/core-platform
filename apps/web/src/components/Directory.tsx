/**
 * Directory — the F2G members marketplace at scale (C2-b). A channel-scoped, searchable directory of
 * the Association's LIVE members, built to page the roster (up to ~5,000) without ever shipping it
 * whole: every query hits the PII-safe `channels.directory` procedure (the SECURITY DEFINER RPC, C2-a),
 * which searches/filters/sorts server-side and returns ONLY safe columns of live members.
 *
 * SSR-seeded: the page.tsx server-renders the first page (for crawlers + a fast first paint) and hands
 * it in as `initialEntries`; this component then owns the interactive view — text search, a council
 * filter, "near me" distance sort, and load-more paging. The first user interaction re-queries from
 * the server; until then the SSR seed stands (no fetch-on-mount flash).
 *
 * Gated on `sections.directory` (the launch flip, like the jobs/suppliers boards). Mirrors those boards'
 * shape; channel comes from useChannel.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTrpc } from "./TrpcProvider";
import { useChannel } from "./ChannelProvider";

interface DirectoryVenue {
  id: string;
  slug: string | null;
  name: string;
  locality: string | null;
  rating: number | null;
}
interface DirectoryEntry {
  memberId: string;
  name: string;
  council: string | null;
  status: string;
  venue: DirectoryVenue | null;
  distanceM: number | null;
}
interface DirectoryPage {
  entries: DirectoryEntry[];
  hasMore: boolean;
  nextOffset: number;
}

const PAGE_SIZE = 24;
const NEAR_RADIUS_M = 40_000; // "near me" sorts by distance within ~40km (NI-scale); null elsewhere.

/** Local mirror of @roam/core's geo.formatDistance (same rationale as VenueCard/NearbyFriends). */
function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export function Directory({
  initialEntries,
  initialHasMore,
  council,
}: {
  initialEntries: DirectoryEntry[];
  initialHasMore: boolean;
  /** A per-council landing (the /directory/[council] route) locks the council filter to this value. */
  council?: string;
}) {
  const trpc = useTrpc();
  const { key: channelKey, isEnabled, channel } = useChannel();

  const [entries, setEntries] = useState<DirectoryEntry[]>(initialEntries);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [q, setQ] = useState("");
  const [near, setNear] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const didInteract = useRef(false);

  const brand = channel?.name ?? "Food to Go";

  /** Query one page. reset=true replaces the list (a new search); otherwise it appends (load more). */
  const load = useCallback(
    async (offset: number, reset: boolean) => {
      const dir = trpc.channels.directory as unknown as {
        query: (i: {
          channelKey: string;
          q?: string;
          council?: string;
          near?: { lat: number; lng: number };
          radiusM?: number;
          limit: number;
          offset: number;
        }) => Promise<DirectoryPage>;
      };
      setLoading(true);
      setError(null);
      try {
        const r = await dir.query({
          channelKey,
          ...(q.trim() ? { q: q.trim() } : {}),
          ...(council ? { council } : {}),
          ...(near ? { near, radiusM: NEAR_RADIUS_M } : {}),
          limit: PAGE_SIZE,
          offset,
        });
        setEntries((prev) => (reset ? r.entries : [...prev, ...r.entries]));
        setHasMore(r.hasMore);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load the directory.");
      } finally {
        setLoading(false);
      }
    },
    [trpc, channelKey, q, council, near],
  );

  // Re-query when the search text or "near me" origin changes — debounced so typing doesn't spam the
  // API. The SSR seed stands until the first real interaction (didInteract), so there's no mount flash.
  useEffect(() => {
    if (!didInteract.current) {
      didInteract.current = true;
      return;
    }
    const t = setTimeout(() => void load(0, true), 250);
    return () => clearTimeout(t);
  }, [q, near, load]);

  const locateMe = async () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Location isn't available in this browser.");
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setNear({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      () => {
        setError("Couldn't get your location.");
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  };

  if (!isEnabled("directory")) {
    return (
      <main style={pageWrap}>
        <p style={{ color: "var(--ink-2)", fontSize: 15 }}>The members directory isn&rsquo;t available here yet.</p>
      </main>
    );
  }

  return (
    <main style={pageWrap}>
      <header style={{ marginBottom: "var(--space-5)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--crimson-700)", marginBottom: 6 }}>
          Members
        </div>
        <h1 style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 32, letterSpacing: "-.02em", margin: 0 }}>
          {council ? `${brand} members in ${council}` : `${brand} members`}
        </h1>
        <p style={{ color: "var(--ink-2)", margin: "6px 0 0", fontSize: 14.5, lineHeight: 1.5 }}>
          Local member cafés, takeaways and food businesses. Search by name{council ? "" : ", filter by council"} or find the ones nearest you.
        </p>
      </header>

      {/* Controls: text search + "near me" distance sort. The council filter is a fixed segment on a
          per-council landing; on the main page it's driven by the members' own council labels. */}
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-5)" }}>
        <input
          style={{ ...inputStyle, flex: 1, minWidth: 200 }}
          placeholder="Search members by name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={120}
          aria-label="Search members by name"
        />
        <button
          style={near ? primaryBtn : ghostBtn}
          onClick={() => (near ? setNear(null) : void locateMe())}
          disabled={locating}
        >
          {locating ? "Locating…" : near ? "Nearest first ✓" : "Near me"}
        </button>
      </div>

      {error ? <p style={{ color: "var(--crimson-700)", fontSize: 14 }}>{error}</p> : null}

      {entries.length === 0 ? (
        <p style={{ color: "var(--ink-2)", fontSize: 14 }}>
          {loading ? "Loading…" : q.trim() ? "No members match your search." : "No members listed yet — check back soon."}
        </p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {entries.map((e) => (
            <MemberRow key={e.memberId} entry={e} />
          ))}
        </div>
      )}

      {hasMore ? (
        <div style={{ marginTop: "var(--space-5)", textAlign: "center" }}>
          <button style={ghostBtn} onClick={() => void load(entries.length, false)} disabled={loading}>
            {loading ? "Loading…" : "Show more"}
          </button>
        </div>
      ) : null}
    </main>
  );
}

function MemberRow({ entry }: { entry: DirectoryEntry }) {
  const meta = [entry.council, entry.venue?.locality].filter(Boolean).join(" · ");
  const dist = entry.distanceM != null ? formatDistance(entry.distanceM) : null;
  const rating = entry.venue?.rating != null ? entry.venue.rating.toFixed(1) : null;

  const inner = (
    <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "var(--space-4)", display: "flex", gap: "var(--space-3)", alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 15.5, color: "var(--ink)" }}>{entry.name}</div>
        {meta ? <div style={{ marginTop: 2, fontSize: 13, color: "var(--ink-2)" }}>{meta}</div> : null}
        <div style={{ marginTop: 4, display: "flex", gap: "var(--space-2)", flexWrap: "wrap", fontSize: 12.5, color: "var(--muted)" }}>
          {rating ? <span>★ {rating}</span> : null}
          {dist ? <span>{dist} away</span> : null}
          {entry.venue ? <span style={{ color: "var(--crimson-700)", fontWeight: 600 }}>View page →</span> : null}
        </div>
      </div>
    </div>
  );

  // A matched member links to its venue's public page (a shared Roam entity); an unmatched member is a
  // plain card (no page to link to yet — it surfaces once the roster row is matched/claimed).
  return entry.venue ? (
    <Link href={`/venue/${entry.venue.slug ?? entry.venue.id}`} style={{ textDecoration: "none", color: "inherit" }}>
      {inner}
    </Link>
  ) : (
    inner
  );
}

const pageWrap: React.CSSProperties = { maxWidth: 720, margin: "0 auto", padding: "var(--space-6) var(--space-4)" };
const inputStyle: React.CSSProperties = { boxSizing: "border-box", width: "100%", padding: "10px 12px", background: "#fff", border: "1px solid var(--line)", borderRadius: 8, fontFamily: "var(--ui)", fontSize: 14, color: "var(--ink)", outline: "none" };
const primaryBtn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "9px 18px", background: "var(--crimson)", color: "#fff", borderRadius: 999, fontWeight: 600, fontSize: 14, textAlign: "center" };
const ghostBtn: React.CSSProperties = { all: "unset", cursor: "pointer", padding: "9px 18px", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 999, fontWeight: 600, fontSize: 14, textAlign: "center" };
