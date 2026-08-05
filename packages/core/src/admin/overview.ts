/**
 * Roam HQ — the Overview page's aggregates.
 *
 * Everything here is computed live from the normalised tables. The dashboard comp asks
 * for a few things the platform doesn't instrument (per-user activity / session data,
 * subscription intervals & churn), so those hero panels are filled by HONEST proxies:
 *   - "Active users" -> new-member velocity (weekly signups) — see getMemberWeekly.
 *   - "Subscribers"  -> this-week engagement (posts + forum + follows) — see engagement7d.
 * No fabricated numbers reach the screen.
 */
import type { RoamClient } from "@roam/db";
import { countWhere, isoAgo, loose, DAY_MS } from "./loose.js";

export interface OverviewStats {
  members: { total: number; new7d: number; new30d: number };
  venues: { total: number; new30d: number; claimed: number; claimedPct: number };
  forum: { topics: number; topics7d: number; replies: number; repliesPerTopic: number };
  offers: { redemptions: number; redemptions7d: number };
  /** This-week engagement — the honest proxy for the "subscribers" hero. */
  engagement7d: { posts: number; forum: number; follows: number; total: number };
  generatedAt: string;
}

/** Everything the Overview KPI strip + right hero needs, in one round-trip. */
export async function getOverview(client: RoamClient): Promise<OverviewStats> {
  const s7 = isoAgo(7 * DAY_MS);
  const s30 = isoAgo(30 * DAY_MS);

  const [
    membersTotal,
    members7,
    members30,
    venuesTotal,
    venues30,
    claimed,
    topics,
    topics7,
    replies,
    redemptions,
    redemptions7,
    posts7,
    replies7,
    follows7,
  ] = await Promise.all([
    countWhere(client, "profiles"),
    countWhere(client, "profiles", (q) => q.gte("created_at", s7)),
    countWhere(client, "profiles", (q) => q.gte("created_at", s30)),
    countWhere(client, "venues"),
    countWhere(client, "venues", (q) => q.gte("created_at", s30)),
    countWhere(client, "venues", (q) => q.not("owner_id", "is", null)),
    countWhere(client, "town_hall_topics"),
    countWhere(client, "town_hall_topics", (q) => q.gte("created_at", s7)),
    countWhere(client, "town_hall_replies"),
    countWhere(client, "offer_redemptions"),
    countWhere(client, "offer_redemptions", (q) => q.gte("redeemed_at", s7)),
    countWhere(client, "profile_posts", (q) => q.gte("created_at", s7)),
    countWhere(client, "town_hall_replies", (q) => q.gte("created_at", s7)),
    countWhere(client, "follows", (q) => q.gte("created_at", s7)),
  ]);

  const engagementForum = topics7 + replies7;
  return {
    members: { total: membersTotal, new7d: members7, new30d: members30 },
    venues: {
      total: venuesTotal,
      new30d: venues30,
      claimed,
      claimedPct: venuesTotal > 0 ? Math.round((claimed / venuesTotal) * 100) : 0,
    },
    forum: {
      topics,
      topics7d: topics7,
      replies,
      repliesPerTopic: topics > 0 ? Math.round((replies / topics) * 10) / 10 : 0,
    },
    offers: { redemptions, redemptions7d: redemptions7 },
    engagement7d: {
      posts: posts7,
      forum: engagementForum,
      follows: follows7,
      total: posts7 + engagementForum + follows7,
    },
    generatedAt: new Date().toISOString(),
  };
}

export interface WeekPoint {
  /** UTC date of the start of the 7-day window (YYYY-MM-DD). */
  weekStart: string;
  count: number;
}

/**
 * New members per rolling 7-day window over the last `weeks` weeks (oldest first).
 * The honest proxy for the "active users" hero — real signup velocity, not sessions.
 */
export async function getMemberWeekly(
  client: RoamClient,
  weeks = 14,
): Promise<WeekPoint[]> {
  const since = isoAgo(weeks * 7 * DAY_MS);
  const { data, error } = await loose(client)
    .from("profiles")
    .select("created_at")
    .gte("created_at", since);
  if (error) throw new Error(`admin: member weekly failed: ${error.message}`);

  const now = Date.now();
  const buckets: WeekPoint[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    buckets.push({
      weekStart: new Date(now - (i + 1) * 7 * DAY_MS).toISOString().slice(0, 10),
      count: 0,
    });
  }
  for (const row of (data ?? []) as Array<{ created_at: string }>) {
    const ago = Math.floor((now - new Date(row.created_at).getTime()) / (7 * DAY_MS));
    if (ago < 0 || ago >= weeks) continue;
    const b = buckets[weeks - 1 - ago];
    if (b) b.count += 1;
  }
  return buckets;
}

export interface NeedsYou {
  reportsPending: number;
  claimsPending: number;
  flaggedProfiles: number;
  wallPosts7d: number;
}

/**
 * The "Needs You" rail — the counts a staffer should glance at each day. Reports and
 * flags are kept DISJOINT by reason (user_report vs auto_flag) so the sidebar badge can
 * add them without double-counting.
 */
export async function getNeedsYou(client: RoamClient): Promise<NeedsYou> {
  const s7 = isoAgo(7 * DAY_MS);
  const [reportsPending, flaggedProfiles, claimsPending, wallPosts7d] = await Promise.all([
    countWhere(client, "moderation_queue", (q) =>
      q.eq("status", "pending").eq("reason", "user_report"),
    ),
    countWhere(client, "moderation_queue", (q) =>
      q.eq("status", "pending").eq("reason", "auto_flag"),
    ),
    countWhere(client, "venue_claims", (q) => q.eq("status", "pending")),
    countWhere(client, "profile_posts", (q) => q.gte("created_at", s7)),
  ]);
  return { reportsPending, claimsPending, flaggedProfiles, wallPosts7d };
}

export interface PlaceCount {
  locality: string;
  count: number;
}

/**
 * Top localities by forum activity over the last `days` days. Aggregated in-process
 * (PostgREST has no group-by) from the window's topic rows.
 */
export async function getTopPlaces(
  client: RoamClient,
  days = 7,
  limit = 5,
): Promise<PlaceCount[]> {
  const since = isoAgo(days * DAY_MS);
  const { data, error } = await loose(client)
    .from("town_hall_topics")
    .select("locality_label")
    .gte("created_at", since)
    .limit(2000);
  if (error) throw new Error(`admin: top places failed: ${error.message}`);

  const tally = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ locality_label: string | null }>) {
    const key = row.locality_label ?? "—";
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([locality, count]) => ({ locality, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
