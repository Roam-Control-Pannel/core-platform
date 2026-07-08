/**
 * SEO helpers — the single place the web app builds page <head> metadata and schema.org
 * JSON-LD from public content. Imported by the server components in each route's page.tsx
 * (their generateMetadata + the JsonLd they render) and by sitemap.ts / robots.ts.
 *
 * Pure functions only (no JSX, no client code) so they're safe to import anywhere. The row
 * shapes mirror what the API's public reads return (venues.byId, profiles.byId, posts.byId,
 * townHall.getTopic) — only the fields we actually surface to crawlers.
 *
 * Domain source of truth is NEXT_PUBLIC_SITE_URL (same var the rest of the app uses), with the
 * standard localhost fallback so nothing throws when it's unset during local dev / static analysis.
 */
import type { Metadata } from "next";

/** The site's canonical origin, no trailing slash. */
export function siteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

/** Absolute URL for a site-relative path (path should start with "/"). */
export function absUrl(path: string): string {
  return `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Trim text to a sentence-friendly length for meta descriptions (~160 chars). */
export function clamp(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/**
 * The generated 1200×630 branded card (app/og/route.tsx) — the og:image for any page whose
 * entity has no content image of its own. Params are length-capped here AND clamped again by
 * the endpoint, so upstream text can be passed as-is.
 */
export function ogCardUrl(opts: { title: string; subtitle?: string; badge?: string }): string {
  const p = new URLSearchParams();
  p.set("title", clamp(opts.title, 90));
  if (opts.subtitle) p.set("sub", clamp(opts.subtitle, 120));
  if (opts.badge) p.set("badge", clamp(opts.badge, 40));
  return absUrl(`/og?${p.toString()}`);
}

/** Drop keys whose value is undefined (keeps null — meaningful in Metadata/JSON-LD). */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/* ── Shared row shapes (subset of the API's public reads we surface) ──────────────────────── */

export interface VenueSeo {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  locality: string | null;
  region: string | null;
  category: string | null;
  rating: number | null;
  rating_count: number | null;
}

export interface ProfileSeo {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  headerUrl: string | null;
  bio: string | null;
}

export interface PostSeo {
  id: string;
  kind: string;
  title: string | null;
  body: string | null;
  media: { type: "image"; url: string }[];
  publishedAt: string | null;
  venueId: string | null;
  venueName: string | null;
  venueLocality: string | null;
}

export interface WallPostSeo {
  id: string;
  body: string | null;
  media: { type: "image" | "video"; url: string }[];
  createdAt: string;
  author: { id: string | null; handle: string | null; displayName: string | null; avatarUrl: string | null };
}

export interface DealSeo {
  id: string;
  advertiserName: string | null;
  title: string;
  description: string | null;
  imageUrl: string | null;
  endsAt: string | null;
}

export interface PlanSeo {
  id: string;
  title: string;
  plannedFor: string | null;
  headerUrl: string | null;
  memberCount: number;
  venueCount: number;
}

interface TopicAuthor {
  id: string | null;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}
export interface TopicSeo {
  topic: {
    id: string;
    slug: string | null;
    locality: string;
    localityLabel: string;
    title: string;
    body: string;
    upvoteCount: number;
    replyCount: number;
    createdAt: string | null;
    lastActivityAt: string | null;
    author: TopicAuthor;
  };
  replies: { id: string; body: string; createdAt: string | null; author: TopicAuthor }[];
}

/** The canonical path for a topic — nested when it has a slug, legacy id otherwise. */
function topicPath(topic: { id: string; slug: string | null; locality: string }, fallbackId: string): string {
  return topic.slug ? `/town-hall/${topic.locality}/${topic.slug}` : `/town-hall/${fallbackId}`;
}

/* ── Metadata builders ───────────────────────────────────────────────────────────────────── */

/**
 * A consistent OpenGraph + Twitter block from the resolved title/description/image/url.
 * When the entity has no content image, the card is a GENERATED branded 1200×630 (ogCardUrl):
 * title + description as the card copy, `badge` as its uppercase context line.
 */
function social(opts: { title: string; description: string; url: string; image?: string; badge?: string; type?: "website" | "article" | "profile" }): Pick<Metadata, "openGraph" | "twitter"> {
  const image =
    opts.image ??
    ogCardUrl({ title: opts.title, subtitle: opts.description, ...(opts.badge ? { badge: opts.badge } : {}) });
  return {
    openGraph: compact({
      title: opts.title,
      description: opts.description,
      url: opts.url,
      siteName: "Roam",
      type: opts.type ?? "website",
      images: [{ url: image }],
    }),
    twitter: {
      card: "summary_large_image",
      title: opts.title,
      description: opts.description,
      images: [image],
    },
  };
}

/** Metadata to apply to a public detail page that resolved to a missing/removed entity. */
function notFoundMeta(canonicalPath: string): Metadata {
  return {
    title: "Not found",
    robots: { index: false, follow: true },
    alternates: { canonical: absUrl(canonicalPath) },
  };
}

export function venueMetadata(venue: VenueSeo | null, id: string): Metadata {
  // Canonical on the slug when present; fall back to the id for not-yet-slugged rows.
  const path = `/venue/${venue?.slug ?? id}`;
  if (!venue) return notFoundMeta(`/venue/${id}`);
  const place = [venue.locality, venue.region].filter(Boolean).join(", ");
  const title = venue.name;
  const fallback = `${venue.name}${venue.category ? ` — ${venue.category}` : ""}${place ? ` in ${place}` : ""}. Photos, reviews, opening hours and updates on Roam.`;
  const description = clamp((venue.description && venue.description.trim()) || fallback);
  const url = absUrl(path);
  const badge = [venue.category, venue.locality].filter(Boolean).join(" · ") || "Place";
  return {
    title,
    description,
    alternates: { canonical: url },
    ...social({ title, description, url, badge }),
  };
}

export function profileMetadata(profile: ProfileSeo | null, id: string): Metadata {
  // Canonical on the @handle when we have it; fall back to the id slug for handle-less rows.
  const path = `/u/${profile?.handle ?? id}`;
  if (!profile) return notFoundMeta(`/u/${id}`);
  const name = (profile.displayName && profile.displayName.trim()) || (profile.handle ? `@${profile.handle}` : "Roam member");
  const title = name;
  const fallback = `${name} on Roam — local posts, plans and community in your town.`;
  const description = clamp((profile.bio && profile.bio.trim()) || fallback);
  const url = absUrl(path);
  const image = profile.headerUrl ?? profile.avatarUrl ?? undefined;
  return {
    title,
    description,
    alternates: { canonical: url },
    ...social({ title, description, url, type: "profile", badge: profile.handle ? `@${profile.handle}` : "On Roam", ...(image ? { image } : {}) }),
  };
}

export function postMetadata(post: PostSeo | null, id: string): Metadata {
  const path = `/feed/${id}`;
  if (!post) return notFoundMeta(path);
  const title = (post.title && post.title.trim()) || (post.venueName ? `${post.venueName} — local update` : "Local update");
  const fallback = `${post.venueName ? `${post.venueName}${post.venueLocality ? `, ${post.venueLocality}` : ""} — ` : ""}a local update on Roam.`;
  const description = clamp((post.body && post.body.trim()) || fallback);
  const url = absUrl(path);
  const image = post.media[0]?.url;
  const badge = ["Local news", post.venueLocality].filter(Boolean).join(" · ");
  return {
    title,
    description,
    alternates: { canonical: url },
    ...social({ title, description, url, type: "article", badge, ...(image ? { image } : {}) }),
  };
}

/** A personal wall post's permalink (/p/[postId]). Personal content: shareable, not sitemap'd. */
export function wallPostMetadata(post: WallPostSeo | null, id: string): Metadata {
  const path = `/p/${id}`;
  if (!post) return notFoundMeta(path);
  const name =
    (post.author.displayName && post.author.displayName.trim()) ||
    (post.author.handle ? `@${post.author.handle}` : "A Roam member");
  const title = `${name} on Roam`;
  const description = clamp((post.body && post.body.trim()) || `A post by ${name} on Roam.`);
  const url = absUrl(path);
  const image = post.media.find((m) => m.type === "image")?.url;
  const badge = post.author.handle ? `@${post.author.handle}` : "On Roam";
  return {
    title,
    description,
    alternates: { canonical: url },
    ...social({ title, description, url, type: "article", badge, ...(image ? { image } : {}) }),
  };
}

export function wallPostJsonLd(post: WallPostSeo, id: string): Record<string, unknown> {
  const name =
    (post.author.displayName && post.author.displayName.trim()) ||
    (post.author.handle ? `@${post.author.handle}` : null);
  const images = post.media.filter((m) => m.type === "image").map((m) => m.url);
  return compact({
    "@context": "https://schema.org",
    "@type": "SocialMediaPosting",
    articleBody: post.body ?? undefined,
    datePublished: post.createdAt,
    image: images.length ? images : undefined,
    url: absUrl(`/p/${id}`),
    author: name ? compact({ "@type": "Person", name, url: post.author.id ? absUrl(`/u/${post.author.handle ?? post.author.id}`) : undefined }) : undefined,
  });
}

/** A plan's shared-link teaser (/plans/[planId]). Private content: link previews only, noindex. */
export function planMetadata(plan: PlanSeo | null, id: string): Metadata {
  const path = `/plans/${id}`;
  if (!plan) return notFoundMeta(path);
  const when = plan.plannedFor
    ? new Date(plan.plannedFor).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
    : null;
  const bits = [
    when,
    plan.venueCount > 0 ? `${plan.venueCount} ${plan.venueCount === 1 ? "place" : "places"}` : null,
    plan.memberCount > 0 ? `${plan.memberCount} going` : null,
  ].filter(Boolean);
  const title = plan.title;
  const description = clamp(`${bits.length ? `${bits.join(" · ")} — ` : ""}a plan on Roam. Sign in to see the details and join.`);
  const url = absUrl(path);
  return {
    title,
    description,
    alternates: { canonical: url },
    // Plans are private-by-membership; the teaser exists for link recipients, never for search.
    robots: { index: false, follow: false },
    ...social({ title, description, url, badge: "Plan", ...(plan.headerUrl ? { image: plan.headerUrl } : {}) }),
  };
}

/** A deal's permalink (/deals/[dealId]). Affiliate content: shareable, noindex (ephemeral). */
export function dealMetadata(deal: DealSeo | null, id: string): Metadata {
  const path = `/deals/${id}`;
  if (!deal) return notFoundMeta(path);
  const title = deal.advertiserName ? `${deal.title} — ${deal.advertiserName}` : deal.title;
  const description = clamp(
    (deal.description && deal.description.trim()) ||
      `${deal.title}${deal.advertiserName ? ` from ${deal.advertiserName}` : ""} — a partner deal on Roam.`,
  );
  const url = absUrl(path);
  return {
    title,
    description,
    alternates: { canonical: url },
    // Deals expire and churn on the affiliate feed's schedule — keep them out of the index so
    // search never lands users on a dead offer, while the OG block still powers link previews.
    robots: { index: false, follow: true },
    ...social({ title, description, url, badge: deal.advertiserName ? `Deal · ${deal.advertiserName}` : "Deal", ...(deal.imageUrl ? { image: deal.imageUrl } : {}) }),
  };
}

export function topicMetadata(data: TopicSeo | null, id: string): Metadata {
  if (!data) return notFoundMeta(`/town-hall/${id}`);
  const { topic } = data;
  const title = topic.title;
  const fallback = `${topic.title} — Town Hall discussion${topic.localityLabel ? ` in ${topic.localityLabel}` : ""} on Roam.`;
  const description = clamp((topic.body && topic.body.trim()) || fallback);
  const url = absUrl(topicPath(topic, id));
  return {
    title,
    description,
    alternates: { canonical: url },
    ...social({ title, description, url, type: "article", badge: `Town Hall · ${topic.localityLabel}` }),
  };
}

/**
 * A hub is substantial enough to index once the town has discussion OR this many venues —
 * genuine local content either way. Below that it stays noindex (no thin doorway pages).
 * The sitemap applies the SAME rule so it never lists a noindex URL.
 */
export const HUB_MIN_VENUES = 3;

/** Whether a town hub clears the thin-content bar (shared by hub metadata + sitemap). */
export function hubIndexable(hasTopics: boolean, venueCount: number): boolean {
  return hasTopics || venueCount >= HUB_MIN_VENUES;
}

/** Metadata for a town hub. Thin towns (no topics, too few venues) are noindex. */
export function hubMetadata(localityLabel: string, locality: string, indexable: boolean, venueTotal = 0): Metadata {
  const title = `${localityLabel} — local community & what's on`;
  const places = venueTotal > 0 ? `${venueTotal} places to go in ${localityLabel}` : `places to go in ${localityLabel}`;
  const description = clamp(`${localityLabel}'s Town Hall on Roam — local discussion, news and recommendations, plus ${places}.`);
  const url = absUrl(`/town-hall/${locality}`);
  return {
    title,
    description,
    alternates: { canonical: url },
    ...(indexable ? {} : { robots: { index: false, follow: true } }),
    ...social({ title, description, url, badge: "Town Hall" }),
  };
}

export function hubJsonLd(
  localityLabel: string,
  locality: string,
  venues: { name: string; slug: string | null; id: string }[] = [],
): Record<string, unknown> {
  return compact({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${localityLabel} — Town Hall`,
    description: `Local discussion, news and places in ${localityLabel}.`,
    url: absUrl(`/town-hall/${locality}`),
    about: { "@type": "Place", name: localityLabel },
    ...(venues.length > 0
      ? {
          mainEntity: {
            "@type": "ItemList",
            name: `Places in ${localityLabel}`,
            itemListElement: venues.map((v, i) => ({
              "@type": "ListItem",
              position: i + 1,
              name: v.name,
              url: absUrl(`/venue/${v.slug ?? v.id}`),
            })),
          },
        }
      : {}),
  });
}

/* ── JSON-LD builders (schema.org) ───────────────────────────────────────────────────────── */

/** Map a free-text venue category to the most specific schema.org LocalBusiness subtype. */
function venueSchemaType(category: string | null): string {
  const c = (category ?? "").toLowerCase();
  if (/coffee|caf[eé]/.test(c)) return "CafeOrCoffeeShop";
  if (/restaurant|dining|eatery|bistro/.test(c)) return "Restaurant";
  if (/bar|pub|tavern/.test(c)) return "BarOrPub";
  if (/hotel|inn|b&b|guest ?house|lodging/.test(c)) return "LodgingBusiness";
  if (/bakery/.test(c)) return "Bakery";
  if (/gym|fitness/.test(c)) return "ExerciseGym";
  if (/shop|store|retail|boutique/.test(c)) return "Store";
  return "LocalBusiness";
}

function personRef(a: TopicAuthor): Record<string, unknown> | undefined {
  const name = (a.displayName && a.displayName.trim()) || (a.handle ? `@${a.handle}` : null);
  if (!name) return undefined;
  return compact({
    "@type": "Person",
    name,
    url: a.id ? absUrl(`/u/${a.id}`) : undefined,
  });
}

export function venueJsonLd(venue: VenueSeo, id: string): Record<string, unknown> {
  const place = [venue.locality, venue.region].filter(Boolean);
  const address = place.length
    ? compact({ "@type": "PostalAddress", addressLocality: venue.locality ?? undefined, addressRegion: venue.region ?? undefined })
    : undefined;
  const aggregateRating =
    venue.rating != null && venue.rating_count != null && venue.rating_count > 0
      ? { "@type": "AggregateRating", ratingValue: venue.rating, reviewCount: venue.rating_count }
      : undefined;
  return compact({
    "@context": "https://schema.org",
    "@type": venueSchemaType(venue.category),
    name: venue.name,
    description: venue.description ?? undefined,
    url: absUrl(`/venue/${venue.slug ?? id}`),
    address,
    aggregateRating,
  });
}

export function profileJsonLd(profile: ProfileSeo, id: string): Record<string, unknown> {
  const name = (profile.displayName && profile.displayName.trim()) || (profile.handle ? `@${profile.handle}` : "Roam member");
  return compact({
    "@context": "https://schema.org",
    "@type": "Person",
    name,
    alternateName: profile.handle ? `@${profile.handle}` : undefined,
    description: profile.bio ?? undefined,
    image: profile.avatarUrl ?? undefined,
    url: absUrl(`/u/${profile.handle ?? id}`),
  });
}

export function postJsonLd(post: PostSeo, id: string): Record<string, unknown> {
  return compact({
    "@context": "https://schema.org",
    "@type": "SocialMediaPosting",
    headline: (post.title && post.title.trim()) || (post.venueName ? `${post.venueName} — local update` : "Local update"),
    articleBody: post.body ?? undefined,
    datePublished: post.publishedAt ?? undefined,
    image: post.media.length ? post.media.map((m) => m.url) : undefined,
    url: absUrl(`/feed/${id}`),
    author: post.venueName ? { "@type": "Organization", name: post.venueName } : undefined,
  });
}

export function topicJsonLd(data: TopicSeo, id: string): Record<string, unknown> {
  const { topic, replies } = data;
  return compact({
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    headline: topic.title,
    text: topic.body,
    url: absUrl(topicPath(topic, id)),
    datePublished: topic.createdAt ?? undefined,
    dateModified: topic.lastActivityAt ?? undefined,
    author: personRef(topic.author),
    interactionStatistic: [
      { "@type": "InteractionCounter", interactionType: "https://schema.org/LikeAction", userInteractionCount: topic.upvoteCount },
      { "@type": "InteractionCounter", interactionType: "https://schema.org/CommentAction", userInteractionCount: topic.replyCount },
    ],
    comment: replies.map((r) =>
      compact({ "@type": "Comment", text: r.body, datePublished: r.createdAt ?? undefined, author: personRef(r.author) }),
    ),
  });
}
