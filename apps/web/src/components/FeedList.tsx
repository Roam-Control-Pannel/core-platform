/**
 * FeedList — the Explore Feed tab (Discovery design Flow C).
 *
 * Reads `posts.feed` (published, moderation-approved, feed-destination posts, newest first)
 * and renders the design's type filter (All · Offers · Events · News) over a list of tagged
 * post cards. Ships every applicable state WITH the feature (States matrix): content-shaped
 * skeleton, an honest first-run empty state, and an error state.
 *
 * Layout (design parity):
 *   - Mobile: a single column; tapping a post opens the /feed/[postId] detail screen.
 *   - Web (≥1024): the master-detail two-pane — the list on the left, the SELECTED post's
 *     detail sticky on the right (clicking a card selects it in place rather than navigating).
 *
 * Why the empty state matters here: at launch there are no claimed venues, so no posts, so the
 * feed IS empty for essentially everyone on day one — the MEDIAN experience (ARCHITECTURE.md),
 * not an edge case. It must read as "new and waiting".
 */
"use client";

import { useEffect, useMemo, useState, type MouseEvent } from "react";
import Link from "next/link";
import { Card, Pill } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { type FeedPost, KindTag, formatWhen, PostDetail } from "./PostDetail";
import styles from "./FeedList.module.css";

type KindFilter = "all" | "offer" | "event" | "news";

const FILTERS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "offer", label: "Offers" },
  { value: "event", label: "Events" },
  { value: "news", label: "News" },
];

export function FeedList({ placeName, lat, lng }: { placeName: string; lat: number; lng: number }) {
  const trpc = useTrpc();
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPosts(null);
    setError(null);
    // Geofenced to the browsing town: pass the place centre so the feed shows only the
    // businesses in (and around) this town, not the whole network.
    trpc.posts.feed
      .query({ limit: 25, lat, lng })
      .then((rows) => {
        if (!cancelled) setPosts(rows as FeedPost[]);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load the feed.");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, lat, lng]);

  const shown = useMemo(
    () => (!posts ? [] : filter === "all" ? posts : posts.filter((p) => p.kind === filter)),
    [posts, filter],
  );

  // Keep a valid selection for the web detail pane: default to the first shown post, and
  // re-point if the current selection filtered out.
  useEffect(() => {
    if (shown.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((cur) => (cur && shown.some((p) => p.id === cur) ? cur : shown[0]!.id));
  }, [shown]);

  if (error) return <FeedError message={error} />;
  if (posts === null) return <FeedSkeleton />;
  // Empty BEFORE filtering — a genuinely empty feed gets the inviting first-run state.
  if (posts.length === 0) return <FeedEmpty placeName={placeName} />;

  const selected = shown.find((p) => p.id === selectedId) ?? shown[0] ?? null;

  // On web a click selects in-pane; on phones it falls through to the Link (the detail route).
  const onCardClick = (e: MouseEvent, post: FeedPost) => {
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches) {
      e.preventDefault();
      setSelectedId(post.id);
    }
  };

  return (
    <div className={styles.layout}>
      <div>
        {/* type filters — map to the composer's post types */}
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
          {FILTERS.map((f) => (
            <button key={f.value} onClick={() => setFilter(f.value)} style={{ all: "unset", cursor: "pointer" }}>
              <Pill variant={filter === f.value ? "crim" : "neutral"} size="sm">
                {f.label}
              </Pill>
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: 14, padding: "var(--space-4) 0" }}>
            No {filter === "all" ? "" : `${filter} `}posts here yet.
          </p>
        ) : (
          <div style={{ display: "grid", gap: "var(--space-4)" }}>
            {shown.map((p) => (
              <PostCard key={p.id} post={p} active={selected?.id === p.id} onClick={(e) => onCardClick(e, p)} />
            ))}
          </div>
        )}
      </div>

      {/* Web-only detail pane (the master-detail right side). */}
      <div className={styles.detail}>{selected ? <PostDetail post={selected} /> : null}</div>
    </div>
  );
}

/**
 * A feed list card. The whole card is a link to the post-detail route (/feed/[postId]) — the
 * mobile navigation; on web, onClick intercepts to select the post in the detail pane. `active`
 * marks the card that drives the web pane.
 */
function PostCard({ post, active, onClick }: { post: FeedPost; active: boolean; onClick: (e: MouseEvent) => void }) {
  return (
    <Link href={`/feed/${post.id}`} onClick={onClick} className={styles.card} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card style={active ? { borderColor: "var(--crimson-tint-2)", boxShadow: "var(--shadow-pop)" } : undefined}>
        {/* head: avatar · venue + time · kind tag */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-3) var(--space-4) 0" }}>
          <span
            aria-hidden
            style={{ flex: "0 0 auto", width: 30, height: 30, borderRadius: "50%", background: "var(--paper-2)", border: "1px solid var(--line)" }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            {post.venueName ? (
              <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 13.5, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {post.venueName}
              </div>
            ) : null}
            {post.publishedAt ? (
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--faint)", marginTop: 1 }}>
                {formatWhen(post.publishedAt)}
                {post.venueLocality ? ` · ${post.venueLocality}` : ""}
              </div>
            ) : null}
          </div>
          <KindTag kind={post.kind} />
        </div>

        <div style={{ padding: "var(--space-3) var(--space-4) var(--space-4)" }}>
          {post.title ? (
            <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-1)" }}>
              {post.title}
            </div>
          ) : null}
          {post.body ? (
            <p
              style={{
                margin: 0,
                lineHeight: 1.55,
                color: "var(--ink-2)",
                fontSize: 14.5,
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {post.body}
            </p>
          ) : null}
        </div>
      </Card>
    </Link>
  );
}

function FeedSkeleton() {
  return (
    <div style={{ display: "grid", gap: "var(--space-4)", maxWidth: 640 }}>
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          style={{
            borderRadius: 16,
            border: "1px solid var(--line)",
            background: "var(--card)",
            padding: "var(--space-4)",
            display: "grid",
            gap: "var(--space-2)",
          }}
        >
          <div style={{ height: 10, width: "20%", background: "var(--paper-2)", borderRadius: 6 }} />
          <div style={{ height: 16, width: "60%", background: "var(--paper-2)", borderRadius: 6 }} />
          <div style={{ height: 12, width: "90%", background: "var(--paper-2)", borderRadius: 6 }} />
          <div style={{ height: 12, width: "75%", background: "var(--paper-2)", borderRadius: 6 }} />
        </div>
      ))}
    </div>
  );
}

function FeedEmpty({ placeName }: { placeName: string }) {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)", maxWidth: 480, margin: "0 auto" }}>
      <div
        aria-hidden
        style={{
          width: 56,
          height: 56,
          margin: "0 auto var(--space-4)",
          borderRadius: "50%",
          background: "var(--crimson-tint)",
          display: "grid",
          placeItems: "center",
          fontSize: 24,
          color: "var(--crimson-700)",
        }}
      >
        ◍
      </div>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        The feed for {placeName} is just getting started
      </div>
      <p style={{ color: "var(--muted)", lineHeight: 1.55 }}>
        When venues here post news, offers and events, they&apos;ll appear in this feed.
        Browse what&apos;s nearby in the meantime — and if you run a place in {placeName},
        claiming it lets you post to people close by.
      </p>
    </div>
  );
}

function FeedError({ message }: { message: string }) {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Couldn&apos;t load the feed
      </div>
      <p style={{ color: "var(--muted)" }}>{message}</p>
    </div>
  );
}
