import { describe, it, expect } from "vitest";
import type { RoamClient } from "@roam/db";
import { getActivityFeed } from "./activity.js";
import { getSignupTrend } from "./metrics.js";

/**
 * A minimal chainable stand-in for the Supabase query builder — enough for the admin
 * reads under test. `from(table)` yields the table's canned rows; `.in()` (used only by
 * the actor lookup) swaps in the actors set; `.maybeSingle()` returns the first row.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function makeClient(config: {
  recent: Record<string, any[]>;
  actors?: any[];
}): RoamClient {
  return {
    from(table: string) {
      const q: any = {
        _rows: config.recent[table] ?? [],
        _single: false,
        select: () => q,
        order: () => q,
        limit: () => q,
        gte: () => q,
        eq: () => q,
        or: () => q,
        not: () => q,
        ilike: () => q,
        maybeSingle: () => ((q._single = true), q),
        in: () => ((q._rows = config.actors ?? []), q),
        then: (resolve: (v: any) => unknown) =>
          Promise.resolve({
            data: q._single ? q._rows[0] ?? null : q._rows,
            error: null,
          }).then(resolve),
      };
      return q;
    },
  } as unknown as RoamClient;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("getSignupTrend", () => {
  it("returns one zero-filled point per day, newest last", async () => {
    const client = makeClient({ recent: { profiles: [] } });
    const trend = await getSignupTrend(client, 7);
    expect(trend).toHaveLength(7);
    expect(trend.every((p) => p.count === 0)).toBe(true);
    // Ascending calendar order.
    const dates = trend.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("buckets signups onto their UTC day", async () => {
    const today = new Date().toISOString();
    const client = makeClient({
      recent: { profiles: [{ created_at: today }, { created_at: today }] },
    });
    const trend = await getSignupTrend(client, 30);
    expect(trend).toHaveLength(30);
    expect(trend.reduce((s, p) => s + p.count, 0)).toBe(2);
    expect(trend[trend.length - 1]!.count).toBe(2); // both land on today (last bucket)
  });
});

describe("getActivityFeed", () => {
  it("merges sources newest-first and resolves actors", async () => {
    const older = "2026-08-01T10:00:00.000Z";
    const newer = "2026-08-02T10:00:00.000Z";
    const client = makeClient({
      recent: {
        profiles: [{ id: "u1", handle: "ann", display_name: "Ann", created_at: older }],
        profile_posts: [{ id: "p1", author_id: "u2", created_at: newer }],
        town_hall_topics: [],
        town_hall_replies: [],
        follows: [],
        events: [],
        venue_claims: [],
      },
      actors: [
        { id: "u1", handle: "ann", display_name: "Ann", avatar_url: null },
        { id: "u2", handle: "bob", display_name: "Bob", avatar_url: null },
      ],
    });

    const feed = await getActivityFeed(client, 40);
    expect(feed).toHaveLength(2);
    // Newest (the post) first.
    expect(feed[0]!.kind).toBe("post");
    expect(feed[0]!.actor?.handle).toBe("bob");
    expect(feed[1]!.kind).toBe("signup");
    expect(feed[1]!.actor?.handle).toBe("ann");
  });

  it("caps output at the requested limit", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      author_id: "u1",
      created_at: `2026-08-0${i + 1}T00:00:00.000Z`,
    }));
    const client = makeClient({
      recent: {
        profiles: [],
        profile_posts: rows,
        town_hall_topics: [],
        town_hall_replies: [],
        follows: [],
        events: [],
        venue_claims: [],
      },
      actors: [{ id: "u1", handle: "u1", display_name: null, avatar_url: null }],
    });
    const feed = await getActivityFeed(client, 3);
    expect(feed).toHaveLength(3);
    // Newest three (p4, p3, p2).
    expect(feed.map((f) => f.id)).toEqual(["post:p4", "post:p3", "post:p2"]);
  });
});
