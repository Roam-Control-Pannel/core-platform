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
import type { VenueSeo, ProfileSeo, PostSeo, TopicSeo } from "./seo";

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

export const getTopic = cache(async (topicId: string): Promise<TopicSeo | null> => {
  try {
    const c = anon() as unknown as { townHall: { getTopic: { query: (i: { topicId: string }) => Promise<TopicSeo | null> } } };
    return (await c.townHall.getTopic.query({ topicId })) ?? null;
  } catch {
    return null;
  }
});

/* ── Sitemap source lists ────────────────────────────────────────────────────────────────── */

export interface SeoIdRow {
  id: string;
  lastmod: string | null;
}
export interface SeoProfileRow extends SeoIdRow {
  handle: string | null;
}
export interface SeoTopicRow extends SeoIdRow {
  locality: string | null;
}
export interface SeoLists {
  venues: SeoIdRow[];
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
        venues: { query: (i: { limit: number }) => Promise<SeoIdRow[]> };
        profiles: { query: (i: { limit: number }) => Promise<SeoProfileRow[]> };
        posts: { query: (i: { limit: number }) => Promise<SeoIdRow[]> };
        topics: { query: (i: { limit: number }) => Promise<SeoTopicRow[]> };
      };
    };
    const [venues, profiles, posts, topics] = await Promise.all([
      c.seo.venues.query({ limit: 5000 }).catch(() => [] as SeoIdRow[]),
      c.seo.profiles.query({ limit: 5000 }).catch(() => [] as SeoProfileRow[]),
      c.seo.posts.query({ limit: 5000 }).catch(() => [] as SeoIdRow[]),
      c.seo.topics.query({ limit: 5000 }).catch(() => [] as SeoTopicRow[]),
    ]);
    return { venues, profiles, posts, topics };
  } catch {
    return EMPTY;
  }
});
