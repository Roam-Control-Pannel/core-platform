/**
 * sitemap.xml (generated). Lists the public, indexable URLs: the static hubs plus every
 * public venue, profile, published post and Town Hall topic (ids + lastmod pulled from the
 * API's seo.* lists, anonymous reads over world-readable tables).
 *
 * Cached for an hour (revalidate) so we don't hammer the API on every crawler hit, while still
 * picking up new content within the hour. If the API is unreachable the dynamic lists come back
 * empty and we still emit a valid sitemap of the static routes.
 */
import type { MetadataRoute } from "next";
import { siteUrl, HUB_MIN_VENUES } from "../lib/seo";
import { getSeoLists, getHubTowns } from "../lib/serverApi";

export const revalidate = 3600;

/** Coerce a possibly-null timestamp into a Date for <lastmod>, omitting it when absent. */
function mod(lastmod: string | null): { lastModified?: Date } {
  if (!lastmod) return {};
  const d = new Date(lastmod);
  return Number.isNaN(d.getTime()) ? {} : { lastModified: d };
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const [lists, towns] = await Promise.all([getSeoLists(), getHubTowns()]);

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "daily", priority: 1 },
    { url: `${base}/explore`, changeFrequency: "daily", priority: 0.9 },
    { url: `${base}/town-hall`, changeFrequency: "daily", priority: 0.8 },
    { url: `${base}/business`, changeFrequency: "monthly", priority: 0.5 },
  ];

  const venues: MetadataRoute.Sitemap = lists.venues.map((v) => ({
    url: `${base}/venue/${v.slug ?? v.id}`,
    changeFrequency: "weekly",
    priority: 0.8,
    ...mod(v.lastmod),
  }));
  const profiles: MetadataRoute.Sitemap = lists.profiles.map((p) => ({
    url: `${base}/u/${p.handle ?? p.id}`,
    changeFrequency: "weekly",
    priority: 0.5,
    ...mod(p.lastmod),
  }));
  const posts: MetadataRoute.Sitemap = lists.posts.map((p) => ({
    url: `${base}/feed/${p.id}`,
    changeFrequency: "monthly",
    priority: 0.6,
    ...mod(p.lastmod),
  }));
  const topics: MetadataRoute.Sitemap = lists.topics.map((t) => ({
    url: t.locality && t.slug ? `${base}/town-hall/${t.locality}/${t.slug}` : `${base}/town-hall/${t.id}`,
    changeFrequency: "weekly",
    priority: 0.6,
    ...mod(t.lastmod),
  }));
  // Hub pages: topic towns AND venue-backed towns, but only hubs substantial enough to
  // index (the same rule the hub page's metadata applies) — never list a noindex URL.
  const hubs: MetadataRoute.Sitemap = towns
    .filter((h) => h.topicCount > 0 || h.venueCount >= HUB_MIN_VENUES)
    .map((h) => ({
      url: `${base}/town-hall/${h.locality}`,
      changeFrequency: "daily" as const,
      priority: 0.7,
      ...mod(h.lastmod),
    }));

  return [...staticRoutes, ...hubs, ...venues, ...profiles, ...posts, ...topics];
}
