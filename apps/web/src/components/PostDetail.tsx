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

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Pill, Button, Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { CopyLinkButton } from "./CopyLinkButton";
import { venuePath } from "../lib/routes";
import { linkifyHashtags } from "../lib/hashtags";
import { getFormatLocale } from "../lib/i18n/runtime";

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
  const t = useTranslations("postDetail");
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
      {t(`kind.${kind}`)}
    </span>
  );
}

/** Compact relative-ish date. Words come from the active catalogue; the date fallback formats
 *  in the active locale. English output is byte-identical to the original hardcoded version. */
export function formatWhen(t: ReturnType<typeof useTranslations>, iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const day = 86_400_000;
  if (diffMs < day) return t("when.today");
  if (diffMs < 2 * day) return t("when.yesterday");
  const days = Math.floor(diffMs / day);
  if (days < 7) return t("when.daysAgo", { count: days });
  return new Date(iso).toLocaleDateString(getFormatLocale());
}

/** The presentational post detail. `post` is already loaded by the caller. */
export function PostDetail({ post }: { post: FeedPost }) {
  const t = useTranslations("postDetail");
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
          <Icon name={isOffer ? "sparkle" : post.kind === "event" ? "event" : "megaphone"} size={34} style={{ color: "var(--crimson-700)", opacity: 0.5 }} />
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
            {post.publishedAt ? t("postedWhen", { when: formatWhen(t, post.publishedAt) }) : t("posted")}
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
          <p style={{ margin: 0, lineHeight: 1.6, color: "var(--ink)", whiteSpace: "pre-wrap" }}>{linkifyHashtags(post.body)}</p>
        ) : null}

        {/* Offer hand-off: offers are claimed/shown at the venue. */}
        {isOffer ? (
          <div style={{ marginTop: "var(--space-4)" }}>
            <Link href={venuePath(post.venueId)} style={{ textDecoration: "none" }}>
              <Pill variant="ghost-crim">{t("redeemOffer")} →</Pill>
            </Link>
          </div>
        ) : null}

        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-5)" }}>
          <CopyLinkButton
            variant="button"
            path={`/feed/${post.id}`}
            title={post.title ?? post.venueName ?? t("shareTitleFallback")}
          />
          <Link href={venuePath(post.venueId)} style={{ textDecoration: "none", flex: 1 }}>
            <Button variant="neutral" block>
              {t("viewVenue")} →
            </Button>
          </Link>
        </div>
      </div>
    </Card>
  );
}

/**
 * PostDetailScreen — the /feed/[postId] route body. Fetches one post and renders it, with a
 * back link to the feed and the loading / not-found / error states.
 */
export function PostDetailScreen({ postId, initialPost }: { postId: string; initialPost?: FeedPost | null }) {
  const t = useTranslations("postDetail");
  const trpc = useTrpc();
  const [post, setPost] = useState<FeedPost | null | undefined>(initialPost);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // When the server already resolved the post (SSR seed), trust it — a post detail carries no
    // viewer-specific state, so there's nothing to refetch and we avoid a hydration flash.
    if (initialPost !== undefined) return;
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
        if (!cancelled) setError(e instanceof Error ? e.message : t("screen.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, postId, initialPost]);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link
        href="/explore"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-4)" }}
      >
        <span aria-hidden>←</span> {t("screen.back")}
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
            {t("screen.notFoundTitle")}
          </div>
          <p style={{ color: "var(--ink-2)", margin: 0 }}>{t("screen.notFoundBody")}</p>
        </Card>
      ) : (
        <PostDetail post={post} />
      )}
    </main>
  );
}
