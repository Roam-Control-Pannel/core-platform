/**
 * TagFeed — the hashtag page body (/tags/{tag}): everything on Roam carrying #tag, in three
 * sections (Town Hall discussion, business posts, wall posts), newest first, every card
 * deep-linking to its permalink. Data from tags.feed (broad ILIKE narrowed by exact
 * word-boundary matching in the API). Client component: one fetch, no auth needed.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Pill } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { townHallTopicPath } from "../lib/routes";
import { timeAgo } from "../lib/townHall";
import { linkifyHashtags } from "../lib/hashtags";

interface TagTopic {
  id: string;
  locality: string;
  localityLabel: string;
  slug: string | null;
  title: string;
  body: string | null;
  replyCount: number;
  upvoteCount: number;
  createdAt: string;
}
interface TagPost {
  id: string;
  kind: string;
  title: string | null;
  body: string | null;
  publishedAt: string;
  venueName: string | null;
  venueLocality: string | null;
}
interface TagWallPost {
  id: string;
  body: string | null;
  createdAt: string;
  authorName: string | null;
  authorHandle: string | null;
}
interface Feed {
  tag: string;
  topics: TagTopic[];
  posts: TagPost[];
  wall: TagWallPost[];
  total: number;
}

export function TagFeed({ tag }: { tag: string }) {
  const t = useTranslations("tagFeed");
  const trpc = useTrpc();
  const [feed, setFeed] = useState<Feed | undefined>(undefined);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFeed(undefined);
    setError(false);
    const q = trpc.tags.feed as unknown as { query: (i: { tag: string }) => Promise<Feed> };
    q.query({ tag })
      .then((r) => { if (!cancelled) setFeed(r); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [trpc, tag]);

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ marginBottom: "var(--space-5)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--crimson-700)", marginBottom: 6 }}>
          {t("kicker")}
        </div>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 30, letterSpacing: "-.02em", margin: 0 }}>
          #{tag}
        </h1>
        {feed ? (
          <p style={{ margin: "6px 0 0", color: "var(--ink-2)", fontSize: 14 }}>
            {t("postCount", { count: feed.total })}
          </p>
        ) : null}
      </header>

      {error ? (
        <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
          <p style={{ margin: 0, color: "var(--muted)" }}>{t("loadFailed", { tag })}</p>
        </Card>
      ) : feed === undefined ? (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {[0, 1, 2].map((i) => <div key={i} style={{ height: 110, borderRadius: 20, background: "var(--paper-2)" }} />)}
        </div>
      ) : feed.total === 0 ? (
        <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>{t("emptyTitle", { tag })}</div>
          <p style={{ margin: 0, color: "var(--ink-2)", lineHeight: 1.55 }}>
            {t("emptyBody", { tag })}
          </p>
        </Card>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "var(--space-5)" }}>
          {feed.topics.length > 0 ? (
            <TagSection title={t("sections.townHall")}>
              {feed.topics.map((topic) => (
                <Card key={topic.id} style={{ padding: "var(--space-4)" }}>
                  <Link href={topic.slug ? townHallTopicPath(topic.locality, topic.slug) : `/town-hall/${topic.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                    <h3 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 16.5, lineHeight: 1.3, margin: 0 }}>{topic.title}</h3>
                  </Link>
                  {topic.body ? <p style={teaser}>{linkifyHashtags(topic.body)}</p> : null}
                  <div style={meta}>
                    <Pill variant="ghost-crim" size="sm">{topic.localityLabel}</Pill>
                    <span>♥ {topic.upvoteCount}</span>
                    <span aria-hidden>·</span>
                    <span>{t("replies", { count: topic.replyCount })}</span>
                    <span aria-hidden>·</span>
                    <span>{timeAgo(topic.createdAt)}</span>
                  </div>
                </Card>
              ))}
            </TagSection>
          ) : null}

          {feed.posts.length > 0 ? (
            <TagSection title={t("sections.businesses")}>
              {feed.posts.map((p) => (
                <Card key={p.id} style={{ padding: "var(--space-4)" }}>
                  <Link href={`/feed/${p.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                    <h3 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 16.5, lineHeight: 1.3, margin: 0 }}>
                      {p.title ?? (p.venueName ? t("venueUpdate", { venue: p.venueName }) : t("localUpdate"))}
                    </h3>
                  </Link>
                  {p.body ? <p style={teaser}>{linkifyHashtags(p.body)}</p> : null}
                  <div style={meta}>
                    {p.venueName ? <span>{p.venueName}</span> : null}
                    {p.venueName ? <span aria-hidden>·</span> : null}
                    <span>{timeAgo(p.publishedAt)}</span>
                  </div>
                </Card>
              ))}
            </TagSection>
          ) : null}

          {feed.wall.length > 0 ? (
            <TagSection title={t("sections.locals")}>
              {feed.wall.map((w) => (
                <Card key={w.id} style={{ padding: "var(--space-4)" }}>
                  {w.body ? <p style={{ ...teaser, margin: 0 }}>{linkifyHashtags(w.body)}</p> : null}
                  <div style={meta}>
                    <span>{w.authorName ?? (w.authorHandle ? `@${w.authorHandle}` : t("aLocal"))}</span>
                    <span aria-hidden>·</span>
                    <span>{timeAgo(w.createdAt)}</span>
                    <Link href={`/p/${w.id}`} style={{ marginLeft: "auto", color: "var(--crimson-700)", fontWeight: 600, fontSize: 13, textDecoration: "none" }}>
                      {t("viewPost")}
                    </Link>
                  </div>
                </Card>
              ))}
            </TagSection>
          ) : null}
        </div>
      )}
    </main>
  );
}

function TagSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 18, margin: "0 0 var(--space-3)" }}>{title}</h2>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "var(--space-3)" }}>{children}</div>
    </section>
  );
}

const teaser: React.CSSProperties = {
  margin: "5px 0 0",
  color: "var(--ink-2)",
  fontSize: 14,
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  display: "-webkit-box",
  WebkitLineClamp: 3,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

const meta: React.CSSProperties = {
  marginTop: "var(--space-2)",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12.5,
  color: "var(--muted)",
  flexWrap: "wrap",
};
