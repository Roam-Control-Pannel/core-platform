/**
 * Home — the signed-in hub (/home), laid out as a WALL (per the hi-fi mockup): a main feed
 * column — date kicker + personal greeting, quick-action cards, then the local feed (business
 * posts + Town Hall topics, see HomeFeed) — beside a right RAIL of widgets (town forum,
 * trending venues, recent chats, deals …). The rail keeps the Customise sheet + drag-reorder +
 * cross-device layout persistence; the feed is the fixed heart of the page.
 *
 * PUBLIC to view (browse-freely): the live sections that need an account (Recent chats, Your
 * plans, Followed venues) show a gentle sign-in nudge rather than gating the whole page. Local
 * sections re-root off the shared current place (useCurrentPlace) via the same PlaceSwitcher as
 * Explore/Town Hall, so Home, Explore and Town Hall always agree on "where you are".
 *
 * Each section loads independently (its own query + skeleton/empty/error), so a slow or failed
 * one never blocks the rest of the hub.
 */
"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, Button, Pill, Icon, type IconName } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { PlaceSwitcher, type Place } from "./PlaceSwitcher";
import { useCurrentPlace } from "../lib/currentPlace";
import { OfferCard, type ConsumerOffer } from "./OfferCard";
import { NearbyDepartures } from "./NearbyDepartures";
import { isWithinIreland } from "../lib/transitRegion";
import { townHallAuthor, timeAgo, type TownHallAuthor } from "../lib/townHall";
import { planDateLabel } from "../lib/planDate";
import { useHomeLayoutSync } from "./useHomeLayoutSync";
import { HomeCustomize, type CustomizeItem } from "./HomeCustomize";
import { BirthdayTreats } from "./BirthdayTreats";
import { DealsHomeWidget } from "./Deals";
import { HomeFeed } from "./HomeFeed";
import styles from "./Home.module.css";

/**
 * The Home widget registry. Each dashboard section is a descriptor — id (stable, used to persist
 * the user's order), a friendly label for the Customise sheet, a grid span (full width or a
 * pairable half), an optional `condition` (the transit widget only exists inside Ireland), and a
 * `render` given the live context. The user's saved layout reorders / hides these; anything not
 * in their saved order is appended in this order (see reconcile), so new widgets always surface.
 */
export interface WidgetCtx {
  hasSession: boolean;
  place: Place;
}
export interface HomeWidget {
  id: string;
  label: string;
  span: "full" | "half";
  condition?: (place: Place) => boolean;
  render: (ctx: WidgetCtx) => React.ReactNode;
}

/**
 * The rail renders every widget at rail width, one per row, in the user's saved order —
 * `span` is kept for layout-data compatibility but no longer affects rendering. The old
 * "local-news" widget is gone: the main-column feed (HomeFeed) IS the local news now.
 */
export const HOME_WIDGETS: HomeWidget[] = [
  { id: "town-forum", label: "Town forum", span: "half", render: ({ place }) => <TownForum place={place} /> },
  { id: "your-town", label: "Trending nearby", span: "full", render: ({ place }) => <TrendingNearby place={place} /> },
  { id: "recent-chats", label: "Recent chats", span: "half", render: ({ hasSession }) => <RecentChats hasSession={hasSession} /> },
  { id: "affiliate-deals", label: "Deals", span: "half", render: () => <DealsHomeWidget /> },
  {
    id: "transit",
    label: "Nearby transit",
    span: "full",
    condition: (p) => isWithinIreland(p.lat, p.lng),
    render: ({ place }) => <NearbyDepartures lat={place.lat} lng={place.lng} placeName={place.name} />,
  },
  { id: "upcoming-plans", label: "Your plans", span: "half", render: ({ hasSession }) => <UpcomingPlans hasSession={hasSession} /> },
  { id: "followed-venues", label: "Followed venues", span: "half", render: ({ hasSession }) => <FollowedVenues hasSession={hasSession} /> },
  { id: "saved-deals", label: "Saved deals", span: "half", render: ({ hasSession }) => <SavedDeals hasSession={hasSession} /> },
  { id: "market", label: "Marketplace", span: "full", render: ({ place }) => <MarketSeam place={place} /> },
];
export const HOME_WIDGET_IDS: readonly string[] = HOME_WIDGETS.map((w) => w.id);

/** How many widgets Home's rail shows — the full set lives in Basecamp. */
const RAIL_LIMIT = 5;

/** Time-aware greeting — a warmer header than a flat "Home". */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function Home() {
  const session = useSession();
  const trpc = useTrpc();
  const { place, setPlace } = useCurrentPlace();
  const { layout, move, reorder, toggle, reset, flushLayout } = useHomeLayoutSync(HOME_WIDGET_IDS);
  const [customizing, setCustomizing] = useState(false);
  const signedIn = !!session;

  // Date kicker ("MONDAY · 6 JULY · 14:31") — client-only so SSR HTML never disagrees with the
  // viewer's clock; the line's height is reserved in CSS so nothing jumps when it fills in.
  const [kicker, setKicker] = useState("");
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const wd = d.toLocaleDateString("en-GB", { weekday: "long" });
      const dm = d.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
      const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      setKicker(`${wd} · ${dm} · ${hm}`.toUpperCase());
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);

  // First name for the greeting — the profile's display name, first word.
  const [firstName, setFirstName] = useState<string | null>(null);
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) {
      setFirstName(null);
      return;
    }
    let cancelled = false;
    const byId = trpc.profiles.byId as unknown as {
      query: (i: { userId: string }) => Promise<{ displayName: string | null } | null>;
    };
    byId
      .query({ userId: uid })
      .then((p) => {
        if (cancelled) return;
        const first = (p?.displayName ?? "").trim().split(/\s+/)[0] ?? "";
        setFirstName(first || null);
      })
      .catch(() => {
        /* greeting stays impersonal */
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, session]);

  const byId = useMemo(() => new Map(HOME_WIDGETS.map((w) => [w.id, w])), []);

  // Widgets applicable to the current context (transit only inside Ireland), in the user's order.
  const applicable = useMemo(() => {
    const list: HomeWidget[] = [];
    for (const id of layout.order) {
      const w = byId.get(id);
      if (w && (!w.condition || w.condition(place))) list.push(w);
    }
    return list;
  }, [layout.order, byId, place]);
  const applicableIds = useMemo(() => applicable.map((w) => w.id), [applicable]);

  const ctx: WidgetCtx = { hasSession: !!session, place };
  const visible = applicable.filter((w) => !layout.hidden.includes(w.id));
  // The rail shows the TOP of the user's order; the full set (at full width) lives in Basecamp.
  const railWidgets = visible.slice(0, RAIL_LIMIT);
  const customizeItems: CustomizeItem[] = applicable.map((w) => ({
    id: w.id,
    label: w.label,
    hidden: layout.hidden.includes(w.id),
  }));

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ marginBottom: "var(--space-2)" }}>
        <div className={styles.headerRow}>
          <div style={{ minWidth: 0 }}>
            <div className={styles.kicker}>{kicker}</div>
            <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 32, letterSpacing: "-.02em", margin: 0 }}>
              {greeting()}
              {firstName ? `, ${firstName}` : ""}
            </h1>
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-2)", color: "var(--ink-2)", fontSize: 14.5, lineHeight: 1.5 }}>
              <span>Here&apos;s what&apos;s moving in</span>
              <PlaceSwitcher value={place} onChange={setPlace} />
              <button
                type="button"
                onClick={() => setCustomizing(true)}
                className={styles.customize}
                aria-haspopup="dialog"
              >
                <Icon name="settings" size={14} /> Customise
              </button>
            </div>
          </div>
          <HomePulse place={place} signedIn={signedIn} />
        </div>

        <div className={styles.qgrid}>
          <QuickAction href="/plans" glyph="plus" label="New plan" />
          <QuickAction href="/town-hall" glyph="forum" label="Start a topic" />
          <QuickAction href="/explore" glyph="search" label="Find venues" />
          <QuickAction href="/friends" glyph="chat" label="Message a friend" />
        </div>
      </header>

      <div className={styles.layout}>
        {/* Main column: the wall. */}
        <div style={{ minWidth: 0 }}>
          {/* Ephemeral birthday moment — self-hides outside birthday week; not part of the
              customisable/hideable rail (a birthday treat shouldn't be dismissable). */}
          <BirthdayTreats />
          <HomeFeed place={place} />
        </div>

        {/* Widget rail: the top of the user's (customisable) stack — the full set is Basecamp. */}
        <aside className={styles.rail}>
          {railWidgets.length === 0 ? (
            <EmptyDashboard onCustomise={() => setCustomizing(true)} />
          ) : (
            railWidgets.map((w) => <Fragment key={w.id}>{w.render(ctx)}</Fragment>)
          )}
          <Link href="/basecamp" className={styles.basecampLink}>
            <span className={styles.qtile} aria-hidden><Icon name="grip" size={16} /></span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>Basecamp</span>
              <span style={{ display: "block", fontSize: 12, color: "var(--muted)" }}>All your widgets, full size</span>
            </span>
            <Icon name="chevronRight" size={16} style={{ color: "var(--faint)", flexShrink: 0 }} />
          </Link>
        </aside>
      </div>

      <HomeCustomize
        open={customizing}
        onClose={() => { setCustomizing(false); flushLayout(); }}
        items={customizeItems}
        onMove={(id, dir) => move(id, dir, applicableIds)}
        onReorder={(id, toIndex) => reorder(id, toIndex, applicableIds)}
        onToggle={toggle}
        onReset={reset}
      />
    </main>
  );
}

/** Shown when the user has hidden every section — a gentle way back to the Customise sheet. */
function EmptyDashboard({ onCustomise }: { onCustomise: () => void }) {
  return (
    <Card style={{ padding: "var(--space-6)", textAlign: "center" }}>
      <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 14, lineHeight: 1.5 }}>
        You&apos;ve hidden every section.
      </p>
      <div style={{ marginTop: "var(--space-3)" }}>
        <Button onClick={onCustomise}>Customise home</Button>
      </div>
    </Card>
  );
}

function QuickAction({ href, glyph, label }: { href: string; glyph: IconName; label: string }) {
  return (
    <Link href={href} className={styles.qcard}>
      <span className={styles.qtile} aria-hidden><Icon name={glyph} size={16} /></span>
      {label}
    </Link>
  );
}

/* ── Pulse — the header stat card (new posts today · topics live · friends) ───────────────── */

function HomePulse({ place, signedIn }: { place: Place; signedIn: boolean }) {
  const trpc = useTrpc();
  const [postsToday, setPostsToday] = useState<number | null>(null);
  const [topicsLive, setTopicsLive] = useState<number | null>(null);
  const [friends, setFriends] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPostsToday(null);
    setTopicsLive(null);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    trpc.posts.feed
      .query({ limit: 30, lat: place.lat, lng: place.lng })
      .then((rows: unknown) => {
        if (cancelled || !Array.isArray(rows)) return;
        const n = (rows as { publishedAt: string | null }[]).filter(
          (p) => p.publishedAt && new Date(p.publishedAt).getTime() >= midnight.getTime(),
        ).length;
        setPostsToday(n);
      })
      .catch(() => {});
    const listTopics = trpc.townHall.listTopics as unknown as {
      query: (i: { localityName: string; sort: "hot" }) => Promise<{ topics: unknown[] }>;
    };
    listTopics
      .query({ localityName: place.name, sort: "hot" })
      .then((res) => {
        if (!cancelled) setTopicsLive((res.topics ?? []).length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [trpc, place.lat, place.lng, place.name]);

  useEffect(() => {
    if (!signedIn) {
      setFriends(null);
      return;
    }
    let cancelled = false;
    const mf = trpc.social.myFriends as unknown as {
      query: () => Promise<{ ok: boolean; friends?: unknown[] }>;
    };
    mf.query()
      .then((r) => {
        if (!cancelled) setFriends((r.friends ?? []).length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [trpc, signedIn]);

  const cells: { value: number; label: string; crim?: boolean }[] = [];
  if (postsToday != null) cells.push({ value: postsToday, label: "new posts today" });
  if (topicsLive != null) cells.push({ value: topicsLive, label: "topics live" });
  if (friends != null) cells.push({ value: friends, label: "friends", crim: true });
  if (cells.length === 0) return null;

  return (
    <Card style={{ display: "flex", alignItems: "stretch", padding: "var(--space-3) var(--space-2)", alignSelf: "start" }}>
      {cells.map((c, i) => (
        <Fragment key={c.label}>
          {i > 0 ? <span aria-hidden style={{ width: 1, background: "var(--line)", margin: "2px 0" }} /> : null}
          <span style={{ display: "flex", flexDirection: "column", gap: 2, padding: "2px 18px", textAlign: "left" }}>
            <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 24, lineHeight: 1.1, letterSpacing: "-.02em", color: c.crim ? "var(--crimson)" : "var(--ink-hi)" }}>
              {c.value}
            </span>
            <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>{c.label}</span>
          </span>
        </Fragment>
      ))}
    </Card>
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
  icon: IconName;
  count?: number;
  action?: { label: string; href: string };
  children: React.ReactNode;
}) {
  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
          <span className={styles.iconChip} aria-hidden><Icon name={icon} size={15} /></span>
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

const CHAT_KIND: Record<ChatKind, { glyph: IconName; label: string; crim: boolean }> = {
  plan: { glyph: "plan", label: "Plan chat", crim: true },
  group: { glyph: "users", label: "Group", crim: false },
  direct: { glyph: "chat", label: "Direct", crim: false },
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
        if (!cancelled) setRows(Array.isArray(res) ? res.slice(0, 3) : []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, hasSession]);

  return (
    <Section title="Recent chats" icon="sparkle" {...(hasSession ? { action: { label: "All chats", href: "/threads" } } : {})}>
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
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", padding: "6px 8px", borderRadius: "var(--r-md)", textDecoration: "none", color: "inherit" }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 26, height: 26, borderRadius: "50%", display: "grid", placeItems: "center", flexShrink: 0,
                      background: meta.crim ? "var(--crimson-tint)" : "var(--paper-2)",
                      color: meta.crim ? "var(--crimson-700)" : "var(--ink-2)",
                      border: "1px solid var(--line)",
                    }}
                  >
                    <Icon name={meta.glyph} size={13} />
                  </span>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {name}
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap", flexShrink: 0 }}>
                      {meta.label}{t.kind !== "direct" ? ` · ${t.participantCount} ${t.participantCount === 1 ? "person" : "people"}` : ""}
                    </span>
                  </span>
                </span>
                <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap", flexShrink: 0 }}>{timeAgo(t.updatedAt)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/* ── Trending nearby (live: ranked venue rows — the mockup's compact rail list) ─────────── */

/** The subset of a venues.near row the trending rows use. */
interface NearRow {
  id: string;
  name: string;
  category: string | null;
  rating: number | null;
  ratingCount?: number | null;
  primaryTypeLabel?: string | null;
}

function TrendingNearby({ place }: { place: Place }) {
  const trpc = useTrpc();
  const [venues, setVenues] = useState<NearRow[] | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setVenues(undefined);
    setError(false);
    trpc.venues.near
      .query({ lat: place.lat, lng: place.lng, limit: 12 })
      .then((rows: unknown) => {
        if (cancelled) return;
        const list = Array.isArray(rows) ? (rows as NearRow[]) : [];
        // "Trending" = the best-reviewed of what's nearby: rating desc, review volume breaking ties.
        const ranked = [...list].sort(
          (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.ratingCount ?? 0) - (a.ratingCount ?? 0),
        );
        setVenues(ranked.slice(0, 5));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, place.lat, place.lng]);

  return (
    <Section title="Trending nearby" icon="sparkle" action={{ label: "Explore", href: "/explore" }}>
      {error ? (
        <p style={mutedNote}>Couldn&apos;t load venues near you just now.</p>
      ) : venues === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <div style={rowSkeleton} />
          <div style={rowSkeleton} />
          <div style={rowSkeleton} />
        </div>
      ) : venues.length === 0 ? (
        <p style={mutedNote}>No venues found near {place.name} yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 2 }}>
          {venues.map((v, i) => (
            <Link
              key={v.id}
              href={`/venue/${v.id}`}
              className={styles.row}
              style={{ display: "flex", alignItems: "center", gap: 11, padding: "7px 8px", textDecoration: "none", color: "inherit" }}
            >
              <span style={{ width: 14, fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700, color: "var(--muted)", flexShrink: 0, textAlign: "center" }}>
                {i + 1}
              </span>
              <span aria-hidden style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontSize: 13.5, fontWeight: 700, flexShrink: 0 }}>
                {initial(v.name)}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {v.name}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--muted)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {v.primaryTypeLabel ?? v.category ?? "Venue"}
                </span>
              </span>
              {v.rating != null ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 12.5, fontWeight: 600, color: "var(--ink-hi)", flexShrink: 0 }}>
                  <span style={{ color: "var(--gold)" }}>★</span>
                  {v.rating.toFixed(1)}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </Section>
  );
}

/* ── Town forum (live: top Town Hall topics) ───────────────────────────────────────────── */

interface ForumTopic {
  id: string;
  slug: string | null;
  locality: string;
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
    <Section title="Town forum" icon="forum" action={{ label: "Town Hall", href: "/town-hall" }}>
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
              href={t.slug ? `/town-hall/${t.locality}/${t.slug}` : `/town-hall/${t.id}`}
              className={`${styles.newsCard} ${styles.lift}`}
              style={{ flexDirection: "row", alignItems: "center", gap: "var(--space-3)" }}
            >
              <span
                aria-hidden
                style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 38, height: 38, borderRadius: 10, background: "var(--crimson-tint)", color: "var(--crimson-700)", flexShrink: 0 }}
              >
                <Icon name="upvote" size={12} />
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

/* ── Saved deals (live, auth-gated) ─────────────────────────────────────────────────────── */

function SavedDeals({ hasSession }: { hasSession: boolean }) {
  const trpc = useTrpc();
  const [offers, setOffers] = useState<ConsumerOffer[] | undefined>(undefined);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    const saved = trpc.offers.saved as unknown as { query: () => Promise<ConsumerOffer[]> };
    saved.query().then((o) => { if (!cancelled) setOffers(Array.isArray(o) ? o : []); }).catch(() => { if (!cancelled) setOffers([]); });
    return () => { cancelled = true; };
  }, [trpc, hasSession]);

  // Only meaningful signed in; the Followed-venues card already carries the signed-out nudge.
  if (!hasSession) return null;

  return (
    <Section title="Saved deals" icon="ticket">
      {offers === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          <div style={rowSkeleton} />
        </div>
      ) : offers.length === 0 ? (
        <p style={mutedNote}>Deals you save will appear here, ready to redeem in-venue.</p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {offers.map((o) => (
            <OfferCard key={o.id} offer={o} showVenue />
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
  saved: boolean;
  redeemed: boolean;
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
    <Section title="Followed venues" icon="heart" {...(hasSession ? { action: { label: "Manage", href: "/following" } } : {})}>
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
                  <OfferCard key={d.id} offer={d} showVenue />
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
    <Section title="Your plans" icon="plan" {...(hasSession ? { action: { label: "All plans", href: "/plans" } } : {})}>
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
      glyph="shop"
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

function SeamCard({ title, glyph, blurb }: { title: string; glyph: IconName; blurb: string }) {
  return (
    <Card flat style={{ padding: "var(--space-4)", background: "var(--paper-2)", borderStyle: "dashed" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
        <Icon name={glyph} size={18} style={{ color: "var(--crimson-700)", opacity: 0.6 }} />
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
