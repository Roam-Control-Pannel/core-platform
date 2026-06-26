/**
 * FeedList — the Explore Feed tab's real content (Discovery design Flow C).
 *
 * Reads `posts.feed` (published, moderation-approved, feed-destination posts, newest
 * first) and renders post cards with the design's type filter (All · Offers · Events ·
 * News) and a tagged card head (avatar · venue · time · OFFER/EVENT/NEWS tag). Ships every
 * applicable state WITH the feature (States matrix): content-shaped skeleton while loading,
 * an honest first-run empty state, and an error state — never a spinner, never "looks dead".
 *
 * Why the empty state matters here specifically: at launch there are no claimed venues, so
 * no posts, so the feed IS empty for essentially everyone on day one — the MEDIAN experience
 * worldwide (ARCHITECTURE.md), not an edge case. It must read as "new and waiting".
 *
 * Honesty over the mockup: the design card also shows a post image, a like count and a
 * distance. The feed data carries none of those yet, so we DON'T fake them — the card
 * renders what exists (kind, venue, time, title, body, link) and grows when the post model
 * does. The full post-detail / web two-pane reflow waits on that richer post data.
 *
 * Presentation reuses the established kit and tokens, so a token change repaints it.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, Pill } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { venuePath } from "../lib/routes";

export interface FeedPost {
  id: string;
  kind: "news" | "offer" | "event";
  title: string | null;
  body: string | null;
  publishedAt: string | null;
  venueId: string;
  venueName: string | null;
  venueLocality: string | null;
}

type KindFilter = "all" | "offer" | "event" | "news";

const FILTERS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "offer", label: "Offers" },
  { value: "event", label: "Events" },
  { value: "news", label: "News" },
];

export function FeedList({ placeName }: { placeName: string }) {
  const trpc = useTrpc();
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<KindFilter>("all");

  useEffect(() => {
    let cancelled = false;
    setPosts(null);
    setError(null);
    trpc.posts.feed
      .query({ limit: 25 })
      .then((rows) => {
        if (!cancelled) setPosts(rows as FeedPost[]);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load the feed.");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  const shown = useMemo(
    () => (!posts ? [] : filter === "all" ? posts : posts.filter((p) => p.kind === filter)),
    [posts, filter],
  );

  if (error) return <FeedError message={error} />;
  if (posts === null) return <FeedSkeleton />;
  // Empty BEFORE filtering — a genuinely empty feed gets the inviting first-run state, not
  // a filter row over nothing.
  if (posts.length === 0) return <FeedEmpty placeName={placeName} />;

  return (
    <div style={{ maxWidth: 640 }}>
      {/* type filters — map to the composer's post types */}
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
        {FILTERS.map((f) => (
          <button key={f.value} onClick={() => setFilter(f.value)} style={{ all: "unset", cursor: "pointer" }}>
            <Pill variant={filter === f.value ? "on" : "neutral"} size="sm">
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
            <PostCard key={p.id} post={p} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Post-kind tag — OFFER carries the crimson emphasis; EVENT/NEWS are neutral. */
function KindTag({ kind }: { kind: FeedPost["kind"] }) {
  const isOffer = kind === "offer";
  return (
    <span
      style={{
        fontFamily: "var(--mono)",
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        padding: "3px 9px",
        borderRadius: 999,
        whiteSpace: "nowrap",
        background: isOffer ? "var(--crimson-tint)" : "var(--paper-2)",
        color: isOffer ? "var(--crimson-700)" : "var(--muted)",
        border: `1px solid ${isOffer ? "var(--crimson-tint-2)" : "var(--line)"}`,
      }}
    >
      {kind}
    </span>
  );
}

function PostCard({ post }: { post: FeedPost }) {
  return (
    <Card style={{ overflow: "hidden" }}>
      {/* head: avatar · venue + time · kind tag */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-3) var(--space-4) 0",
        }}
      >
        <span
          aria-hidden
          style={{
            flex: "0 0 auto",
            width: 30,
            height: 30,
            borderRadius: "50%",
            background: "var(--paper-2)",
            border: "1px solid var(--line)",
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {post.venueName ? (
            <div
              style={{
                fontFamily: "var(--display)",
                fontWeight: 600,
                fontSize: 13.5,
                color: "var(--ink)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
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
          <div
            className="t-h3"
            style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-1)" }}
          >
            {post.title}
          </div>
        ) : null}

        {post.body ? (
          <p style={{ margin: 0, lineHeight: 1.55, color: "var(--ink-2)", fontSize: 14.5 }}>{post.body}</p>
        ) : null}

        {post.venueName ? (
          <div style={{ marginTop: "var(--space-3)" }}>
            <Link href={venuePath(post.venueId)} style={{ textDecoration: "none" }}>
              <Pill variant="ghost-crim" size="sm">
                View venue →
              </Pill>
            </Link>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** Compact relative-ish date. Localisation of the exact format is a later concern. */
function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const day = 86_400_000;
  if (diffMs < day) return "Today";
  if (diffMs < 2 * day) return "Yesterday";
  const days = Math.floor(diffMs / day);
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
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
