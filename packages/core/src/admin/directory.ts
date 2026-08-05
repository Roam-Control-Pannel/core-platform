/**
 * Roam HQ — user & venue lookup (search + drill-in detail).
 *
 * Service-role reads (cross-tenant). Search input is sanitised before it reaches a
 * PostgREST `or`/`ilike` filter so a stray comma or paren can't reshape the query.
 */
import type { RoamClient } from "@roam/db";
import { countWhere, loose } from "./loose.js";

/** Strip characters that carry meaning inside a PostgREST filter expression. */
function sanitize(term: string): string {
  return term.replace(/[,()*%\\]/g, " ").trim();
}

export interface UserSummary {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
  banned: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function searchUsers(
  client: RoamClient,
  term: string,
  limit = 20,
): Promise<UserSummary[]> {
  const q = sanitize(term);
  if (!q) return [];
  const like = `%${q}%`;
  const { data, error } = await loose(client)
    .from("profiles")
    .select("id, handle, display_name, avatar_url, created_at, banned_at")
    .or(`handle.ilike.${like},display_name.ilike.${like}`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`admin: user search failed: ${error.message}`);
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    handle: r.handle ?? null,
    displayName: r.display_name ?? null,
    avatarUrl: r.avatar_url ?? null,
    createdAt: r.created_at,
    banned: r.banned_at != null,
  }));
}

export interface VenueSummary {
  id: string;
  name: string;
  status: string;
  locality: string | null;
  claimed: boolean;
  createdAt: string;
}

export async function searchVenues(
  client: RoamClient,
  term: string,
  limit = 20,
): Promise<VenueSummary[]> {
  const q = sanitize(term);
  if (!q) return [];
  const { data, error } = await loose(client)
    .from("venues")
    .select("id, name, status, locality, owner_id, created_at")
    .ilike("name", `%${q}%`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`admin: venue search failed: ${error.message}`);
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    locality: r.locality ?? null,
    claimed: r.owner_id != null,
    createdAt: r.created_at,
  }));
}

export interface UserDetail {
  profile: {
    id: string;
    handle: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    bio: string | null;
    createdAt: string;
    banned: boolean;
    invitedBy: string | null;
  };
  counts: { posts: number; follows: number; friends: number; invited: number };
  recentPosts: Array<{ id: string; body: string | null; createdAt: string }>;
}

export async function getUserDetail(
  client: RoamClient,
  id: string,
): Promise<UserDetail | null> {
  const { data: p, error } = await loose(client)
    .from("profiles")
    .select("id, handle, display_name, avatar_url, bio, created_at, banned_at, invited_by")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`admin: user detail failed: ${error.message}`);
  if (!p) return null;

  const [posts, follows, friends, invited, recent] = await Promise.all([
    countWhere(client, "profile_posts", (q) => q.eq("author_id", id)),
    countWhere(client, "follows", (q) => q.eq("follower_id", id)),
    countWhere(client, "friendships", (q) =>
      q.eq("status", "accepted").or(`requester_id.eq.${id},addressee_id.eq.${id}`),
    ),
    countWhere(client, "profiles", (q) => q.eq("invited_by", id)),
    loose(client)
      .from("profile_posts")
      .select("id, body, created_at")
      .eq("author_id", id)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);
  if (recent.error) throw new Error(`admin: user recent posts failed: ${recent.error.message}`);

  return {
    profile: {
      id: p.id,
      handle: p.handle ?? null,
      displayName: p.display_name ?? null,
      avatarUrl: p.avatar_url ?? null,
      bio: p.bio ?? null,
      createdAt: p.created_at,
      banned: p.banned_at != null,
      invitedBy: p.invited_by ?? null,
    },
    counts: { posts, follows, friends, invited },
    recentPosts: ((recent.data ?? []) as any[]).map((r) => ({
      id: r.id,
      body: r.body ?? null,
      createdAt: r.created_at,
    })),
  };
}

export interface VenueDetail {
  venue: {
    id: string;
    name: string;
    status: string;
    locality: string | null;
    createdAt: string;
    ownerId: string | null;
  };
  followerCount: number;
  owner: { id: string; handle: string | null; displayName: string | null } | null;
  recentClaims: Array<{ id: string; claimantId: string; status: string; createdAt: string }>;
}

export async function getVenueDetail(
  client: RoamClient,
  id: string,
): Promise<VenueDetail | null> {
  const { data: v, error } = await loose(client)
    .from("venues")
    .select("id, name, status, locality, created_at, owner_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`admin: venue detail failed: ${error.message}`);
  if (!v) return null;

  const [followerCount, ownerRes, claimsRes] = await Promise.all([
    countWhere(client, "follows", (q) => q.eq("venue_id", id)),
    v.owner_id
      ? loose(client)
          .from("profiles")
          .select("id, handle, display_name")
          .eq("id", v.owner_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    loose(client)
      .from("venue_claims")
      .select("id, claimant_id, status, created_at")
      .eq("venue_id", id)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);
  if (ownerRes.error) throw new Error(`admin: venue owner failed: ${ownerRes.error.message}`);
  if (claimsRes.error) throw new Error(`admin: venue claims failed: ${claimsRes.error.message}`);

  const o = ownerRes.data as any;
  return {
    venue: {
      id: v.id,
      name: v.name,
      status: v.status,
      locality: v.locality ?? null,
      createdAt: v.created_at,
      ownerId: v.owner_id ?? null,
    },
    followerCount,
    owner: o ? { id: o.id, handle: o.handle ?? null, displayName: o.display_name ?? null } : null,
    recentClaims: ((claimsRes.data ?? []) as any[]).map((r) => ({
      id: r.id,
      claimantId: r.claimant_id,
      status: r.status,
      createdAt: r.created_at,
    })),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
