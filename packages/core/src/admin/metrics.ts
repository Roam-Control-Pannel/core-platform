/**
 * Roam HQ — top-level metrics. Site-wide aggregates computed from the normalised
 * tables (there are no rollups; the dashboard derives everything live).
 *
 * All reads run through a service-role client (RLS-bypassing) — the ONLY way to see
 * across every tenant. That client is built and handed in by the api's adminProcedure,
 * which has already verified the caller is Roam HQ staff.
 */
import type { RoamClient } from "@roam/db";
import { countWhere, isoAgo, loose, DAY_MS } from "./loose.js";

export interface Pulse {
  users: { total: number; new24h: number; new7d: number; new30d: number };
  venues: { total: number; claimed: number; new30d: number };
  content: { posts7d: number; forum7d: number };
  /** When these numbers were computed (rolling windows end here). */
  generatedAt: string;
}

/** The headline numbers for the dashboard's top strip. */
export async function getPulse(client: RoamClient): Promise<Pulse> {
  const since24h = isoAgo(DAY_MS);
  const since7d = isoAgo(7 * DAY_MS);
  const since30d = isoAgo(30 * DAY_MS);

  const [
    usersTotal,
    usersNew24h,
    usersNew7d,
    usersNew30d,
    venuesTotal,
    venuesClaimed,
    venuesNew30d,
    posts7d,
    topics7d,
    replies7d,
  ] = await Promise.all([
    countWhere(client, "profiles"),
    countWhere(client, "profiles", (q) => q.gte("created_at", since24h)),
    countWhere(client, "profiles", (q) => q.gte("created_at", since7d)),
    countWhere(client, "profiles", (q) => q.gte("created_at", since30d)),
    countWhere(client, "venues"),
    countWhere(client, "venues", (q) => q.not("owner_id", "is", null)),
    countWhere(client, "venues", (q) => q.gte("created_at", since30d)),
    countWhere(client, "profile_posts", (q) => q.gte("created_at", since7d)),
    countWhere(client, "town_hall_topics", (q) => q.gte("created_at", since7d)),
    countWhere(client, "town_hall_replies", (q) => q.gte("created_at", since7d)),
  ]);

  return {
    users: {
      total: usersTotal,
      new24h: usersNew24h,
      new7d: usersNew7d,
      new30d: usersNew30d,
    },
    venues: { total: venuesTotal, claimed: venuesClaimed, new30d: venuesNew30d },
    content: { posts7d, forum7d: topics7d + replies7d },
    generatedAt: new Date().toISOString(),
  };
}

export interface TrendPoint {
  /** Calendar day, YYYY-MM-DD (UTC). */
  date: string;
  count: number;
}

/**
 * Daily signup counts over the last `days` days (inclusive of today), zero-filled so
 * the sparkline has a point per day. Buckets by UTC calendar day.
 */
export async function getSignupTrend(
  client: RoamClient,
  days = 30,
): Promise<TrendPoint[]> {
  const since = isoAgo(days * DAY_MS);
  const { data, error } = await loose(client)
    .from("profiles")
    .select("created_at")
    .gte("created_at", since);
  if (error) throw new Error(`admin: signup trend failed: ${error.message}`);

  const buckets = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    buckets.set(new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10), 0);
  }
  for (const row of (data ?? []) as Array<{ created_at: string }>) {
    const day = row.created_at.slice(0, 10);
    if (buckets.has(day)) buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([date, count]) => ({ date, count }));
}

export interface ContentBreakdown {
  posts: number;
  forumTopics: number;
  forumReplies: number;
  follows: number;
  friendships: number;
  events: number;
  redemptions: number;
}

/** All-time totals for the content & social breakdown panel. */
export async function getContentBreakdown(
  client: RoamClient,
): Promise<ContentBreakdown> {
  const [posts, forumTopics, forumReplies, follows, friendships, events, redemptions] =
    await Promise.all([
      countWhere(client, "profile_posts"),
      countWhere(client, "town_hall_topics"),
      countWhere(client, "town_hall_replies"),
      countWhere(client, "follows"),
      countWhere(client, "friendships", (q) => q.eq("status", "accepted")),
      countWhere(client, "events"),
      countWhere(client, "offer_redemptions"),
    ]);
  return { posts, forumTopics, forumReplies, follows, friendships, events, redemptions };
}
