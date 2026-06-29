/**
 * Home — the signed-in hub (/home). One place that pulls together the surfaces a local cares
 * about day-to-day: your recent chats, your plans, what's happening near you, and your town's
 * forum — plus the Stage-5 market seam shown honestly as "coming soon".
 *
 * PUBLIC to view (browse-freely): the live sections that need an account (Recent chats, Your
 * plans, Followed venues) show a gentle sign-in nudge rather than gating the whole page. Local
 * sections re-root off the shared current place (useCurrentPlace) via the same PlaceSwitcher as
 * Explore/Town Hall, so Home, Explore and Town Hall always agree on "where you are".
 *
 * Layout is a real dashboard: a hero (greeting · place · quick actions), then a grid where the
 * content-rich sections (Recent chats, Your town carousel) span full width and the lighter
 * widgets pair up two-across on desktop. Each section loads independently (its own query +
 * skeleton/empty/error), so a slow or failed one never blocks the rest of the hub.
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

/** Time-aware greeting — a warmer header than a flat "Home". */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function Home() {
  const session = useSession();
  const { place, setPlace } = useCurrentPlace();

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ marginBottom: "var(--space-5)" }}>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 28, letterSpacing: "-.02em", margin: 0 }}>
          {greeting()}
        </h1>
        <p style={{ marginTop: 4, marginBottom: "var(--space-4)", color: "var(--ink-2)", fontSize: 14, lineHeight: 1.5 }}>
          Your chats, your plans, and what&apos;s happening in your town — all in one place.
        </p>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-2)" }}>
          <PlaceSwitcher value={place} onChange={setPlace} />
        </div>
        <div className={styles.quickActions}>
          <QuickAction href="/plans" glyph="＋" label="New plan" />
          <QuickAction href="/town-hall" glyph="✲" label="Start a topic" />
          <QuickAction href="/explore" glyph="✦" label="Find venues" />
          <QuickAction href="/friends" glyph="✉" label="Message a friend" />
        </div>
      </header>

      <div className={styles.grid}>
        <div className={styles.spanAll}>
          <RecentChats hasSession={!!session} />
        </div>

        <UpcomingPlans hasSession={!!session} />
        <FollowedVenues hasSession={!!session} />

        <div className={styles.spanAll}>
          <YourTown place={place} />
        </div>

        <LocalNews place={place} />
        <TownForum place={place} />

        <div className={styles.spanAll}>
          <MarketSeam place={place} />
        </div>
      </div>
    </main>
  );
}

function QuickAction({ href, glyph, label }: { href: string; glyph: string; label: string }) {
  return (
    <Link href={href} className={styles.qpill}>
      <span className={styles.qglyph} aria-hidden>{glyph}</span>
      {label}
    </Link>
  );
}

/* ── Section shell ─────────────────────────────────────────────────────────────────────── */

function Section({
  title,
  icon,
  count,
  action,
  children,
}: {
  title: string;
  icon: string;
  count?: number;
  action?: { label: string; href: string };
  children: React.ReactNode;
}) {
  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
          <span className={styles.iconChip} aria-hidden>{icon}</span>
          <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, margin: 0 }}>
            {title}
          </h2>
          {count != null && count > 0 ? <Pill variant="neutral" size="sm">{count}</Pill> : null}
        </div>
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

/** Initial letter for an avatar fallback. */
function initial(name: string | null | undefined): string {
  return (name ?? "").trim().replace(/^@/, "").charAt(0).toUpperCase() || "·";
}

/* ── Recent chats (live, auth-gated) ───────────────────────────────────────────────────── */

type ChatKind = "plan" | "group" | "direct";

interface ChatRow {
  id: string;
  isGroup: boolean;
  planId: string | null;
  kind: ChatKind;
  title: string | null;
  name: string | null;
  updatedAt: string;
  participantCount: number;
}

const CHAT_KIND: Record<ChatKind, { glyph: string; label: string; crim: boolean }> = {
  plan: { glyph: "🗓", label: "Plan chat", crim: true },
  group: { glyph: "◍", label: "Group", crim: false },
  direct: { glyph: "✉", label: "Direct", crim: false },
};

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
        if (!cancelled) setRows(Array.isArray(res) ? res.slice(0, 5) : []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, hasSession]);

  return (
    <Section title="Recent chats" icon="✦" {...(hasSession ? { action: { label: "All chats", href: "/threads" } } : {})}>
      {!hasSession ? (
        <SignInNudge note="Sign in to see your conversations and plans with people nearby." />
      ) : error ? (
        <p style={mutedNote}>Couldn&apos;t load your chats just now.</p>
      ) : rows === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <div style={rowSkeleton} />
          <div style={rowSkeleton} />
        </div>
      ) : rows.length === 0 ? (
        <p style={mutedNote}>No chats yet. Message a friend or open a plan to start one — it&apos;ll show up here.</p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          {rows.map((t) => {
            const meta = CHAT_KIND[t.kind] ?? CHAT_KIND.group;
            const name = t.name?.trim() || t.title?.trim() || meta.label;
            return (
              <Link
                key={t.id}
                href={`/threads/${t.id}`}
                className={styles.row}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", padding: "10px 8px", borderRadius: "var(--r-md)", textDecoration: "none", color: "inherit" }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 30, height: 30, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 14, flexShrink: 0,
                      background: meta.crim ? "var(--crimson-tint)" : "var(--paper-2)",
                      color: meta.crim ? "var(--crimson-700)" : "var(--ink-2)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    {meta.glyph}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {name}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                      {meta.label}{t.kind !== "direct" ? ` · ${t.participantCount} ${t.participantCount === 1 ? "person" : "people"}` : ""}
                    </span>
                  </span>
                </span>
                <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>{timeAgo(t.updatedAt)}</span>
              </Link>
            );
          })}
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
    <Section title={`${place.name} online`} icon="✦" action={{ label: "Explore", href: "/explore" }}>
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
        if (!cancelled) setTopics((res.topics ?? []).slice(0, 4));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, place.name]);

  return (
    <Section title="Town forum" icon="✲" action={{ label: "Town Hall", href: "/town-hall" }}>
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
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {topics.map((t) => (
            <Link
              key={t.id}
              href={`/town-hall/${t.id}`}
              className={`${styles.newsCard} ${styles.lift}`}
              style={{ flexDirection: "row", alignItems: "center", gap: "var(--space-3)" }}
            >
              <span
                aria-hidden
                style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 38, height: 38, borderRadius: 10, background: "var(--crimson-tint)", color: "var(--crimson-700)", flexShrink: 0 }}
              >
                <span style={{ fontSize: 10, lineHeight: 1 }}>▲</span>
                <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.1 }}>{t.upvoteCount}</span>
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
    <Section title="Followed venues" icon="♥" {...(hasSession ? { action: { label: "Manage", href: "/following" } } : {})}>
      {!hasSession ? (
        <SignInNudge note="Follow a business to unlock its exclusive loyalty deals — they'll appear here, just for followers." />
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
          {/* The businesses you follow — chips with an initial avatar. */}
          <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
            {follows.map((f) => {
              const name = f.venues?.name ?? "Venue";
              return (
                <Link key={f.venue_id} href={`/venue/${f.venues?.id ?? f.venue_id}`} className={styles.venueChip}>
                  <span aria-hidden style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700 }}>
                    {initial(name)}
                  </span>
                  {name}
                </Link>
              );
            })}
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
    <Link href={`/venue/${deal.venueId}`} className={styles.lift} style={{ textDecoration: "none", color: "inherit", display: "block", borderRadius: "var(--r-lg)" }}>
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
  media?: { type: "image"; url: string }[];
  publishedAt: string | null;
  venueId: string;
  venueName: string | null;
  venueLocality: string | null;
}

const NEWS_KIND: Record<NewsPost["kind"], { label: string; glyph: string }> = {
  news: { label: "News", glyph: "›" },
  offer: { label: "Offer", glyph: "✦" },
  event: { label: "Event", glyph: "◷" },
};

function LocalNews({ place }: { place: Place }) {
  const trpc = useTrpc();
  const [posts, setPosts] = useState<NewsPost[] | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPosts(undefined);
    setError(false);
    // Geofenced to the current town (same place centre as the rest of Home).
    trpc.posts.feed
      .query({ limit: 6, lat: place.lat, lng: place.lng })
      .then((rows: unknown) => {
        if (cancelled) return;
        setPosts(Array.isArray(rows) ? (rows as NewsPost[]).slice(0, 4) : []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, place.lat, place.lng]);

  return (
    <Section title={`${place.name} news`} icon="✦">
      {error ? (
        <p style={mutedNote}>Couldn&apos;t load local updates just now.</p>
      ) : posts === undefined ? (
        <div className={styles.newsGrid}>
          <div style={rowSkeleton} />
          <div style={rowSkeleton} />
        </div>
      ) : posts.length === 0 ? (
        <p style={mutedNote}>No updates from local businesses yet. Follow a few and their news will land here.</p>
      ) : (
        <div className={styles.newsGrid}>
          {posts.map((p) => {
            const meta = NEWS_KIND[p.kind] ?? NEWS_KIND.news;
            return (
              <Link key={p.id} href={`/venue/${p.venueId}`} className={`${styles.newsCard} ${styles.lift}`} style={{ padding: 0, overflow: "hidden" }}>
                {p.media && p.media.length > 0 ? (
                  // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
                  <img src={p.media[0]!.url} alt="" loading="lazy" style={{ width: "100%", height: 120, objectFit: "cover", display: "block", background: "var(--paper-2)" }} />
                ) : null}
                <span style={{ display: "flex", flexDirection: "column", gap: 6, padding: "var(--space-3) var(--space-4)" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--crimson-700)", background: "var(--crimson-tint)", border: "1px solid var(--crimson-tint-2)", borderRadius: 999, padding: "1px 8px" }}>
                      {meta.label}
                    </span>
                    {p.publishedAt ? <span style={{ fontSize: 11, color: "var(--muted)" }}>{timeAgo(p.publishedAt)}</span> : null}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {p.title ?? p.body ?? "Update"}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>{p.venueName ?? "A local business"}</span>
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/* ── Upcoming plans (live) ─────────────────────────────────────────────────────────────── */

interface PlanRow {
  id: string;
  title: string;
  plannedFor: string | null;
  headerUrl: string | null;
  venueCount: number;
}

/** Calm crimson gradient for plans without a custom header — matches PlanDetail / PlansList. */
const PLAN_GRADIENT = "linear-gradient(135deg, var(--crimson) 0%, var(--crimson-700) 55%, #7a0c28 100%)";

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
        if (!cancelled) setPlans((res.plans ?? []).slice(0, 6));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, hasSession]);

  return (
    <Section title="Your plans" icon="🗓" {...(hasSession ? { action: { label: "All plans", href: "/plans" } } : {})}>
      {!hasSession ? (
        <SignInNudge note="Make plans — a night out, a weekend, a list to try — and save venues to them." />
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
        <div className={styles.planTrack}>
          {plans.map((p) => (
            <Link
              key={p.id}
              href={`/plans/${p.id}`}
              className={styles.lift}
              style={{
                position: "relative", display: "flex", flexDirection: "column", justifyContent: "flex-end",
                minHeight: 140, padding: "var(--space-4)", borderRadius: "var(--r-lg)", overflow: "hidden",
                textDecoration: "none", color: "#fff",
                background: p.headerUrl ? "var(--paper-2)" : PLAN_GRADIENT,
                border: "1px solid var(--line)",
              }}
            >
              {p.headerUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
                <img src={p.headerUrl} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
              ) : null}
              <span aria-hidden style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,.55) 0%, rgba(0,0,0,.1) 52%, rgba(0,0,0,0) 80%)" }} />
              <span style={{ position: "relative", display: "flex", flexDirection: "column", gap: 6 }}>
                <span
                  style={{
                    alignSelf: "flex-start", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".04em", textTransform: "uppercase",
                    color: "#fff", background: "rgba(255,255,255,.18)", borderRadius: 999, padding: "2px 9px",
                  }}
                >
                  {p.plannedFor ? planDateLabel(p.plannedFor) : "No date yet"}
                </span>
                <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 16, lineHeight: 1.3, textShadow: "0 1px 12px rgba(0,0,0,.4)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {p.title}
                </span>
                <span style={{ fontSize: 12, color: "rgba(255,255,255,.85)" }}>
                  {p.venueCount === 1 ? "1 venue" : `${p.venueCount} venues`}
                </span>
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

/* ── Shared bits ───────────────────────────────────────────────────────────────────────── */

/** A consistent sign-in nudge for the auth-gated sections. */
function SignInNudge({ note }: { note: string }) {
  return (
    <div>
      <p style={mutedNote}>{note}</p>
      <div style={{ marginTop: "var(--space-3)" }}>
        <Link href="/account" style={{ textDecoration: "none" }}>
          <Button variant="pri" size="sm">Sign in</Button>
        </Link>
      </div>
    </div>
  );
}

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
