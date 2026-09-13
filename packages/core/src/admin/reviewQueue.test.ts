import { describe, it, expect } from "vitest";
import type { RoamClient } from "@roam/db";
import { channelReviewQueue, confirmMatch, setMatchDismissed } from "./reviewQueue.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A chainable, thenable Supabase stand-in: every builder method returns the same proxy (so any chain
 * shape works, including methods appended after .range()), and awaiting the proxy resolves to the
 * per-table response. Writes (upsert/update/insert) are captured for assertions.
 */
function makeClient(byTable: Record<string, { data?: any; error?: any }>) {
  const captures = { upserts: [] as any[], updates: [] as any[], inserts: [] as any[] };
  function chainFor(table: string): any {
    const resp = byTable[table] ?? { data: null, error: null };
    const proxy: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const p = Promise.resolve(resp);
            return p.then.bind(p);
          }
          return (...args: any[]) => {
            if (prop === "upsert") captures.upserts.push({ table, payload: args[0] });
            if (prop === "update") captures.updates.push({ table, payload: args[0] });
            if (prop === "insert") captures.inserts.push({ table, payload: args[0] });
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  const client = { from: (t: string) => chainFor(t) } as unknown as RoamClient;
  return { client, captures };
}

const CHANNEL = { id: "ch-f2g", key: "f2g", name: "Food to Go", is_default: false, active: true };
const ACTOR = { id: "00000000-0000-0000-0000-0000000000a1", email: "staff@roam.example" };

describe("channelReviewQueue", () => {
  it("returns unbound members with candidates that clear the review floor, best score first", async () => {
    const members = [
      {
        id: "m1",
        source_name: "Mario's Pizzeria",
        source_postcode: "BT1 1AA",
        source_address: "12 High St, Belfast",
        source_council: "Belfast",
        status: "imported",
        match_dismissed_at: null,
      },
    ];
    const venues = [
      { id: "v-strong", name: "Mario's Pizzeria", address: "12 High St, BT1 1AA", slug: "marios", opening_times: null, rating: null },
      { id: "v-weak", name: "Totally Different Cafe", address: "99 Other Rd, BT1 1AA", slug: "tdc", opening_times: {}, rating: 4.1 },
    ];
    const { client } = makeClient({
      channels: { data: CHANNEL },
      channel_members: { data: members },
      venues: { data: venues },
    });

    const page = await channelReviewQueue(client, { channelKey: "f2g", limit: 25, offset: 0 });
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.memberId).toBe("m1");
    // The strong name+postcode match is shown; the weak-name one is below the review floor and dropped.
    expect(item.candidates.map((c) => c.venueId)).toContain("v-strong");
    expect(item.candidates.find((c) => c.venueId === "v-strong")!.thin).toBe(true); // no rating/hours
    expect(item.bestScore).toBeGreaterThanOrEqual(0.55);
  });

  it("computes hasMore from a limit+1 read", async () => {
    const members = Array.from({ length: 3 }, (_, i) => ({
      id: `m${i}`, source_name: `Cafe ${i}`, source_postcode: "BT1 1AA",
      source_address: null, source_council: null, status: "imported", match_dismissed_at: null,
    }));
    const { client } = makeClient({ channels: { data: CHANNEL }, channel_members: { data: members }, venues: { data: [] } });
    const page = await channelReviewQueue(client, { channelKey: "f2g", limit: 2, offset: 0 });
    expect(page.hasMore).toBe(true);
    expect(page.items).toHaveLength(2);
  });
});

describe("confirmMatch", () => {
  it("writes a manual external_ref and binds the venue (clearing any dismissal)", async () => {
    const { client, captures } = makeClient({
      channels: { data: CHANNEL },
      channel_members: { data: { id: "m1", channel_id: "ch-f2g" } },
      external_refs: { data: null }, // no clash
      admin_audit_log: { error: null },
    });
    await confirmMatch(client, ACTOR, { channelKey: "f2g", memberId: "m1", venueId: "v-strong" });

    const ref = captures.upserts.find((u) => u.table === "external_refs")!.payload;
    expect(ref).toMatchObject({ entity_type: "channel_member", entity_id: "m1", dataset: "roam_venue", external_id: "v-strong", method: "manual", matched_by: ACTOR.id });
    const bind = captures.updates.find((u) => u.table === "channel_members")!.payload;
    expect(bind).toMatchObject({ venue_id: "v-strong", match_dismissed_at: null });
    expect(captures.inserts.some((i) => i.table === "admin_audit_log")).toBe(true);
  });

  it("refuses when the venue is already matched to a different member", async () => {
    const { client } = makeClient({
      channels: { data: CHANNEL },
      channel_members: { data: { id: "m1", channel_id: "ch-f2g" } },
      external_refs: { data: { entity_id: "someone-else" } }, // clash
    });
    await expect(
      confirmMatch(client, ACTOR, { channelKey: "f2g", memberId: "m1", venueId: "v-strong" }),
    ).rejects.toThrow(/already matched to another member/);
  });
});

describe("setMatchDismissed", () => {
  it("stamps the dismissal marker and audits", async () => {
    const { client, captures } = makeClient({
      channels: { data: CHANNEL },
      channel_members: { error: null },
      admin_audit_log: { error: null },
    });
    await setMatchDismissed(client, ACTOR, { channelKey: "f2g", memberId: "m1", dismissed: true });
    const upd = captures.updates.find((u) => u.table === "channel_members")!.payload;
    expect(upd.match_dismissed_at).toBeTruthy();
    expect(upd.match_dismissed_by).toBe(ACTOR.id);
    expect(captures.inserts.some((i) => i.table === "admin_audit_log")).toBe(true);
  });

  it("clears the marker when undismissing", async () => {
    const { client, captures } = makeClient({ channels: { data: CHANNEL }, channel_members: { error: null }, admin_audit_log: { error: null } });
    await setMatchDismissed(client, ACTOR, { channelKey: "f2g", memberId: "m1", dismissed: false });
    const upd = captures.updates.find((u) => u.table === "channel_members")!.payload;
    expect(upd.match_dismissed_at).toBeNull();
    expect(upd.match_dismissed_by).toBeNull();
  });
});
