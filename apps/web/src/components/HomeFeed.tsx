/**
 * HomeFeed — the Home "wall": one scrollable local feed in the main column (Facebook-style),
 * mixing rich business-post cards with Town Hall topic cards, filtered by a Seg:
 *
 *   For you    — geofenced business posts interleaved with the town's hot topics.
 *   Following  — posts from venues the viewer follows (sign-in nudge when signed out).
 *   Nearby     — geofenced business posts only.
 *
 * Data comes from the SAME public reads the old widgets used (posts.feed, townHall.listTopics,
 * social.myFollows) — this component is presentation: each post is a full card (venue · kind chip
 * · title · body · image · share), each topic a discussion card (upvote count · replies). Every
 * card deep-links to its permalink. Loads independently per tab; failures degrade to a note.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, Pill, Seg, Icon, Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import type { Place } from "./PlaceSwitcher";
import { CopyLinkButton } from "./CopyLinkButton";
import { townHallAuthor, timeAgo, type TownHallAuthor } from "../lib/townHall";

interface FeedPost {
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

interface FeedTopic {
  id: string;
  slug: string | null;
  locality: string;
  title: string;
  body: string;
  upvoteCount: number;
  replyCount: number;
  createdAt: string;
  lastActivityAt: string | null;
  author: TownHallAuthor;
}

type FeedItem = { key: string; at: number; node: React.ReactNode };

type Tab = "foryou" | "following" | "nearby";

const KIND_LABEL: Record<FeedPost["kind"], string> = { news: "News", offer: "Offer", event: "Event" };

function ts(iso: string | null | undefined): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export function HomeFeed({ place }: { place: Place }) {
  const trpc = useTrpc();
  const session = useSession();
  const signedIn = !!session;
  const [tab, setTab] = useState<Tab>("foryou");
  const [posts, setPosts] = useState<FeedPost[] | undefined>(undefined);
  const [topics, setTopics] = useState<FeedTopic[] | undefined>(undefined);
  const [followedIds, setFollowedIds] = useState<Set<string> | undefined>(undefined);
  const [error, setError] = useState(false);

  // One fetch per place for each source; the tabs are client-side views over them.
  useEffect(() => {
    let cancelled = false;
    setPosts(undefined);
    setTopics(undefined);
    setError(false);
    trpc.posts.feed
      .query({ limit: 20, lat: place.lat, lng: place.lng })
      .then((rows: unknown) => {
        if (!cancelled) setPosts(Array.isArray(rows) ? (rows as FeedPost[]) : []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    const listTopics = trpc.townHall.listTopics as unknown as {
      query: (i: { localityName: string; sort: "hot" }) => Promise<{ topics: FeedTopic[] }>;
    };
    listTopics
      .query({ localityName: place.name, sort: "hot" })
      .then((res) => {
        if (!cancelled) setTopics((res.topics ?? []).slice(0, 6));
      })
      .catch(() => {
        if (!cancelled) setTopics([]); // topics are additive — a failure just means a posts-only feed
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, place.lat, place.lng, place.name]);

  // Followed venue ids (for the Following tab) — signed-in only.
  useEffect(() => {
    if (!signedIn) {
      setFollowedIds(undefined);
      return;
    }
    let cancelled = false;
    const myFollows = trpc.social.myFollows as unknown as {
      query: () => Promise<{ ok: boolean; follows?: { venue_id: string }[] }>;
    };
    myFollows
      .query()
      .then((f) => {
        if (!cancelled) setFollowedIds(new Set((f.follows ?? []).map((r) => r.venue_id)));
      })
      .catch(() => {
        if (!cancelled) setFollowedIds(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, signedIn]);

  const items: FeedItem[] | undefined = useMemo(() => {
    if (posts === undefined) return undefined;
    const postItems = (posts ?? []).map((p) => ({
      key: `post-${p.id}`,
      at: ts(p.publishedAt),
      node: <PostFeedCard post={p} />,
    }));
    if (tab === "nearby") return postItems.sort((a, b) => b.at - a.at);
    if (tab === "following") {
      if (!signedIn || followedIds === undefined) return [];
      return postItems.filter((_, i) => followedIds.has((posts ?? [])[i]!.venueId)).sort((a, b) => b.at - a.at);
    }
    // For you: interleave hot topics by recency alongside posts.
    const topicItems = (topics ?? []).map((t) => ({
      key: `topic-${t.id}`,
      at: ts(t.lastActivityAt ?? t.createdAt),
      node: <TopicFeedCard topic={t} />,
    }));
    return [...postItems, ...topicItems].sort((a, b) => b.at - a.at);
  }, [posts, topics, tab, signedIn, followedIds]);

  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", marginBottom: "var(--space-4)", flexWrap: "wrap" }}>
        <h2 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 20, letterSpacing: "-.015em", margin: 0 }}>
          Your local feed
        </h2>
        <Seg
          options={[
            { value: "foryou", label: "For you" },
            { value: "following", label: "Following" },
            { value: "nearby", label: "Nearby" },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {error && (posts === undefined || posts.length === 0) ? (
        <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>Couldn&apos;t load your feed just now.</p>
        </Card>
      ) : items === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-4)" }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ height: 150, borderRadius: 20, background: "var(--paper-2)" }} />
          ))}
        </div>
      ) : tab === "following" && !signedIn ? (
        <Card style={{ padding: "var(--space-5)" }}>
          <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55 }}>
            Sign in and follow your favourite local businesses — their news, offers and events land here.
          </p>
          <div style={{ marginTop: "var(--space-3)" }}>
            <Link href="/account" style={{ textDecoration: "none" }}>
              <Button variant="pri" size="sm">Sign in</Button>
            </Link>
          </div>
        </Card>
      ) : items.length === 0 ? (
        <Card flat style={{ padding: "var(--space-5)" }}>
          <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55 }}>
            {tab === "following"
              ? "No posts from venues you follow yet — follow a few on Explore and their updates will land here."
              : `Nothing moving in ${place.name} just yet — check back soon, or be the one who starts something in the Town Hall.`}
          </p>
          <div style={{ marginTop: "var(--space-3)", display: "flex", gap: "var(--space-2)" }}>
            <Link href={tab === "following" ? "/explore" : "/town-hall"} style={{ textDecoration: "none" }}>
              <Button variant="neutral" size="sm">{tab === "following" ? "Explore venues" : "Open Town Hall"}</Button>
            </Link>
          </div>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-4)" }}>
          {items.map((it) => (
            <div key={it.key}>{it.node}</div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ── Feed cards ────────────────────────────────────────────────────────────────────────── */

/** A business post as a full wall card: venue header, kind chip, title/body, image, actions. */
function PostFeedCard({ post }: { post: FeedPost }) {
  const permalink = `/feed/${post.id}`;
  const venueHref = `/venue/${post.venueId}`;
  const venueName = post.venueName ?? "A local business";
  return (
    <Card style={{ padding: "var(--space-4)" }}>
      {/* Venue header */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
        <Link href={venueHref} aria-hidden tabIndex={-1} style={{ textDecoration: "none", flexShrink: 0 }}>
          <span style={{ width: 34, height: 34, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontSize: 14, fontWeight: 700 }}>
            {venueName.charAt(0).toUpperCase()}
          </span>
        </Link>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Link href={venueHref} style={{ textDecoration: "none", color: "var(--ink)", fontSize: 14, fontWeight: 600, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {venueName}
          </Link>
          <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
            {[post.venueLocality, post.publishedAt ? timeAgo(post.publishedAt) : null].filter(Boolean).join(" · ")}
          </div>
        </div>
        <Pill variant="ghost-crim" size="sm">{KIND_LABEL[post.kind] ?? "News"}</Pill>
      </div>

      {/* Content — links through to the post permalink */}
      <Link href={permalink} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
        {post.title ? (
          <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, lineHeight: 1.3, letterSpacing: "-.01em", color: "var(--ink-hi)", marginBottom: 6 }}>
            {post.title}
          </div>
        ) : null}
        {post.body ? (
          <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {post.body}
          </p>
        ) : null}
        {post.media && post.media.length > 0 ? (
          // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
          <img
            src={post.media[0]!.url}
            alt=""
            loading="lazy"
            style={{ width: "100%", maxHeight: 300, objectFit: "cover", display: "block", borderRadius: "var(--r-md)", marginTop: "var(--space-3)", background: "var(--paper-2)" }}
          />
        ) : null}
      </Link>

      {/* Action bar */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
        <CopyLinkButton path={permalink} {...(post.title ? { title: post.title } : {})} />
        <Link
          href={permalink}
          style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, fontWeight: 600, color: "var(--crimson-700)", textDecoration: "none", whiteSpace: "nowrap" }}
        >
          View post <Icon name="chevronRight" size={14} />
        </Link>
      </div>
    </Card>
  );
}

/** A Town Hall topic as a wall card: upvote tile, chip, title, replies. Whole card links in. */
function TopicFeedCard({ topic }: { topic: FeedTopic }) {
  const href = topic.slug ? `/town-hall/${topic.locality}/${topic.slug}` : `/town-hall/${topic.id}`;
  return (
    <Link href={href} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <Card style={{ padding: "var(--space-4)", display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}>
        <span
          aria-hidden
          style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: 42, height: 46, borderRadius: 12, background: "var(--crimson-tint)", color: "var(--crimson-700)", flexShrink: 0 }}
        >
          <Icon name="upvote" size={13} />
          <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.1 }}>{topic.upvoteCount}</span>
        </span>
        <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Pill variant="ghost-crim" size="sm">Town Hall</Pill>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              {townHallAuthor(topic.author)} asked · {timeAgo(topic.createdAt)}
            </span>
          </span>
          <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 16.5, lineHeight: 1.3, letterSpacing: "-.01em", color: "var(--ink-hi)" }}>
            {topic.title}
          </span>
          {topic.body ? (
            <span style={{ color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {topic.body}
            </span>
          ) : null}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>
            <Icon name="chat" size={14} />
            {topic.replyCount === 1 ? "1 reply" : `${topic.replyCount} replies`}
          </span>
        </span>
      </Card>
    </Link>
  );
}
