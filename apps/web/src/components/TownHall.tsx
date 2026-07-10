/**
 * TownHall — the per-locality public forum board (/town-hall), redesigned to the hi-fi mockup:
 * a crimson hero banner (kicker · title · Start a topic CTA · faded brand mark), the place chip
 * + Hot/Recent/Top sort, CATEGORY filter chips (All · Food & Drink · Things to do ·
 * Recommendations · Events · Neighbourhood — 0066), richer topic cards (left vote rail,
 * category chip, "active now", author footer), and a right rail (Trending tags · Active locals).
 *
 * PUBLIC to read (browse any town's board signed-out, the same browse-freely contract as
 * Explore); starting a topic or upvoting needs an account, prompted just-in-time.
 *
 * The active place comes from useCurrentPlace (shared with Explore, persisted per-device) and
 * the PlaceSwitcher re-roots the board. Ships every state: skeleton, empty, error, loaded.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Button, Seg, Icon } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { PlaceSwitcher } from "./PlaceSwitcher";
import { useCurrentPlace } from "../lib/currentPlace";
import { TopicUpvote } from "./TopicUpvote";
import { AuthorLink } from "./AuthorLink";
import { CopyLinkButton } from "./CopyLinkButton";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { authorInitial, timeAgo, type TownHallAuthor } from "../lib/townHall";
import { townHubPath, townSlug } from "../lib/routes";
import styles from "./TownHall.module.css";
import { linkifyHashtags } from "../lib/hashtags";

interface TopicListItem {
  id: string;
  slug: string | null;
  locality: string;
  title: string;
  body: string;
  category: string | null;
  upvoteCount: number;
  replyCount: number;
  linkUrl: string | null;
  linkDomain: string | null;
  linkTitle: string | null;
  linkImageUrl: string | null;
  lastActivityAt: string;
  createdAt: string;
  author: TownHallAuthor;
  viewerUpvoted: boolean;
}

type Sort = "hot" | "new" | "top";
type CategoryId = "food-drink" | "things-to-do" | "recommendations" | "events" | "neighbourhood";

/** The board's category vocabulary (matches the API's categorySchema). Ids are wire values;
 *  labels come from the catalogue (townHall.categories.*) at display sites. */
const CATEGORIES: { id: CategoryId; labelKey: string }[] = [
  { id: "food-drink", labelKey: "foodDrink" },
  { id: "things-to-do", labelKey: "thingsToDo" },
  { id: "recommendations", labelKey: "recommendations" },
  { id: "events", labelKey: "events" },
  { id: "neighbourhood", labelKey: "neighbourhood" },
];
const CATEGORY_KEY = new Map<string, string>(CATEGORIES.map((c) => [c.id, c.labelKey]));

/** Resolve a category id (a wire value) to its translated display label. */
function categoryLabel(t: ReturnType<typeof useTranslations>, id: string): string | null {
  const key = CATEGORY_KEY.get(id);
  return key ? t(`categories.${key}`) : null;
}

/** "Active now" = someone touched the thread in the last half hour. */
function isActiveNow(lastActivityAt: string): boolean {
  const t = new Date(lastActivityAt).getTime();
  return !Number.isNaN(t) && Date.now() - t < 30 * 60_000;
}

export function TownHall() {
  const t = useTranslations("townHall");
  const trpc = useTrpc();
  const session = useSession();
  const { place, setPlace } = useCurrentPlace();

  const [topics, setTopics] = useState<TopicListItem[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("hot");
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [composing, setComposing] = useState(false);

  const load = useCallback(async () => {
    setTopics(undefined);
    setError(null);
    const listTopics = trpc.townHall.listTopics as unknown as {
      query: (input: { localityName: string; sort: Sort; category?: CategoryId }) => Promise<{ topics: TopicListItem[] }>;
    };
    try {
      const res = await listTopics.query({ localityName: place.name, sort, ...(category ? { category } : {}) });
      return res.topics ?? [];
    } catch (e: unknown) {
      throw e instanceof Error ? e : new Error(t("loadFailed"));
    }
  }, [trpc, place.name, sort, category]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((list) => {
        if (!cancelled) setTopics(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : t("loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const onPosted = useCallback(() => {
    setComposing(false);
    void load().then((list) => setTopics(list)).catch(() => {});
  }, [load]);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      {/* Hero banner — the board's identity. */}
      <section
        style={{
          position: "relative",
          overflow: "hidden",
          borderRadius: 22,
          padding: "var(--space-8) var(--space-6)",
          background: "linear-gradient(120deg, var(--crimson) 0%, var(--crimson-700) 60%, #7a0c28 100%)",
          color: "#fff",
          marginBottom: "var(--space-5)",
        }}
      >
        {/* Faded brand mark, right edge. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
        <img
          src="/roam-mark.png"
          alt=""
          aria-hidden
          style={{ position: "absolute", right: -40, top: "50%", transform: "translateY(-50%)", width: 320, opacity: 0.14, pointerEvents: "none" }}
        />
        <div style={{ position: "relative", maxWidth: 560 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "rgba(255,255,255,.75)", marginBottom: 8 }}>
            {place.name} · {t("hero.kicker")}
          </div>
          <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 34, letterSpacing: "-.02em", margin: 0 }}>
            {t("hero.title")}
          </h1>
          <p style={{ margin: "10px 0 0", fontSize: 15.5, lineHeight: 1.55, color: "rgba(255,255,255,.88)", maxWidth: 480 }}>
            {t("hero.body")}
          </p>
          <button
            type="button"
            onClick={() => setComposing(true)}
            style={{
              all: "unset",
              boxSizing: "border-box",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              marginTop: "var(--space-5)",
              padding: "11px 20px",
              borderRadius: 999,
              background: "#fff",
              color: "var(--crimson-700)",
              fontFamily: "var(--ui)",
              fontSize: 14,
              fontWeight: 700,
              boxShadow: "0 2px 10px rgba(0,0,0,.18)",
            }}
          >
            <Icon name="plus" size={16} /> {t("hero.startTopic")}
          </button>
        </div>
      </section>

      {/* Controls: place + sort, then the category chips. */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
        <PlaceSwitcher value={place} onChange={setPlace} />
        <Seg
          options={[
            { value: "hot", label: t("sort.hot") },
            { value: "new", label: t("sort.new") },
            { value: "top", label: t("sort.top") },
          ]}
          value={sort}
          onChange={(v) => setSort(v)}
        />
        <Link
          href={townHubPath(townSlug(place.name))}
          style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, fontWeight: 600, color: "var(--crimson-700)", textDecoration: "none", whiteSpace: "nowrap" }}
        >
          {t("placeHub", { place: place.name })} <span aria-hidden>→</span>
        </Link>
      </div>

      <div className={styles.chips} role="tablist" aria-label={t("filterByCategory")}>
        <button
          type="button"
          className={`${styles.chip} ${category === null ? styles.chipActive : ""}`}
          onClick={() => setCategory(null)}
        >
          {t("categories.all")}
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`${styles.chip} ${category === c.id ? styles.chipActive : ""}`}
            onClick={() => setCategory((cur) => (cur === c.id ? null : c.id))}
          >
            {t(`categories.${c.labelKey}`)}
          </button>
        ))}
      </div>

      <div className={styles.layout}>
        {/* Topic list column */}
        <div style={{ minWidth: 0 }}>
          {/* Start a topic — auth-gated, prompted just-in-time. */}
          {composing ? (
            session ? (
              <TopicComposer localityName={place.name} onPosted={onPosted} onCancel={() => setComposing(false)} />
            ) : (
              <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
                <AuthPanel
                  intro={t("signInToStart", { place: place.name })}
                  emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
                  onAuthed={() => {
                    /* session change re-renders; the composer shows next */
                  }}
                />
              </Card>
            )
          ) : null}

          {error ? (
            <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
              <p style={{ color: "var(--muted)", margin: 0 }}>{error}</p>
            </Card>
          ) : topics === undefined ? (
            <TopicListSkeleton />
          ) : topics.length === 0 ? (
            <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
              <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
                {category ? t("empty.titleCategory", { category: categoryLabel(t, category) ?? "", place: place.name }) : t("empty.title", { place: place.name })}
              </div>
              <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5 }}>
                {t("empty.body")}
              </p>
            </Card>
          ) : (
            <div style={{ display: "grid", gap: "var(--space-3)" }}>
              {topics.map((topic) => (
                <TopicRow key={topic.id} topic={topic} canVote={!!session} />
              ))}
            </div>
          )}
        </div>

        {/* Rail: trending tags + active locals. */}
        <aside className={styles.rail}>
          <TrendingTags topics={topics} />
          <ActiveLocals localityName={place.name} />
        </aside>
      </div>
    </main>
  );
}

function TopicRow({ topic, canVote }: { topic: TopicListItem; canVote: boolean }) {
  const t = useTranslations("townHall");
  const href = topic.slug ? `/town-hall/${topic.locality}/${topic.slug}` : `/town-hall/${topic.id}`;
  const catLabel = topic.category ? categoryLabel(t, topic.category) : null;
  const active = isActiveNow(topic.lastActivityAt);
  return (
    <Card style={{ padding: "var(--space-4)", display: "flex", gap: "var(--space-4)", alignItems: "flex-start" }}>
      {/* Left vote rail. */}
      <TopicUpvote
        topicId={topic.id}
        initialUpvoted={topic.viewerUpvoted}
        initialCount={topic.upvoteCount}
        canVote={canVote}
        vertical
      />

      <div style={{ minWidth: 0, flex: 1 }}>
        {/* Category chip + activity. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
          {catLabel ? (
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--crimson-700)", background: "var(--crimson-tint)", borderRadius: 999, padding: "4px 12px" }}>
              {catLabel}
            </span>
          ) : null}
          {active ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: ".05em", color: "var(--success)" }}>
              <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--success)" }} />
              {t("activeNow")}
            </span>
          ) : (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>{timeAgo(topic.lastActivityAt)}</span>
          )}
        </div>

        {/* Title + body — the tappable post body. */}
        <Link href={href} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17.5, lineHeight: 1.3, letterSpacing: "-.01em", color: "var(--ink-hi)" }}>
            {topic.title}
          </div>
          <p
            style={{
              margin: "5px 0 0",
              color: "var(--ink-2)",
              fontSize: 13.5,
              lineHeight: 1.5,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {linkifyHashtags(topic.body, { links: false })}
          </p>
        </Link>

        {topic.linkUrl ? (
          <div style={{ marginTop: "var(--space-3)" }}>
            <LinkPreviewCard link={{ url: topic.linkUrl, domain: topic.linkDomain, title: topic.linkTitle, imageUrl: topic.linkImageUrl }} />
          </div>
        ) : null}

        {/* Footer: author · replies · share. */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span aria-hidden style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontSize: 11.5, fontWeight: 700, flexShrink: 0 }}>
              {authorInitial(topic.author)}
            </span>
            <AuthorLink author={topic.author} style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }} />
            <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>· {timeAgo(topic.createdAt)}</span>
          </span>
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
            <Link href={href} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "var(--ink-2)", textDecoration: "none" }} aria-label={t("replies", { count: topic.replyCount })}>
              <Icon name="chat" size={15} /> {t("replies", { count: topic.replyCount })}
            </Link>
            <CopyLinkButton path={href} />
          </span>
        </div>
      </div>
    </Card>
  );
}

/* ── Rail: trending tags (from the loaded topics' #hashtags) ─────────────────────────────── */

const HASHTAG_RE = /#([a-z0-9][a-z0-9_-]{2,30})/gi;

function TrendingTags({ topics }: { topics: TopicListItem[] | undefined }) {
  const t = useTranslations("townHall");
  const tags = useMemo(() => {
    if (!topics || topics.length === 0) return [];
    const counts = new Map<string, number>();
    for (const topic of topics) {
      const seen = new Set<string>(); // count once per topic, not per mention
      for (const m of `${topic.title} ${topic.body}`.matchAll(HASHTAG_RE)) {
        const tag = m[1]!.toLowerCase();
        if (!seen.has(tag)) {
          seen.add(tag);
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([tag]) => tag);
  }, [topics]);

  if (tags.length === 0) return null;

  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
        <span aria-hidden style={{ display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: 8, background: "var(--gold-tint)", color: "var(--gold)" }}>
          <Icon name="sparkle" size={15} />
        </span>
        <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, margin: 0 }}>{t("trendingTags")}</h2>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {tags.map((tag) => (
          <span key={tag} style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)", background: "#fff", border: "1px solid var(--line-2)", borderRadius: 999, padding: "6px 13px" }}>
            #{tag}
          </span>
        ))}
      </div>
    </Card>
  );
}

/* ── Rail: active locals (top upvote-earners on this board) ─────────────────────────────── */

interface ActiveLocal {
  author: TownHallAuthor;
  helpfulVotes: number;
  topics: number;
}

function ActiveLocals({ localityName }: { localityName: string }) {
  const t = useTranslations("townHall");
  const trpc = useTrpc();
  const [locals, setLocals] = useState<ActiveLocal[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLocals(undefined);
    const q = trpc.townHall.activeLocals as unknown as {
      query: (i: { localityName: string }) => Promise<{ locals: ActiveLocal[] }>;
    };
    q.query({ localityName })
      .then((r) => {
        if (!cancelled) setLocals(r.locals ?? []);
      })
      .catch(() => {
        if (!cancelled) setLocals([]);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, localityName]);

  if (!locals || locals.length === 0) return null;

  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
        <span aria-hidden style={{ display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: 8, background: "var(--crimson-tint)", color: "var(--crimson-700)" }}>
          <Icon name="person" size={15} />
        </span>
        <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, margin: 0 }}>{t("activeLocals")}</h2>
      </div>
      <div style={{ display: "grid", gap: "var(--space-2)" }}>
        {locals.map((l) => (
          <div key={l.author.id ?? l.author.handle ?? Math.random()} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span aria-hidden style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontSize: 13.5, fontWeight: 700, flexShrink: 0 }}>
              {authorInitial(l.author)}
            </span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <AuthorLink author={l.author} style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }} />
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                {t("helpfulVotes", { count: l.helpfulVotes })}
              </span>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── Composer ────────────────────────────────────────────────────────────────────────────── */

function TopicComposer({
  localityName,
  onPosted,
  onCancel,
}: {
  localityName: string;
  onPosted: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("townHall");
  const trpc = useTrpc();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [preview, setPreview] = useState<{ url: string; domain: string | null; title: string | null; imageUrl: string | null } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Debounced link preview — the server unfurls the URL (SSRF-safe) into a domain/title/image card.
  useEffect(() => {
    const url = linkUrl.trim();
    if (!/^https?:\/\/.+/i.test(url)) { setPreview(null); setPreviewing(false); return; }
    setPreviewing(true);
    const q = trpc.townHall.previewLink as unknown as {
      query: (i: { url: string }) => Promise<{ url: string; domain: string; title: string | null; imageUrl: string | null }>;
    };
    const timer = setTimeout(() => {
      q.query({ url }).then((r) => { setPreview(r); setPreviewing(false); }).catch(() => { setPreview(null); setPreviewing(false); });
    }, 500);
    return () => clearTimeout(timer);
  }, [linkUrl, trpc]);

  const submit = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const createTopic = trpc.townHall.createTopic as unknown as {
      mutate: (input: { localityName: string; title: string; body: string; category?: CategoryId; linkUrl?: string }) => Promise<{ id: string }>;
    };
    try {
      const url = linkUrl.trim();
      await createTopic.mutate({
        localityName,
        title,
        body,
        ...(category ? { category } : {}),
        ...(/^https?:\/\//i.test(url) ? { linkUrl: url } : {}),
      });
      onPosted();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t("composer.postFailed"));
      setBusy(false);
    }
  }, [trpc, localityName, title, body, category, linkUrl, onPosted]);

  const canPost = title.trim().length > 0 && body.trim().length > 0 && !busy;

  return (
    <Card style={{ padding: "var(--space-4)", marginBottom: "var(--space-4)" }}>
      <div style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-3)" }}>
        {t("composer.title", { place: localityName })}
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("composer.titlePlaceholder")}
        aria-label={t("composer.titleAria")}
        maxLength={140}
        style={inputStyle}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t("composer.bodyPlaceholder")}
        aria-label={t("composer.bodyAria")}
        rows={4}
        style={{ ...inputStyle, resize: "vertical", minHeight: 96 }}
      />

      {/* Category picker — optional, single-select toggle. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: "var(--space-3)" }}>
        {CATEGORIES.map((c) => {
          const on = category === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(on ? null : c.id)}
              aria-pressed={on}
              style={{
                all: "unset",
                boxSizing: "border-box",
                cursor: "pointer",
                padding: "6px 13px",
                borderRadius: 999,
                fontFamily: "var(--ui)",
                fontSize: 12.5,
                fontWeight: 600,
                border: `1px solid ${on ? "var(--crimson-tint-2)" : "var(--line-2)"}`,
                background: on ? "var(--crimson-tint)" : "#fff",
                color: on ? "var(--crimson-700)" : "var(--ink-2)",
              }}
            >
              {t(`categories.${c.labelKey}`)}
            </button>
          );
        })}
      </div>

      <input
        value={linkUrl}
        onChange={(e) => setLinkUrl(e.target.value)}
        placeholder={t("composer.linkPlaceholder")}
        aria-label={t("composer.linkAria")}
        inputMode="url"
        style={inputStyle}
      />
      {previewing ? (
        <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: "var(--space-3)" }}>{t("composer.fetchingPreview")}</div>
      ) : preview ? (
        <div style={{ marginBottom: "var(--space-3)" }}>
          <LinkPreviewCard
            link={preview}
            onRemove={() => { setLinkUrl(""); setPreview(null); }}
          />
        </div>
      ) : null}
      {err ? (
        <div role="alert" style={{ color: "var(--crimson-700)", fontSize: 13, marginBottom: "var(--space-2)" }}>
          {err}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button variant="pri" onClick={() => void submit()} disabled={!canPost}>
          {busy ? t("composer.posting") : t("composer.post")}
        </Button>
        <Button variant="neutral" onClick={onCancel} disabled={busy}>
          {t("composer.cancel")}
        </Button>
      </div>
    </Card>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  marginBottom: "var(--space-3)",
  background: "var(--paper-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-md)",
  fontFamily: "var(--ui)",
  fontSize: 16, // ≥16px so iOS Safari doesn't zoom on focus
  color: "var(--ink)",
  outline: "none",
};

function TopicListSkeleton() {
  return (
    <div style={{ display: "grid", gap: "var(--space-3)" }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ height: 120, borderRadius: 20, background: "var(--paper-2)" }} />
      ))}
    </div>
  );
}
