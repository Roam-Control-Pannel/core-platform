/**
 * FeedList — the Explore Feed tab's real content, replacing the placeholder.
 *
 * Reads `posts.feed` (published, moderation-approved, feed-destination posts, newest
 * first) and renders post cards. Ships every applicable state WITH the feature (States
 * matrix): content-shaped skeleton while loading, an honest first-run empty state, and
 * an error state — never a spinner, never "looks dead".
 *
 * Why the empty state matters here specifically: at launch there are no claimed venues,
 * so there are no posts, so the feed IS empty for essentially everyone on day one. That
 * is the MEDIAN experience worldwide, not an edge case (ARCHITECTURE.md). It must read
 * as "new and waiting", inviting the place's businesses to post — not as a broken page.
 *
 * Presentation reuses the established kit: Card surfaces, the mono eyebrow label for the
 * post kind, display font for titles, the same tinted treatments as VenueCard. Kept in
 * lockstep with the design tokens so a token change repaints it.
 */
"use client";

import { useEffect, useState } from "react";
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

export function FeedList({ placeName }: { placeName: string }) {
  const trpc = useTrpc();
  const [posts, setPosts] = useState<FeedPost[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (error) return <FeedError message={error} />;
  if (posts === null) return <FeedSkeleton />;
  if (posts.length === 0) return <FeedEmpty placeName={placeName} />;

  return (
    <div style={{ display: "grid", gap: "var(--space-4)", maxWidth: 640 }}>
      {posts.map((p) => (
        <PostCard key={p.id} post={p} />
      ))}
    </div>
  );
}

/** Map a post kind to its eyebrow label + tint. Offers get the crimson emphasis. */
function kindLabel(kind: FeedPost["kind"]): string {
  if (kind === "offer") return "Offer";
  if (kind === "event") return "Event";
  return "News";
}

function PostCard({ post }: { post: FeedPost }) {
  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            color: post.kind === "offer" ? "var(--crimson-700)" : "var(--muted)",
          }}
        >
          {kindLabel(post.kind)}
        </span>
        {post.publishedAt ? (
          <span style={{ fontFamily: "var(--ui)", fontSize: 12, color: "var(--faint)" }}>
            {formatWhen(post.publishedAt)}
          </span>
        ) : null}
      </div>

      {post.title ? (
        <div
          className="t-h3"
          style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-1)" }}
        >
          {post.title}
        </div>
      ) : null}

      {post.body ? (
        <p style={{ margin: 0, lineHeight: 1.55, color: "var(--ink-2)", fontSize: 14.5 }}>
          {post.body}
        </p>
      ) : null}

      {post.venueName ? (
        <div style={{ marginTop: "var(--space-3)" }}>
          <Link
            href={venuePath(post.venueId)}
            style={{ textDecoration: "none" }}
          >
            <Pill variant="ghost-crim" size="sm">
              {post.venueName}
              {post.venueLocality ? ` · ${post.venueLocality}` : ""}
            </Pill>
          </Link>
        </div>
      ) : null}
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
