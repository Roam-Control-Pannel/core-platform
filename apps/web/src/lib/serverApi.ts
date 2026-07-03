/**
 * SERVER-SIDE public reads for SEO — the Next.js server's read-only hop to the API for the
 * bits crawlers need: generateMetadata, JSON-LD, and the sitemap. Uses the same transport as
 * the browser client (lib/trpc.ts) but ANONYMOUS (no Bearer token): every procedure called
 * here is a publicProcedure over a world-readable table, so the anon RLS context is correct
 * and sufficient. No secrets, no service role — safe even if this module were ever bundled.
 *
 * Each fetch is wrapped so a failure NEVER throws into a server render — a missing venue or a
 * transient API blip yields null/[] and the page still renders (the client component re-fetches
 * for the interactive view). Results are memoised per-request via React cache(), so a page's
 * generateMetadata and its JSON-LD share a single API round-trip.
 */
import { cache } from "react";
import { makeTrpcClient } from "./trpc";
import type { VenueSeo, ProfileSeo, PostSeo, TopicSeo, WallPostSeo, DealSeo, PlanSeo } from "./seo";

/** An anonymous tRPC client (no auth header) for public reads. */
function anon() {
  return makeTrpcClient(() => null);
}

export const getVenue = cache(async (venueId: string): Promise<VenueSeo | null> => {
  try {
    const c = anon() as unknown as { venues: { byId: { query: (i: { venueId: string }) => Promise<VenueSeo | null> } } };
    return (await c.venues.byId.query({ venueId })) ?? null;
  } catch {
    return null;
  }
});

export const getVenueBySlug = cache(async (slug: string): Promise<VenueSeo | null> => {
  try {
    const c = anon() as unknown as { venues: { bySlug: { query: (i: { slug: string }) => Promise<VenueSeo | null> } } };
    return (await c.venues.bySlug.query({ slug })) ?? null;
  } catch {
    return null;
  }
});

export const getProfile = cache(async (userId: string): Promise<ProfileSeo | null> => {
  try {
    const c = anon() as unknown as { profiles: { byId: { query: (i: { userId: string }) => Promise<ProfileSeo | null> } } };
    return (await c.profiles.byId.query({ userId })) ?? null;
  } catch {
    return null;
  }
});

export const getProfileByHandle = cache(async (handle: string): Promise<ProfileSeo | null> => {
  try {
    const c = anon() as unknown as { profiles: { byHandle: { query: (i: { handle: string }) => Promise<ProfileSeo | null> } } };
    return (await c.profiles.byHandle.query({ handle })) ?? null;
  } catch {
    return null;
  }
});

export const getPost = cache(async (postId: string): Promise<PostSeo | null> => {
  try {
    const c = anon() as unknown as { posts: { byId: { query: (i: { postId: string }) => Promise<PostSeo | null> } } };
    return (await c.posts.byId.query({ postId })) ?? null;
  } catch {
    return null;
  }
});

export const getWallPost = cache(async (postId: string): Promise<WallPostSeo | null> => {
  try {
    const c = anon() as unknown as { profileWall: { byId: { query: (i: { postId: string }) => Promise<WallPostSeo | null> } } };
    return (await c.profileWall.byId.query({ postId })) ?? null;
  } catch {
    return null;
  }
});

export const getDeal = cache(async (dealId: string): Promise<DealSeo | null> => {
  try {
    const c = anon() as unknown as { deals: { byId: { query: (i: { dealId: string }) => Promise<DealSeo | null> } } };
    return (await c.deals.byId.query({ dealId })) ?? null;
  } catch {
    return null;
  }
});

export const getPlanPreview = cache(async (planId: string): Promise<PlanSeo | null> => {
  try {
    const c = anon() as unknown as { plans: { preview: { query: (i: { planId: string }) => Promise<PlanSeo | null> } } };
    return (await c.plans.preview.query({ planId })) ?? null;
  } catch {
    return null;
  }
});

export const getTopic = cache(async (topicId: string): Promise<TopicSeo | null> => {
  try {
    const c = anon() as unknown as { townHall: { getTopic: { query: (i: { topicId: string }) => Promise<TopicSeo | null> } } };
    return (await c.townHall.getTopic.query({ topicId })) ?? null;
  } catch {
    return null;
  }
});

export const getTopicBySlug = cache(async (locality: string, slug: string): Promise<TopicSeo | null> => {
  try {
    const c = anon() as unknown as {
      townHall: { getTopicBySlug: { query: (i: { locality: string; slug: string }) => Promise<TopicSeo | null> } };
    };
    return (await c.townHall.getTopicBySlug.query({ locality, slug })) ?? null;
  } catch {
    return null;
  }
});

/* ── Town Hall hub ───────────────────────────────────────────────────────────────────────── */

export interface HubTopic {
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
  author: { id: string | null; handle: string | null; displayName: string | null; avatarUrl: string | null };
}
export interface HubData {
  locality: string;
  localityLabel: string;
  hasTopics: boolean;
  topics: HubTopic[];
}
export interface HubVenue {
  id: string;
  slug: string | null;
  name: string;
  category: string | null;
  locality: string | null;
  region: string | null;
  rating: number | null;
  ratingCount: number;
  status: string;
}
export interface HubNews {
  id: string;
  kind: string;
  title: string | null;
  body: string | null;
  media: { type: "image"; url: string }[];
  publishedAt: string | null;
  venueId: string;
  venueName: string | null;
  venueLocality: string | null;
}
export interface TownLocality {
  locality: string;
  label: string;
  topicCount: number;
  lastActivityAt: string;
}

/** The town's board (topics) by locality slug. Returns null only on a hard failure. */
export const getHub = cache(async (locality: string): Promise<HubData | null> => {
  try {
    const c = anon() as unknown as { townHall: { hub: { query: (i: { locality: string }) => Promise<HubData> } } };
    return await c.townHall.hub.query({ locality });
  } catch {
    return null;
  }
});

/** Top venues in the town (matched on the display label, not the slug). */
export const getHubVenues = cache(async (localityLabel: string): Promise<HubVenue[]> => {
  try {
    const c = anon() as unknown as { venues: { byLocality: { query: (i: { locality: string; limit: number }) => Promise<HubVenue[]> } } };
    return await c.venues.byLocality.query({ locality: localityLabel, limit: 6 });
  } catch {
    return [];
  }
});

/** Recent local news (feed posts) in the town. */
export const getHubNews = cache(async (localityLabel: string): Promise<HubNews[]> => {
  try {
    const c = anon() as unknown as { posts: { byLocality: { query: (i: { locality: string; limit: number }) => Promise<HubNews[]> } } };
    return await c.posts.byLocality.query({ locality: localityLabel, limit: 6 });
  } catch {
    return [];
  }
});

/** All towns with a Town Hall board, for the /town-hall index + sitemap hub URLs. */
export const getTownLocalities = cache(async (): Promise<TownLocality[]> => {
  try {
    const c = anon() as unknown as { townHall: { localities: { query: () => Promise<{ localities: TownLocality[] }> } } };
    return (await c.townHall.localities.query()).localities ?? [];
  } catch {
    return [];
  }
});

/* ── Sitemap source lists ────────────────────────────────────────────────────────────────── */

export interface SeoIdRow {
  id: string;
  lastmod: string | null;
}
export interface SeoVenueRow extends SeoIdRow {
  slug: string | null;
}
export interface SeoProfileRow extends SeoIdRow {
  handle: string | null;
}
export interface SeoTopicRow extends SeoIdRow {
  locality: string | null;
  slug: string | null;
}
export interface SeoLists {
  venues: SeoVenueRow[];
  profiles: SeoProfileRow[];
  posts: SeoIdRow[];
  topics: SeoTopicRow[];
}

const EMPTY: SeoLists = { venues: [], profiles: [], posts: [], topics: [] };

/** All public URLs for the sitemap. Each list is independently fault-tolerant (→ [] on error). */
export const getSeoLists = cache(async (): Promise<SeoLists> => {
  try {
    const c = anon() as unknown as {
      seo: {
        venues: { query: (i: { limit: number }) => Promise<SeoVenueRow[]> };
        profiles: { query: (i: { limit: number }) => Promise<SeoProfileRow[]> };
        posts: { query: (i: { limit: number }) => Promise<SeoIdRow[]> };
        topics: { query: (i: { limit: number }) => Promise<SeoTopicRow[]> };
      };
    };
    const [venues, profiles, posts, topics] = await Promise.all([
      c.seo.venues.query({ limit: 5000 }).catch(() => [] as SeoVenueRow[]),
      c.seo.profiles.query({ limit: 5000 }).catch(() => [] as SeoProfileRow[]),
      c.seo.posts.query({ limit: 5000 }).catch(() => [] as SeoIdRow[]),
      c.seo.topics.query({ limit: 5000 }).catch(() => [] as SeoTopicRow[]),
    ]);
    return { venues, profiles, posts, topics };
  } catch {
    return EMPTY;
  }
});
