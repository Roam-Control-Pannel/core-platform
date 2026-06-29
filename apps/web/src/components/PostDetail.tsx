/**
 * PostDetail — the feed post-detail surface (Discovery design: mobile screen 07 + the web
 * feed's right-hand detail pane). A post hero, a meta row (venue · time · kind tag), the body,
 * an offer redeem hand-off, share, and a View Venue action.
 *
 * Two entry points share the presentational `PostDetail`:
 *   - PostDetailScreen (this file): the /feed/[postId] route — fetches posts.byId, ships the
 *     loading/not-found/error states, renders PostDetail. This is the mobile post-detail screen.
 *   - FeedList's web two-pane: passes an already-loaded post straight to PostDetail (no refetch).
 *
 * Honesty over the mockup: posts carry no image or like-count yet, so the hero is a tasteful
 * kind-tinted gradient (not a faked photo) and there is no fabricated like total — Share is a
 * real action (Web Share / copy link). It grows when the post model does.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Pill, Button } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { venuePath } from "../lib/routes";

export interface FeedPost {
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

/** Post-kind tag — OFFER carries the crimson emphasis; EVENT/NEWS are neutral. */
export function KindTag({ kind }: { kind: FeedPost["kind"] }) {
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

/** Compact relative-ish date. Localisation of the exact format is a later concern. */
export function formatWhen(iso: string): string {
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

/** The presentational post detail. `post` is already loaded by the caller. */
export function PostDetail({ post }: { post: FeedPost }) {
  const isOffer = post.kind === "offer";
  return (
    <Card>
      {/* Hero — the post's own image when it has one; otherwise a kind-tinted gradient (no faked photo). */}
      {post.media && post.media.length > 0 ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- public bucket URL */}
          <img src={post.media[0]!.url} alt="" style={{ width: "100%", height: 240, objectFit: "cover", display: "block", background: "var(--paper-2)" }} />
          {post.media.length > 1 ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, padding: 4, background: "var(--card)" }}>
              {post.media.slice(1, 4).map((m) => (
                // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
                <img key={m.url} src={m.url} alt="" loading="lazy" style={{ width: "100%", height: 80, objectFit: "cover", display: "block", borderRadius: 6 }} />
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div
          aria-hidden
          style={{
            height: 200,
            background: isOffer
              ? "radial-gradient(120% 90% at 20% 10%, var(--crimson-tint), transparent 60%), linear-gradient(150deg, #c96b43, #8f3f29)"
              : "linear-gradient(135deg, var(--crimson-tint), var(--paper-2))",
            display: "grid",
            placeItems: "center",
          }}
        >
          <span style={{ fontSize: 30, color: "var(--crimson-700)", opacity: 0.5 }}>
            {isOffer ? "✦" : post.kind === "event" ? "◷" : "›"}
          </span>
        </div>
      )}

      <div style={{ padding: "var(--space-4)" }}>
        {/* meta: avatar · posted time · venue · kind tag */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
          <span
            aria-hidden
            style={{ flex: "0 0 auto", width: 30, height: 30, borderRadius: "50%", background: "var(--paper-2)", border: "1px solid var(--line)" }}
          />
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--muted)" }}>
            {post.publishedAt ? `Posted ${formatWhen(post.publishedAt)}` : "Posted"}
            {post.venueName ? (
              <>
                {" · "}
                <Link href={venuePath(post.venueId)} style={{ color: "var(--ink-2)", textDecoration: "none", fontWeight: 600 }}>
                  {post.venueName}
                </Link>
              </>
            ) : null}
          </div>
          <KindTag kind={post.kind} />
        </div>

        {post.title ? (
          <h1 className="t-h2" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 20, margin: "0 0 var(--space-2)", lineHeight: 1.25 }}>
            {post.title}
          </h1>
        ) : null}
        {post.body ? (
          <p style={{ margin: 0, lineHeight: 1.6, color: "var(--ink)", whiteSpace: "pre-wrap" }}>{post.body}</p>
        ) : null}

        {/* Offer hand-off: offers are claimed/shown at the venue. */}
        {isOffer ? (
          <div style={{ marginTop: "var(--space-4)" }}>
            <Link href={venuePath(post.venueId)} style={{ textDecoration: "none" }}>
              <Pill variant="ghost-crim">Redeem offer →</Pill>
            </Link>
          </div>
        ) : null}

        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-5)" }}>
          <ShareButton postId={post.id} title={post.title ?? post.venueName ?? "A post on Roam"} />
          <Link href={venuePath(post.venueId)} style={{ textDecoration: "none", flex: 1 }}>
            <Button variant="neutral" block>
              View Venue →
            </Button>
          </Link>
        </div>
      </div>
    </Card>
  );
}

/** Share via the Web Share sheet where available, else copy the post link to the clipboard. */
function ShareButton({ postId, title }: { postId: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const share = useCallback(async () => {
    const url =
      (typeof window !== "undefined" ? window.location.origin : "") + `/feed/${postId}`;
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* user dismissed the share sheet, or clipboard blocked — no-op */
    }
  }, [postId, title]);
  return (
    <Button variant="neutral" onClick={() => void share()}>
      {copied ? "Link copied ✓" : "Share ↗"}
    </Button>
  );
}

/**
 * PostDetailScreen — the /feed/[postId] route body. Fetches one post and renders it, with a
 * back link to the feed and the loading / not-found / error states.
 */
export function PostDetailScreen({ postId }: { postId: string }) {
  const trpc = useTrpc();
  const [post, setPost] = useState<FeedPost | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPost(undefined);
    setError(null);
    const byId = trpc.posts.byId as unknown as {
      query: (input: { postId: string }) => Promise<FeedPost | null>;
    };
    byId
      .query({ postId })
      .then((p) => {
        if (!cancelled) setPost(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load this post.");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, postId]);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link
        href="/explore"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-4)" }}
      >
        <span aria-hidden>←</span> Feed
      </Link>

      {error ? (
        <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>{error}</p>
        </Card>
      ) : post === undefined ? (
        <div style={{ height: 320, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
      ) : post === null ? (
        <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
            Post not found
          </div>
          <p style={{ color: "var(--ink-2)", margin: 0 }}>It may have been removed, or the link is wrong.</p>
        </Card>
      ) : (
        <PostDetail post={post} />
      )}
    </main>
  );
}
