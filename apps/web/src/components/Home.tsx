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
import { Card, Button, Pill } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { PlaceSwitcher, type Place } from "./PlaceSwitcher";
import { useCurrentPlace } from "../lib/currentPlace";
import { VenueCard, type VenueCardData } from "./VenueCard";
import { townHallAuthor, timeAgo, type TownHallAuthor } from "../lib/townHall";
import { planDateLabel } from "../lib/planDate";
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
          <FollowedVenues hasSession={!!session} />
        </div>

        <div className={styles.spanAll}>
          <UpcomingPlans hasSession={!!session} />
        </div>

        <div className={styles.spanAll}>
          <LocalNews />
        </div>

        <div className={styles.spanAll}>
          <YourTown place={place} />
        </div>

        <div className={styles.spanAll}>
          <TownForum place={place} />
        </div>

        <div className={styles.spanAll}>
          <MarketSeam place={place} />
        </div>
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

/** A short "12 Jun" date for an offer's end — tolerant of an unparseable value. */
function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

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
              className={styles.row}
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
      .query({ lat: place.lat, lng: place.lng, limit: 12 })
      .then((rows: unknown) => {
        if (cancelled) return;
        const list = Array.isArray(rows) ? (rows as NearRow[]).slice(0, 12).map(toCard) : [];
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
    <Section title={`${place.name} online`} action={{ label: "Explore", href: "/explore" }}>
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
              className={styles.row}
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

/* ── Followed venues + their exclusive loyalty deals (live, auth-gated) ─────────────────── */

interface FollowVenue {
  venue_id: string;
  venues: { id: string; name: string; category: string | null } | null;
}
interface Deal {
  id: string;
  venueId: string;
  venueName: string | null;
  title: string;
  details: string | null;
  code: string | null;
  endsAt: string | null;
}

function FollowedVenues({ hasSession }: { hasSession: boolean }) {
  const trpc = useTrpc();
  const [follows, setFollows] = useState<FollowVenue[] | undefined>(undefined);
  const [deals, setDeals] = useState<Deal[] | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    const myFollows = trpc.social.myFollows as unknown as {
      query: () => Promise<{ ok: boolean; follows?: FollowVenue[] }>;
    };
    const forFollowed = trpc.offers.forFollowed as unknown as { query: () => Promise<Deal[]> };
    Promise.all([myFollows.query(), forFollowed.query().catch(() => [] as Deal[])])
      .then(([f, d]) => {
        if (cancelled) return;
        setFollows(f.ok ? (f.follows ?? []) : []);
        setDeals(Array.isArray(d) ? d : []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, hasSession]);

  return (
    <Section title="Followed venues" {...(hasSession ? { action: { label: "Manage", href: "/following" } } : {})}>
      {!hasSession ? (
        <div>
          <p style={mutedNote}>
            Follow a business to unlock its exclusive loyalty deals — they&apos;ll appear here, just for followers.
          </p>
          <div style={{ marginTop: "var(--space-3)" }}>
            <Link href="/account" style={{ textDecoration: "none" }}>
              <Button variant="pri" size="sm">Sign in</Button>
            </Link>
          </div>
        </div>
      ) : error ? (
        <p style={mutedNote}>Couldn&apos;t load your followed venues just now.</p>
      ) : follows === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <div style={rowSkeleton} />
          <div style={rowSkeleton} />
        </div>
      ) : follows.length === 0 ? (
        <div>
          <p style={mutedNote}>
            You&apos;re not following any businesses yet. Follow one to get its exclusive loyalty deals here.
          </p>
          <div style={{ marginTop: "var(--space-3)" }}>
            <Link href="/explore" style={{ textDecoration: "none" }}>
              <Button variant="neutral" size="sm">Find businesses to follow</Button>
            </Link>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-4)" }}>
          {/* The businesses you follow — quick chips into each. */}
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            {follows.map((f) => (
              <Link
                key={f.venue_id}
                href={`/venue/${f.venues?.id ?? f.venue_id}`}
                style={{ textDecoration: "none" }}
              >
                <Pill variant="neutral">{f.venues?.name ?? "Venue"}</Pill>
              </Link>
            ))}
          </div>

          {/* Their exclusive deals. */}
          <div>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: "var(--muted)",
                marginBottom: "var(--space-2)",
              }}
            >
              Exclusive deals for you
            </div>
            {deals && deals.length > 0 ? (
              <div style={{ display: "grid", gap: "var(--space-2)" }}>
                {deals.map((d) => (
                  <DealCard key={d.id} deal={d} />
                ))}
              </div>
            ) : (
              <p style={mutedNote}>
                No live deals from your venues right now — we&apos;ll show them here the moment one posts a loyalty offer.
              </p>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

function DealCard({ deal }: { deal: Deal }) {
  return (
    <Link href={`/venue/${deal.venueId}`} style={{ textDecoration: "none", color: "inherit" }}>
      <div
        style={{
          padding: "var(--space-3) var(--space-4)",
          borderRadius: "var(--r-lg)",
          background: "var(--crimson-tint)",
          border: "1px solid var(--crimson-tint-2)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: 2 }}>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 9.5,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: "var(--crimson-700)",
              border: "1px solid var(--crimson-tint-2)",
              borderRadius: 999,
              padding: "1px 7px",
              background: "#fff",
            }}
          >
            Deal
          </span>
          {deal.venueName ? <span style={{ fontSize: 12.5, color: "var(--ink-2)", fontWeight: 600 }}>{deal.venueName}</span> : null}
        </div>
        <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>{deal.title}</div>
        {deal.details ? <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>{deal.details}</p> : null}
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
          {deal.code ? (
            <span
              style={{
                fontFamily: "var(--mono)",
                fontSize: 12,
                fontWeight: 700,
                color: "var(--crimson-700)",
                background: "#fff",
                border: "1px dashed var(--crimson-tint-2)",
                borderRadius: "var(--r-sm)",
                padding: "2px 8px",
              }}
            >
              {deal.code}
            </span>
          ) : null}
          {deal.endsAt ? <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Ends {shortDate(deal.endsAt)}</span> : null}
        </div>
      </div>
    </Link>
  );
}

/* ── Local news from businesses (live, public) ─────────────────────────────────────────── */

interface NewsPost {
  id: string;
  kind: "news" | "offer" | "event";
  title: string | null;
  body: string | null;
  publishedAt: string | null;
  venueId: string;
  venueName: string | null;
  venueLocality: string | null;
}

function LocalNews() {
  const trpc = useTrpc();
  const [posts, setPosts] = useState<NewsPost[] | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPosts(undefined);
    setError(false);
    trpc.posts.feed
      .query({ limit: 6 })
      .then((rows: unknown) => {
        if (cancelled) return;
        setPosts(Array.isArray(rows) ? (rows as NewsPost[]).slice(0, 5) : []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  return (
    <Section title="Local news">
      {error ? (
        <p style={mutedNote}>Couldn&apos;t load local updates just now.</p>
      ) : posts === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <div style={rowSkeleton} />
          <div style={rowSkeleton} />
        </div>
      ) : posts.length === 0 ? (
        <p style={mutedNote}>No updates from local businesses yet. Follow a few and their news will land here.</p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          {posts.map((p) => (
            <Link
              key={p.id}
              href={`/venue/${p.venueId}`}
              className={styles.row}
              style={{ display: "flex", gap: "var(--space-3)", padding: "10px 8px", borderRadius: "var(--r-md)", textDecoration: "none", color: "inherit" }}
            >
              <span aria-hidden style={{ fontSize: 16, lineHeight: "20px", flexShrink: 0 }}>
                {p.kind === "offer" ? "✦" : p.kind === "event" ? "◷" : "›"}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.title ?? p.body ?? "Update"}
                </span>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  {p.venueName ?? "A local business"}
                  {p.publishedAt ? ` · ${timeAgo(p.publishedAt)}` : ""}
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

/* ── Upcoming plans (live) ─────────────────────────────────────────────────────────────── */

interface PlanRow {
  id: string;
  title: string;
  plannedFor: string | null;
  venueCount: number;
}

function UpcomingPlans({ hasSession }: { hasSession: boolean }) {
  const trpc = useTrpc();
  const [plans, setPlans] = useState<PlanRow[] | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    const list = trpc.plans.list as unknown as { query: () => Promise<{ plans: PlanRow[] }> };
    list
      .query()
      .then((res) => {
        if (!cancelled) setPlans((res.plans ?? []).slice(0, 4));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, hasSession]);

  return (
    <Section title="Your plans" {...(hasSession ? { action: { label: "All plans", href: "/plans" } } : {})}>
      {!hasSession ? (
        <div>
          <p style={mutedNote}>Make plans — a night out, a weekend, a list to try — and save venues to them.</p>
          <div style={{ marginTop: "var(--space-3)" }}>
            <Link href="/account" style={{ textDecoration: "none" }}>
              <Button variant="pri" size="sm">Sign in</Button>
            </Link>
          </div>
        </div>
      ) : error ? (
        <p style={mutedNote}>Couldn&apos;t load your plans just now.</p>
      ) : plans === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <div style={rowSkeleton} />
          <div style={rowSkeleton} />
        </div>
      ) : plans.length === 0 ? (
        <div>
          <p style={mutedNote}>No plans yet — start one and add venues from anywhere on Roam.</p>
          <div style={{ marginTop: "var(--space-3)" }}>
            <Link href="/plans" style={{ textDecoration: "none" }}>
              <Button variant="pri" size="sm">＋ New plan</Button>
            </Link>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          {plans.map((p) => (
            <Link
              key={p.id}
              href={`/plans/${p.id}`}
              className={styles.row}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", padding: "10px 8px", borderRadius: "var(--r-md)", textDecoration: "none", color: "inherit" }}
            >
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
              <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
                {p.plannedFor ? `${planDateLabel(p.plannedFor)} · ` : ""}
                {p.venueCount === 1 ? "1 venue" : `${p.venueCount} venues`}
              </span>
            </Link>
          ))}
        </div>
      )}
    </Section>
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
