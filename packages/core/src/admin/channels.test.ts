import { describe, it, expect } from "vitest";
import type { RoamClient } from "@roam/db";
import {
  channelRoster,
  revealMemberEmail,
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
  /** What a `channel_members` maybeSingle() resolves to (revealMemberEmail reads one row). */
  memberSingle?: any | null;
  audit: any[];
  writes: any[];
}): RoamClient {
  const client: any = {
    from(table: string) {
      const state: any = { op: "select", payload: null, filters: {} };
      let single = false;
      const runRead = () =>
        Promise.resolve({
          data:
            table === "channels"
              ? (opts.channel ?? null)
              : table === "channel_members"
                ? (single && "memberSingle" in opts ? opts.memberSingle : (opts.memberRows ?? []))
                : [],
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
        maybeSingle: () => ((single = true), runRead()),
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
      id: "m1", sourceName: "Cafe A", sourceCouncil: "Belfast",
      // 2.5: the address is masked in the mapper, not the UI — so it never crosses the wire.
      sourceEmailMasked: "a\u2022\u2022\u2022@x\u2022\u2022\u2022.com", hasEmail: true,
      status: "live", membershipRef: "R1", venueId: "v1", venue: { name: "Cafe A", slug: "cafe-a" }, createdAt: "2026-01-02",
    });

    // The mapped row must not carry the real address under ANY key — the whole point of 2.5.
    expect(JSON.stringify(page.rows)).not.toContain("a@x.com");
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

describe("revealMemberEmail (2.5 — PII reads are audited)", () => {
  const MEMBER = "00000000-0000-0000-0000-0000000000m1";

  it("returns the real address AND records who looked", async () => {
    const audit: any[] = [];
    const r = await revealMemberEmail(
      makeClient({ channel: F2G_ROW, memberSingle: { id: MEMBER, source_email: "info@cafe.co.uk" }, audit, writes: [] }),
      ACTOR,
      { channelKey: "f2g", memberId: MEMBER },
    );
    expect(r.email).toBe("info@cafe.co.uk");
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("reveal_member_email");
    expect(audit[0].entity_type).toBe("channel_member");
    expect(audit[0].entity_id).toBe(MEMBER);
  });

  it("does NOT copy the address into the audit row", async () => {
    // The log is append-only and long-lived; quoting what it protects would make it a second,
    // permanent copy of the very thing being guarded.
    const audit: any[] = [];
    await revealMemberEmail(
      makeClient({ channel: F2G_ROW, memberSingle: { id: MEMBER, source_email: "info@cafe.co.uk" }, audit, writes: [] }),
      ACTOR,
      { channelKey: "f2g", memberId: MEMBER },
    );
    expect(JSON.stringify(audit)).not.toContain("info@cafe.co.uk");
    expect(audit[0].detail).toEqual({ channel: "f2g" });
  });

  it("returns null and audits NOTHING when the roster holds no address", async () => {
    // There was no personal data to read, so there is nothing to account for. Logging it would
    // bury the reads that matter under ones that did not happen.
    const audit: any[] = [];
    const r = await revealMemberEmail(
      makeClient({ channel: F2G_ROW, memberSingle: { id: MEMBER, source_email: null }, audit, writes: [] }),
      ACTOR,
      { channelKey: "f2g", memberId: MEMBER },
    );
    expect(r.email).toBeNull();
    expect(audit).toHaveLength(0);
  });

  it("refuses a member that is not on this channel, and an unknown channel", async () => {
    await expect(
      revealMemberEmail(makeClient({ channel: F2G_ROW, memberSingle: null, audit: [], writes: [] }), ACTOR, {
        channelKey: "f2g",
        memberId: MEMBER,
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      revealMemberEmail(makeClient({ channel: null, audit: [], writes: [] }), ACTOR, {
        channelKey: "nope",
        memberId: MEMBER,
      }),
    ).rejects.toThrow(/unknown channel/);
  });
});
