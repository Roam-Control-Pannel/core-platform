/**
 * Home — the signed-in hub (/home). One place that pulls together the surfaces a local cares
 * about day-to-day: your recent chats, what's on near you, and your town's forum — plus the
 * Stage-2/Stage-5 seams (upcoming plans, the local market) shown honestly as "coming soon".
 *
 * PUBLIC to view (browse-freely): the live sections that need an account (Recent chats) show a
 * gentle sign-in nudge rather than gating the whole page. The local sections re-root off the
 * shared current place (useCurrentPlace) via the same PlaceSwitcher as Explore/Town Hall, so
 * Home, Explore and Town Hall always agree on "where you are".
 *
 * Each live section loads independently (its own query + skeleton/empty/error), so a slow or
 * failed one never blocks the rest of the hub.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { PlaceSwitcher, type Place } from "./PlaceSwitcher";
import { useCurrentPlace } from "../lib/currentPlace";
import { VenueCard, type VenueCardData } from "./VenueCard";
import { townHallAuthor, timeAgo, type TownHallAuthor } from "../lib/townHall";
import styles from "./Home.module.css";

export function Home() {
  const session = useSession();
  const { place, setPlace } = useCurrentPlace();

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ marginBottom: "var(--space-5)" }}>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 28, letterSpacing: "-.02em", margin: 0 }}>
          Home
        </h1>
        <p style={{ marginTop: 4, marginBottom: "var(--space-4)", color: "var(--ink-2)", fontSize: 14, lineHeight: 1.5 }}>
          Your chats, your plans, and what&apos;s happening in your town — all in one place.
        </p>
        <PlaceSwitcher value={place} onChange={setPlace} />
      </header>

      <div className={styles.grid}>
        <div className={styles.spanAll}>
          <RecentChats hasSession={!!session} />
        </div>

        <div className={styles.spanAll}>
          <YourTown place={place} />
        </div>

        <div className={styles.spanAll}>
          <TownForum place={place} />
        </div>

        <UpcomingPlansSeam />
        <MarketSeam place={place} />
      </div>
    </main>
  );
}

/* ── Section shell ─────────────────────────────────────────────────────────────────────── */

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: { label: string; href: string };
  children: React.ReactNode;
}) {
  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
        <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, margin: 0 }}>
          {title}
        </h2>
        {action ? (
          <Link href={action.href} style={{ fontSize: 13, fontWeight: 600, color: "var(--crimson-700)", textDecoration: "none", whiteSpace: "nowrap" }}>
            {action.label} <span aria-hidden>→</span>
          </Link>
        ) : null}
      </header>
      {children}
    </Card>
  );
}

const mutedNote: React.CSSProperties = { color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.5, margin: 0 };
const rowSkeleton: React.CSSProperties = { height: 44, borderRadius: "var(--r-md)", background: "var(--paper-2)" };

/* ── Recent chats (live, auth-gated) ───────────────────────────────────────────────────── */

interface ChatRow {
  id: string;
  isGroup: boolean;
  title: string | null;
  updatedAt: string;
  participantCount: number;
}

function RecentChats({ hasSession }: { hasSession: boolean }) {
  const trpc = useTrpc();
  const [rows, setRows] = useState<ChatRow[] | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    const listThreads = trpc.chat.listThreads as unknown as { query: () => Promise<ChatRow[]> };
    listThreads
      .query()
      .then((res) => {
        if (!cancelled) setRows(Array.isArray(res) ? res.slice(0, 4) : []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, hasSession]);

  return (
    <Section title="Recent chats" {...(hasSession ? { action: { label: "All chats", href: "/threads" } } : {})}>
      {!hasSession ? (
        <div>
          <p style={mutedNote}>Sign in to see your conversations and plans with people nearby.</p>
          <div style={{ marginTop: "var(--space-3)" }}>
            <Link href="/account" style={{ textDecoration: "none" }}>
              <Button variant="pri" size="sm">Sign in</Button>
            </Link>
          </div>
        </div>
      ) : error ? (
        <p style={mutedNote}>Couldn&apos;t load your chats just now.</p>
      ) : rows === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <div style={rowSkeleton} />
          <div style={rowSkeleton} />
        </div>
      ) : rows.length === 0 ? (
        <p style={mutedNote}>No chats yet. Start a plan with people nearby and it&apos;ll show up here.</p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          {rows.map((t) => (
            <Link
              key={t.id}
              href={`/threads/${t.id}`}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", padding: "10px 8px", borderRadius: "var(--r-md)", textDecoration: "none", color: "inherit" }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <span
                  aria-hidden
                  style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontSize: 13, flexShrink: 0 }}
                >
                  {t.isGroup ? "◇" : "✦"}
                </span>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.title ?? (t.isGroup ? "Group chat" : "Direct message")}
                </span>
              </span>
              <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>{timeAgo(t.updatedAt)}</span>
            </Link>
          ))}
        </div>
      )}
    </Section>
  );
}

/* ── Your town (live: nearby venues peek) ──────────────────────────────────────────────── */

/** The subset of a venues.near row we map onto a card. Optional fields stay optional. */
interface NearRow {
  id: string;
  name: string;
  claimed: boolean;
  category: string | null;
  rating: number | null;
  ratingCount?: number | null;
  priceLevel?: string | null;
  primaryTypeLabel?: string | null;
  businessStatus?: string | null;
  distanceM?: number;
  coverPhotoId?: string | null;
}

function toCard(v: NearRow): VenueCardData {
  return {
    id: v.id,
    name: v.name,
    claimed: v.claimed,
    category: v.category,
    rating: v.rating,
    ratingCount: v.ratingCount,
    priceLevel: v.priceLevel,
    primaryTypeLabel: v.primaryTypeLabel,
    businessStatus: v.businessStatus,
    distanceM: v.distanceM,
    coverPhotoId: v.coverPhotoId,
  };
}

function YourTown({ place }: { place: Place }) {
  const trpc = useTrpc();
  const [venues, setVenues] = useState<VenueCardData[] | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setVenues(undefined);
    setError(false);
    trpc.venues.near
      .query({ lat: place.lat, lng: place.lng, limit: 4 })
      .then((rows: unknown) => {
        if (cancelled) return;
        const list = Array.isArray(rows) ? (rows as NearRow[]).slice(0, 4).map(toCard) : [];
        setVenues(list);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, place.lat, place.lng]);

  return (
    <Section title={`${place.name} online`} action={{ label: "Explore", href: "/" }}>
      {error ? (
        <p style={mutedNote}>Couldn&apos;t load venues near you just now.</p>
      ) : venues === undefined ? (
        <div className={styles.venuePeek}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ height: 180, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
          ))}
        </div>
      ) : venues.length === 0 ? (
        <p style={mutedNote}>No venues found near {place.name} yet.</p>
      ) : (
        <div className={styles.venuePeek}>
          {venues.map((v) => (
            <VenueCard key={v.id} venue={v} />
          ))}
        </div>
      )}
    </Section>
  );
}

/* ── Town forum (live: top Town Hall topics) ───────────────────────────────────────────── */

interface ForumTopic {
  id: string;
  title: string;
  upvoteCount: number;
  replyCount: number;
  createdAt: string;
  author: TownHallAuthor;
}

function TownForum({ place }: { place: Place }) {
  const trpc = useTrpc();
  const [topics, setTopics] = useState<ForumTopic[] | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTopics(undefined);
    setError(false);
    const listTopics = trpc.townHall.listTopics as unknown as {
      query: (input: { localityName: string; sort: "popular" | "recent" }) => Promise<{ topics: ForumTopic[] }>;
    };
    listTopics
      .query({ localityName: place.name, sort: "popular" })
      .then((res) => {
        if (!cancelled) setTopics((res.topics ?? []).slice(0, 3));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, place.name]);

  return (
    <Section title="Town forum" action={{ label: "Town Hall", href: "/town-hall" }}>
      {error ? (
        <p style={mutedNote}>Couldn&apos;t load the forum just now.</p>
      ) : topics === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <div style={rowSkeleton} />
          <div style={rowSkeleton} />
        </div>
      ) : topics.length === 0 ? (
        <p style={mutedNote}>
          No topics in {place.name} yet.{" "}
          <Link href="/town-hall" style={{ color: "var(--crimson-700)", textDecoration: "none", fontWeight: 600 }}>
            Start one →
          </Link>
        </p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          {topics.map((t) => (
            <Link
              key={t.id}
              href={`/town-hall/${t.id}`}
              style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", padding: "10px 8px", borderRadius: "var(--r-md)", textDecoration: "none", color: "inherit" }}
            >
              <span
                aria-hidden
                style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 34, color: "var(--crimson-700)" }}
              >
                <span style={{ fontSize: 11, lineHeight: 1 }}>▲</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{t.upvoteCount}</span>
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.title}
                </span>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  {townHallAuthor(t.author)} · {t.replyCount === 1 ? "1 reply" : `${t.replyCount} replies`}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </Section>
  );
}

/* ── Dormant seams (honest "coming soon") ──────────────────────────────────────────────── */

function SeamCard({ title, glyph, blurb }: { title: string; glyph: string; blurb: string }) {
  return (
    <Card flat style={{ padding: "var(--space-4)", background: "var(--paper-2)", borderStyle: "dashed" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
        <span aria-hidden style={{ fontSize: 18, color: "var(--crimson-700)", opacity: 0.6 }}>{glyph}</span>
        <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 16, margin: 0, color: "var(--ink-2)" }}>
          {title}
        </h2>
        <span
          style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", border: "1px solid var(--line-2)", borderRadius: 999, padding: "2px 8px" }}
        >
          Coming soon
        </span>
      </header>
      <p style={mutedNote}>{blurb}</p>
    </Card>
  );
}

function UpcomingPlansSeam() {
  return (
    <SeamCard
      title="Upcoming plans"
      glyph="◷"
      blurb="Make plans with friends and people nearby — meet-ups, nights out, who's in. You'll see what's coming up here."
    />
  );
}

function MarketSeam({ place }: { place: Place }) {
  return (
    <SeamCard
      title={`${place.name} market`}
      glyph="◇"
      blurb="Buy, sell and swap with people in your town — a local marketplace, right where you already browse."
    />
  );
}
