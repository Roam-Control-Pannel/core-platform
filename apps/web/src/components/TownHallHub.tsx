/**
 * TownHallHub — the per-town hub at /town-hall/{town} (server component, no "use client").
 *
 * The canonical, indexable surface for a locality: a real H1 + intro, the town's discussion
 * topics, featured venues, and recent local news — all server-rendered into the initial HTML with
 * dense internal links (topics → /town-hall/{town}/{slug}, venues → /venue/{slug}, news →
 * /feed/{id}). This is the "landing page" built on genuine UGC rather than a thin doorway page.
 *
 * Posting/upvoting stays on the interactive board (/town-hall); the hub's CTA links there. An
 * empty town still renders (a "be the first" prompt) but the page sets noindex (see hubMetadata).
 */
import Link from "next/link";
import { Card, Icon, type IconName } from "@roam/design";
import { townHallTopicPath } from "../lib/routes";
import { timeAgo } from "../lib/townHall";
import { categoryLabel } from "../lib/categories";
import { DISCOVER_CATEGORIES } from "../lib/discover";
import { UpcomingEvents } from "./UpcomingEvents";
import type { HubData, HubVenue, HubStats, HubNews, HubEvent } from "../lib/serverApi";
import type { TownGuide } from "../lib/townGuides";
import { linkifyHashtags } from "../lib/hashtags";

const heroIntro = (label: string) =>
  `What locals in ${label} are talking about — discussion, news and recommendations, plus places worth your time.`;

/** The town-coverage line under the hero: "142 places in Darlington — eateries, shops…". */
function coverageLine(label: string, stats: HubStats): string {
  const cats = stats.categories.slice(0, 3).map((c) => categoryLabel(c.category).toLowerCase());
  const catText = cats.length > 0 ? ` — ${cats.join(", ")} and more` : "";
  return `${stats.total} ${stats.total === 1 ? "place" : "places"} in ${label} on Roam${catText}.`;
}

export function TownHallHub({
  hub,
  venues,
  stats,
  news,
  events,
  guide,
}: {
  hub: HubData;
  venues: HubVenue[];
  stats: HubStats | null;
  news: HubNews[];
  events: HubEvent[];
  guide: TownGuide | null;
}) {
  const label = hub.localityLabel;
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link
        href="/town-hall"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-4)" }}
      >
        <span aria-hidden>←</span> Town Hall
      </Link>

      <header style={{ marginBottom: "var(--space-6)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--crimson-700)", marginBottom: 6 }}>
          Town Hall
        </div>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 30, letterSpacing: "-.02em", margin: 0 }}>
          {label}
          {guide?.region ? (
            <span style={{ fontFamily: "var(--ui)", fontWeight: 500, fontSize: 15, letterSpacing: 0, color: "var(--muted)", marginLeft: 10 }}>
              {guide.region}
            </span>
          ) : null}
        </h1>
        <p style={{ margin: "var(--space-2) 0 var(--space-4)", color: "var(--ink-2)", fontSize: 14.5, lineHeight: 1.55 }}>
          {heroIntro(label)}
          {stats && stats.total > 0 ? <> {coverageLine(label, stats)}</> : null}
        </p>
        <Link href="/town-hall" style={{ textDecoration: "none" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 999, background: "var(--crimson)", color: "#fff", fontWeight: 600, fontSize: 14 }}>
            ＋ Start a topic in {label}
          </span>
        </Link>
      </header>

      {/* Discover by intent — links to the /discover/{town}/{category} landing pages ("Best places
          to eat & drink in <town>"). Only shown once the town has some venue coverage, so we never
          point at empty category pages. Each is an indexable, single-intent listing. */}
      {venues.length > 0 ? (
        <Section title={`Discover ${label}`}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
            {DISCOVER_CATEGORIES.map((c) => (
              <Link
                key={c.slug}
                href={`/discover/${hub.locality}/${c.slug}`}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 999, background: "var(--paper-2)", border: "1px solid var(--line)", textDecoration: "none", color: "var(--ink)", fontWeight: 600, fontSize: 13.5 }}
              >
                {c.heading} <span aria-hidden style={{ color: "var(--muted)" }}>→</span>
              </Link>
            ))}
          </div>
        </Section>
      ) : null}

      {/* What's on — upcoming community events in the town, linking to each /events/{id} page.
          Server-rendered, so this fresh, dated content feeds the indexable hub. Always renders
          (a prompt when empty) so the hub advertises the surface. */}
      <UpcomingEvents
        title={`What's on in ${label}`}
        events={events}
        postHref="/events?new=1"
        postLabel="Post an event"
        emptyBody={`Gigs, quiz nights, markets and meet-ups in ${label} will show here. Be the first to post one.`}
      />

      {/* About the town — the editorial guide (known for · history · local tip) carried over
          from the original roam-local.co.uk town pages. Server-rendered, unique per town: the
          copy that makes a quiet hub a real page (and the 301 target for the old site). */}
      {guide ? (
        <Section title={`About ${label}`}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "var(--space-3)" }}>
            <GuideCard icon="sparkle" heading="Known for" body={guide.knownFor} />
            <GuideCard icon="landmark" heading="A little history" body={guide.history} />
            <GuideCard icon="place" heading="Local tip" body={guide.localTip} accent />
          </div>
        </Section>
      ) : null}

      {/* Discussion */}
      <Section title="Discussion" count={hub.topics.length}>
        {hub.topics.length === 0 ? (
          <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
            <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>No topics in {label} yet</div>
            <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5 }}>
              Be the first — ask a question, share a recommendation, or suggest something to do.
            </p>
          </Card>
        ) : (
          <div style={{ display: "grid", gap: "var(--space-3)" }}>
            {hub.topics.map((t) => {
              const href = t.slug ? townHallTopicPath(t.locality, t.slug) : `/town-hall/${t.id}`;
              return (
                <Card key={t.id} style={{ padding: "var(--space-4)" }}>
                  <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>
                    <h3 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, lineHeight: 1.3, margin: 0 }}>{t.title}</h3>
                  </Link>
                  <p style={{ margin: "4px 0 0", color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {linkifyHashtags(t.body)}
                  </p>
                  <div style={{ marginTop: "var(--space-2)", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
                    <span>♥ {t.upvoteCount}</span>
                    <span aria-hidden>·</span>
                    <span>{t.replyCount === 1 ? "1 reply" : `${t.replyCount} replies`}</span>
                    {t.createdAt ? (<><span aria-hidden>·</span><span>{timeAgo(t.createdAt)}</span></>) : null}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      {/* Featured venues — real chips when we have them, a "coming soon" placeholder while the
          town has none yet. The section always renders so the hub stays visibly richer than the
          interactive board (which has no Places / Local news). Placeholders self-hide once real
          venues arrive. */}
      <Section title={`Places in ${label}`} count={stats?.total ?? venues.length}>
        {venues.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
            {venues.map((v) => (
              <Link
                key={v.id}
                href={`/venue/${v.slug ?? v.id}`}
                style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 14px", borderRadius: 999, background: "var(--paper-2)", border: "1px solid var(--line)", textDecoration: "none", color: "var(--ink)" }}
              >
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{v.name}</span>
                {v.rating != null ? <span style={{ fontSize: 12, color: "var(--muted)" }}>★ {v.rating.toFixed(1)}</span> : null}
              </Link>
            ))}
            {stats && stats.total > venues.length ? (
              <Link
                href="/explore"
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 999, background: "var(--crimson-tint)", border: "1px solid var(--crimson-tint-2)", textDecoration: "none", color: "var(--crimson-700)", fontWeight: 600, fontSize: 13.5 }}
              >
                Explore all {stats.total} places <span aria-hidden>→</span>
              </Link>
            ) : null}
          </div>
        ) : (
          <PlaceholderCard
            icon="shop"
            title={`Local places in ${label}`}
            body={`The top-rated and most-followed spots — cafés, bars, restaurants and more — will be featured here as venues join Roam in ${label}.`}
          />
        )}
      </Section>

      {/* Local news — real posts when present, otherwise a placeholder describing what lands here. */}
      <Section title={`Local news in ${label}`} count={news.length}>
        {news.length > 0 ? (
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            {news.map((n) => (
              <Link key={n.id} href={`/feed/${n.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                <Card style={{ padding: "var(--space-3) var(--space-4)" }}>
                  <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15 }}>
                    {n.title ?? (n.venueName ? `${n.venueName} — update` : "Local update")}
                  </div>
                  {n.body ? (
                    <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{n.body}</p>
                  ) : null}
                  <div style={{ marginTop: 4, fontSize: 12, color: "var(--muted)" }}>
                    {n.venueName ?? ""}{n.publishedAt ? ` · ${timeAgo(n.publishedAt)}` : ""}
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
          <PlaceholderCard
            icon="megaphone"
            title={`Local news in ${label}`}
            body={`Updates, offers and events posted by ${label} venues will show up here as local businesses join Roam.`}
          />
        )}
      </Section>
    </main>
  );
}

/** One town-guide fact card: icon chip, mono kicker heading, the editorial copy. */
function GuideCard({ icon, heading, body, accent = false }: { icon: IconName; heading: string; body: string; accent?: boolean }) {
  return (
    <Card style={{ padding: "var(--space-4)", ...(accent ? { background: "var(--crimson-tint)", border: "1px solid var(--crimson-tint-2)" } : {}) }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span aria-hidden style={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 10, background: accent ? "rgba(255,255,255,.75)" : "var(--crimson-tint)", color: "var(--crimson-700)", flexShrink: 0 }}>
          <Icon name={icon} size={16} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--crimson-700)", marginBottom: 4 }}>
            {heading}
          </div>
          <p style={{ margin: 0, color: "var(--ink)", fontSize: 14, lineHeight: 1.6 }}>{body}</p>
        </div>
      </div>
    </Card>
  );
}

/**
 * PlaceholderCard — a temporary, clearly-labelled "coming soon" card shown in the Places / Local
 * news sections while a town has none yet. It fills the hub out so it reads as a richer town
 * overview (distinct from the interactive board), and disappears on its own once real venues or
 * news exist. Intentionally illustrative — no fabricated venue names or headlines.
 */
function PlaceholderCard({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <Card flat style={{ padding: "var(--space-5)", borderStyle: "dashed", borderColor: "var(--line)", background: "var(--paper-2)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span aria-hidden style={{ display: "grid", placeItems: "center", width: 38, height: 38, borderRadius: 10, background: "var(--crimson-tint)", color: "var(--crimson-700)", flexShrink: 0 }}>
          <Icon name={icon} size={18} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>{title}</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--crimson-700)", background: "var(--crimson-tint)", padding: "2px 7px", borderRadius: 999 }}>
              Coming soon
            </span>
          </div>
          <p style={{ margin: "4px 0 0", color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.5 }}>{body}</p>
        </div>
      </div>
    </Card>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: "var(--space-6)" }}>
      <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 18, margin: "0 0 var(--space-3)" }}>
        {title}{count != null && count > 0 ? <span style={{ color: "var(--muted)", fontWeight: 400 }}> · {count}</span> : null}
      </h2>
      {children}
    </section>
  );
}
