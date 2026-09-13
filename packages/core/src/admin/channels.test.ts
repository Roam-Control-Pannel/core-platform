import { describe, it, expect } from "vitest";
import type { RoamClient } from "@roam/db";
import {
  channelRoster,
  channelOnboardingStats,
  setChannelConfig,
  addChannelDomain,
  removeChannelDomain,
} from "./channels.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A chainable Supabase stand-in that CAPTURES writes and returns canned reads. `channel` is what a
 * `channels` maybeSingle (getChannelByKey) resolves to; `memberRows` what a `channel_members` select
 * returns; every insert/update/delete is pushed to `writes`, and admin_audit_log inserts to `audit`.
 */
function makeClient(opts: {
  channel?: any | null;
  memberRows?: any[];
  audit: any[];
  writes: any[];
}): RoamClient {
  const client: any = {
    from(table: string) {
      const state: any = { op: "select", payload: null, filters: {} };
      const runRead = () =>
        Promise.resolve({
          data: table === "channels" ? (opts.channel ?? null) : table === "channel_members" ? (opts.memberRows ?? []) : [],
          error: null,
        });
      const settle = () => {
        if (state.op === "insert") {
          if (table === "admin_audit_log") opts.audit.push(state.payload);
          else opts.writes.push({ table, op: "insert", payload: state.payload });
          return Promise.resolve({ data: null, error: null });
        }
        if (state.op === "update") {
          opts.writes.push({ table, op: "update", payload: state.payload, filters: state.filters });
          return Promise.resolve({ data: null, error: null });
        }
        if (state.op === "delete") {
          opts.writes.push({ table, op: "delete", filters: state.filters });
          return Promise.resolve({ data: null, error: null });
        }
        return runRead();
      };
      const q: any = {
        select: () => q,
        insert: (v: any) => ((state.op = "insert"), (state.payload = v), q),
        update: (v: any) => ((state.op = "update"), (state.payload = v), q),
        delete: () => ((state.op = "delete"), q),
        eq: (c: string, v: any) => ((state.filters[c] = v), q),
        order: () => q,
        ilike: () => q,
        range: () => q,
        maybeSingle: () => runRead(),
        then: (res: any, rej: any) => settle().then(res, rej),
      };
      return q;
    },
  };
  return client as unknown as RoamClient;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const F2G_ROW = {
  id: "chan-f2g",
  key: "f2g",
  name: "Food to Go",
  is_default: false,
  theme: {},
  membership_mode: "open",
  nav: [],
  sections: { storefront: true },
  surface: "storefront",
};
const ACTOR = { id: "staff-1", email: "staff@roam-everywhere.com" };

describe("setChannelConfig", () => {
  it("validates every field through the core parsers and audits the change", async () => {
    const audit: any[] = [];
    const writes: any[] = [];
    await setChannelConfig(makeClient({ channel: F2G_ROW, audit, writes }), ACTOR, "f2g", {
      theme: { brand: "#E8562A", bogus: "not-a-colour" } as any,
      surface: "banana" as any, // invalid → coerced to 'roam'
      membershipMode: "members",
      nav: [{ key: "a", href: "/a", labelKey: "x" }, { key: 1 } as any], // 2nd dropped
      sections: { storefront: true, junk: "yes" as any }, // non-bool dropped
    });
    const upd = writes.find((w) => w.table === "channels" && w.op === "update")!.payload;
    expect(upd.theme).toEqual({ brand: "#E8562A" }); // bad colour dropped
    expect(upd.surface).toBe("roam"); // invalid coerced
    expect(upd.membership_mode).toBe("members");
    expect(upd.nav).toEqual([{ key: "a", href: "/a", labelKey: "x" }]);
    expect(upd.sections).toEqual({ storefront: true });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("set_channel_config");
    expect(audit[0].entity_id).toBe("chan-f2g");
    expect(audit[0].actor_id).toBe("staff-1");
  });

  it("only writes the keys supplied (partial patch)", async () => {
    const audit: any[] = [];
    const writes: any[] = [];
    await setChannelConfig(makeClient({ channel: F2G_ROW, audit, writes }), ACTOR, "f2g", { membershipMode: "open" });
    const upd = writes[0].payload;
    expect(Object.keys(upd)).toEqual(["membership_mode"]);
  });

  it("throws on an empty patch and on an unknown channel", async () => {
    await expect(setChannelConfig(makeClient({ channel: F2G_ROW, audit: [], writes: [] }), ACTOR, "f2g", {})).rejects.toThrow(/no channel-config changes/);
    await expect(setChannelConfig(makeClient({ channel: null, audit: [], writes: [] }), ACTOR, "nope", { surface: "roam" })).rejects.toThrow(/unknown channel/);
  });
});

describe("channel domains", () => {
  it("adds a normalised host and audits it", async () => {
    const audit: any[] = [];
    const writes: any[] = [];
    await addChannelDomain(makeClient({ channel: F2G_ROW, audit, writes }), ACTOR, "f2g", "  HTTPS://NIFoodToGo.com:443/x  ");
    const ins = writes.find((w) => w.table === "channel_domains" && w.op === "insert")!.payload;
    expect(ins).toEqual({ host: "nifoodtogo.com", channel_id: "chan-f2g" });
    expect(audit[0].action).toBe("add_channel_domain");
    expect(audit[0].detail.host).toBe("nifoodtogo.com");
  });

  it("rejects an empty host", async () => {
    await expect(addChannelDomain(makeClient({ channel: F2G_ROW, audit: [], writes: [] }), ACTOR, "f2g", "   ")).rejects.toThrow(/valid hostname/);
  });

  it("removes a host and audits it", async () => {
    const audit: any[] = [];
    const writes: any[] = [];
    await removeChannelDomain(makeClient({ channel: F2G_ROW, audit, writes }), ACTOR, "f2g", "nifoodtogo.com");
    const del = writes.find((w) => w.table === "channel_domains" && w.op === "delete")!;
    expect(del.filters).toEqual({ host: "nifoodtogo.com", channel_id: "chan-f2g" });
    expect(audit[0].action).toBe("remove_channel_domain");
  });
});

describe("channelRoster", () => {
  it("maps rows, resolves the venue embed (object or array), and flags hasMore via the +1", async () => {
    const rows = [
      { id: "m1", source_name: "Cafe A", source_council: "Belfast", source_email: "a@x.com", status: "live", membership_ref: "R1", created_at: "2026-01-02", venue_id: "v1", venue: { name: "Cafe A", slug: "cafe-a" } },
      { id: "m2", source_name: "Cafe B", source_council: null, source_email: null, status: "imported", membership_ref: "R2", created_at: "2026-01-01", venue_id: "v2", venue: [{ name: "Cafe B", slug: "cafe-b" }] },
      { id: "m3", source_name: "Cafe C", source_council: "Derry", source_email: null, status: "invited", membership_ref: "R3", created_at: "2025-12-31", venue_id: null, venue: null },
    ];
    const page = await channelRoster(makeClient({ channel: F2G_ROW, memberRows: rows, audit: [], writes: [] }), {
      channelKey: "f2g",
      limit: 2,
      offset: 0,
    });
    expect(page.hasMore).toBe(true); // 3 rows returned for limit 2
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).toEqual({
      id: "m1", sourceName: "Cafe A", sourceCouncil: "Belfast", sourceEmail: "a@x.com",
      status: "live", membershipRef: "R1", venueId: "v1", venue: { name: "Cafe A", slug: "cafe-a" }, createdAt: "2026-01-02",
    });
    expect(page.rows[1]!.venue).toEqual({ name: "Cafe B", slug: "cafe-b" }); // array embed flattened
    expect(page.nextOffset).toBe(2);
  });
});

describe("channelOnboardingStats", () => {
  it("tallies exact counts by status and by council (— for null)", async () => {
    const rows = [
      { status: "live", source_council: "Belfast" },
      { status: "live", source_council: "Belfast" },
      { status: "invited", source_council: "Derry" },
      { status: "imported", source_council: null },
    ];
    const stats = await channelOnboardingStats(makeClient({ channel: F2G_ROW, memberRows: rows, audit: [], writes: [] }), "f2g");
    expect(stats.total).toBe(4);
    expect(stats.byStatus).toEqual({ live: 2, invited: 1, imported: 1 });
    expect(stats.byCouncil).toEqual({ Belfast: 2, Derry: 1, "—": 1 });
  });
});
