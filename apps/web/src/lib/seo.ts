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

/** The brand default share image (square brand mark; replaced by a proper 1200×630 OG later). */
const DEFAULT_OG = "/roam-mark.png";

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

interface TopicAuthor {
  id: string | null;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}
export interface TopicSeo {
  topic: {
    id: string;
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

/* ── Metadata builders ───────────────────────────────────────────────────────────────────── */

/** A consistent OpenGraph + Twitter block from the resolved title/description/image/url. */
function social(opts: { title: string; description: string; url: string; image?: string; type?: "website" | "article" | "profile" }): Pick<Metadata, "openGraph" | "twitter"> {
  const image = opts.image ?? DEFAULT_OG;
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
  const path = `/venue/${id}`;
  if (!venue) return notFoundMeta(path);
  const place = [venue.locality, venue.region].filter(Boolean).join(", ");
  const title = venue.name;
  const fallback = `${venue.name}${venue.category ? ` — ${venue.category}` : ""}${place ? ` in ${place}` : ""}. Photos, reviews, opening hours and updates on Roam.`;
  const description = clamp((venue.description && venue.description.trim()) || fallback);
  const url = absUrl(path);
  return {
    title,
    description,
    alternates: { canonical: url },
    ...social({ title, description, url }),
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
    ...social({ title, description, url, type: "profile", ...(image ? { image } : {}) }),
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
  return {
    title,
    description,
    alternates: { canonical: url },
    ...social({ title, description, url, type: "article", ...(image ? { image } : {}) }),
  };
}

export function topicMetadata(data: TopicSeo | null, id: string): Metadata {
  const path = `/town-hall/${id}`;
  if (!data) return notFoundMeta(path);
  const { topic } = data;
  const title = topic.title;
  const fallback = `${topic.title} — Town Hall discussion${topic.localityLabel ? ` in ${topic.localityLabel}` : ""} on Roam.`;
  const description = clamp((topic.body && topic.body.trim()) || fallback);
  const url = absUrl(path);
  return {
    title,
    description,
    alternates: { canonical: url },
    ...social({ title, description, url, type: "article" }),
  };
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
    url: absUrl(`/venue/${id}`),
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
    url: absUrl(`/town-hall/${id}`),
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
