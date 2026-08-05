/**
 * Roam HQ — the live site-wide activity feed.
 *
 * There is no event log in the platform, so we build the feed by reading the most
 * recent rows from each high-signal table, normalising them to a common shape, and
 * merging by time. Actors are resolved in a single profiles lookup (rather than
 * per-row FK embeds) to stay robust against generated-type / FK-name drift.
 */
import type { RoamClient } from "@roam/db";
import { loose } from "./loose.js";

export type ActivityKind =
  | "signup"
  | "post"
  | "forum_topic"
  | "forum_reply"
  | "follow"
  | "event"
  | "venue_claim";

export interface ActivityActor {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface ActivityItem {
  /** Synthetic, stable id: `${kind}:${sourceRowId}`. */
  id: string;
  kind: ActivityKind;
  createdAt: string;
  actor: ActivityActor | null;
  /** Human-readable one-liner, already localised to plain English. */
  title: string;
  /** What the item is about, for a future drill-in link. */
  entity: { type: string; id: string } | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function recent(
  client: RoamClient,
  table: string,
  cols: string,
  orderCol: string,
  limit: number,
): Promise<any[]> {
  const { data, error } = await loose(client)
    .from(table)
    .select(cols)
    .order(orderCol, { ascending: false })
    .limit(limit);
  if (error) throw new Error(`admin: feed read ${table} failed: ${error.message}`);
  return (data ?? []) as any[];
}

/** An item before its actor profile has been resolved. */
interface Raw {
  id: string;
  kind: ActivityKind;
  createdAt: string;
  actorId: string | null;
  title: string;
  entity: { type: string; id: string } | null;
}

/**
 * The merged, newest-first activity stream across signups, wall posts, forum topics
 * & replies, venue follows, events and venue claims. Reads `limit` from each source,
 * merges, then returns the newest `limit` overall.
 */
export async function getActivityFeed(
  client: RoamClient,
  limit = 40,
): Promise<ActivityItem[]> {
  const [signups, posts, topics, replies, follows, events, claims] = await Promise.all([
    recent(client, "profiles", "id, handle, display_name, created_at", "created_at", limit),
    recent(client, "profile_posts", "id, author_id, created_at", "created_at", limit),
    recent(client, "town_hall_topics", "id, author_id, title, locality_label, created_at", "created_at", limit),
    recent(client, "town_hall_replies", "id, author_id, topic_id, created_at", "created_at", limit),
    recent(client, "follows", "follower_id, venue_id, created_at", "created_at", limit),
    recent(client, "events", "id, author_id, title, locality_label, created_at", "created_at", limit),
    recent(client, "venue_claims", "id, claimant_id, venue_id, status, created_at", "created_at", limit),
  ]);

  const raw: Raw[] = [
    ...signups.map((r): Raw => ({
      id: `signup:${r.id}`,
      kind: "signup",
      createdAt: r.created_at,
      actorId: r.id,
      title: "joined Roam",
      entity: { type: "profile", id: r.id },
    })),
    ...posts.map((r): Raw => ({
      id: `post:${r.id}`,
      kind: "post",
      createdAt: r.created_at,
      actorId: r.author_id,
      title: "posted on their wall",
      entity: { type: "post", id: r.id },
    })),
    ...topics.map((r): Raw => ({
      id: `forum_topic:${r.id}`,
      kind: "forum_topic",
      createdAt: r.created_at,
      actorId: r.author_id,
      title: `started a Forum topic in ${r.locality_label}: “${r.title}”`,
      entity: { type: "forum_topic", id: r.id },
    })),
    ...replies.map((r): Raw => ({
      id: `forum_reply:${r.id}`,
      kind: "forum_reply",
      createdAt: r.created_at,
      actorId: r.author_id,
      title: "replied on a Forum topic",
      entity: { type: "forum_topic", id: r.topic_id },
    })),
    ...follows.map((r): Raw => ({
      id: `follow:${r.follower_id}:${r.venue_id}`,
      kind: "follow",
      createdAt: r.created_at,
      actorId: r.follower_id,
      title: "followed a venue",
      entity: { type: "venue", id: r.venue_id },
    })),
    ...events.map((r): Raw => ({
      id: `event:${r.id}`,
      kind: "event",
      createdAt: r.created_at,
      actorId: r.author_id,
      title: `created an event in ${r.locality_label}: “${r.title}”`,
      entity: { type: "event", id: r.id },
    })),
    ...claims.map((r): Raw => ({
      id: `venue_claim:${r.id}`,
      kind: "venue_claim",
      createdAt: r.created_at,
      actorId: r.claimant_id,
      title: `submitted a venue claim (${r.status})`,
      entity: { type: "venue", id: r.venue_id },
    })),
  ];

  raw.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const top = raw.slice(0, limit);

  const actorIds = [...new Set(top.map((r) => r.actorId).filter((v): v is string => !!v))];
  const actors = await resolveActors(client, actorIds);

  return top.map((r) => ({
    id: r.id,
    kind: r.kind,
    createdAt: r.createdAt,
    actor: r.actorId ? actors.get(r.actorId) ?? null : null,
    title: r.title,
    entity: r.entity,
  }));
}

async function resolveActors(
  client: RoamClient,
  ids: string[],
): Promise<Map<string, ActivityActor>> {
  const map = new Map<string, ActivityActor>();
  if (ids.length === 0) return map;
  const { data, error } = await loose(client)
    .from("profiles")
    .select("id, handle, display_name, avatar_url")
    .in("id", ids);
  if (error) throw new Error(`admin: resolve actors failed: ${error.message}`);
  for (const p of (data ?? []) as any[]) {
    map.set(p.id, {
      id: p.id,
      handle: p.handle ?? null,
      displayName: p.display_name ?? null,
      avatarUrl: p.avatar_url ?? null,
    });
  }
  return map;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
