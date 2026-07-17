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
import { siteUrl, HUB_MIN_VENUES, DISCOVER_MIN_VENUES } from "../lib/seo";
import { getSeoLists, getHubTowns, getDiscoverCombos } from "../lib/serverApi";
import { townGuideSlugs } from "../lib/townGuides";
import { discoverCategories, discoverSlugForCategory } from "../lib/discover";

export const revalidate = 3600;

/** Coerce a possibly-null timestamp into a Date for <lastmod>, omitting it when absent. */
function mod(lastmod: string | null): { lastModified?: Date } {
  if (!lastmod) return {};
  const d = new Date(lastmod);
  return Number.isNaN(d.getTime()) ? {} : { lastModified: d };
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const [lists, towns, combos] = await Promise.all([
    getSeoLists(),
    getHubTowns(),
    getDiscoverCombos(discoverCategories(), DISCOVER_MIN_VENUES),
  ]);

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
  // Hub pages: topic towns, venue-backed towns AND guide-backed towns — the union, but only
  // hubs substantial enough to index (the same rule the hub page's metadata applies), so the
  // sitemap never lists a noindex URL. Guide towns come from the checked-in town-guides data.
  const hubSlugs = new Set(townGuideSlugs());
  const hubRows: MetadataRoute.Sitemap = towns
    .filter((h) => h.topicCount > 0 || h.venueCount >= HUB_MIN_VENUES)
    .map((h) => {
      hubSlugs.delete(h.locality);
      return {
        url: `${base}/town-hall/${h.locality}`,
        changeFrequency: "daily" as const,
        priority: 0.7,
        ...mod(h.lastmod),
      };
    });
  const hubs: MetadataRoute.Sitemap = [
    ...hubRows,
    ...Array.from(hubSlugs).map((slug) => ({
      url: `${base}/town-hall/${slug}`,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];

  const listings: MetadataRoute.Sitemap = lists.listings.map((l) => ({
    url: `${base}/market/${l.id}`,
    changeFrequency: "weekly",
    priority: 0.5,
    ...mod(l.lastmod),
  }));

  // Discovery pages (/discover/{town}/{category}): only combos that clear the venue bar AND whose
  // town has an editorial guide — the guide's name is the canonical label the page uses to match
  // venues, so a guide-backed slug is guaranteed to round-trip (no dead sitemap URLs). The category
  // is mapped from the core CATEGORY to its published discovery slug; unmapped categories are skipped.
  const guideSet = new Set(townGuideSlugs());
  const discover: MetadataRoute.Sitemap = combos.flatMap((c) => {
    if (!guideSet.has(c.locality)) return [];
    const catSlug = discoverSlugForCategory(c.category);
    if (!catSlug) return [];
    return [{ url: `${base}/discover/${c.locality}/${catSlug}`, changeFrequency: "weekly" as const, priority: 0.6, ...mod(c.lastmod) }];
  });

  return [...staticRoutes, ...hubs, ...venues, ...profiles, ...posts, ...topics, ...listings, ...discover];
}
