import { describe, it, expect } from "vitest";
import type { RoamClient } from "@roam/db";
import { setMemberStatus, STAFF_SETTABLE_STATUSES } from "./memberStatus.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Chainable, thenable Supabase stand-in (same shape as reviewQueue.test). Captures writes. */
function makeClient(byTable: Record<string, { data?: any; error?: any }>) {
  const captures = { updates: [] as any[], inserts: [] as any[] };
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
const member = (over: Record<string, unknown>) => ({ id: "m1", status: "claimed", venue_id: "v1", source_name: "Cafe", ...over });

describe("setMemberStatus", () => {
  it("moves a matched, claimed member to live and audits from → to", async () => {
    const { client, captures } = makeClient({ channels: { data: CHANNEL }, channel_members: { data: member({}) } });
    const r = await setMemberStatus(client, ACTOR, { channelKey: "f2g", memberId: "m1", status: "live" });
    expect(r).toEqual({ memberId: "m1", from: "claimed", to: "live" });
    expect(captures.updates).toEqual([{ table: "channel_members", payload: { status: "live" } }]);
    const audit = captures.inserts.find((i) => i.table === "admin_audit_log")?.payload;
    expect(audit).toMatchObject({ action: "set_member_status", entity_type: "channel_member", entity_id: "m1", actor_id: ACTOR.id });
    expect(audit.detail).toMatchObject({ channel: "f2g", from: "claimed", to: "live" });
  });

  it("lets an imported or invited member go live directly (activation) — but never an unmatched one", async () => {
    for (const status of ["imported", "invited"]) {
      const { client } = makeClient({ channels: { data: CHANNEL }, channel_members: { data: member({ status }) } });
      await expect(setMemberStatus(client, ACTOR, { channelKey: "f2g", memberId: "m1", status: "live" })).resolves.toMatchObject({ from: status, to: "live" });
    }
    const { client, captures } = makeClient({ channels: { data: CHANNEL }, channel_members: { data: member({ venue_id: null }) } });
    await expect(setMemberStatus(client, ACTOR, { channelKey: "f2g", memberId: "m1", status: "live" })).rejects.toThrow(/matched to a venue/);
    expect(captures.updates).toHaveLength(0);
    expect(captures.inserts).toHaveLength(0);
  });

  it("stamps lapsed_at when lapsing a live member", async () => {
    const { client, captures } = makeClient({ channels: { data: CHANNEL }, channel_members: { data: member({ status: "live" }) } });
    await setMemberStatus(client, ACTOR, { channelKey: "f2g", memberId: "m1", status: "lapsed", note: "left the Association" });
    expect(captures.updates[0]?.payload).toMatchObject({ status: "lapsed" });
    expect(typeof captures.updates[0]?.payload.lapsed_at).toBe("string");
    expect(captures.inserts[0]?.payload.detail).toMatchObject({ note: "left the Association" });
  });

  it("refuses transitions the state machine forbids, and a removed member never comes back", async () => {
    const { client, captures } = makeClient({ channels: { data: CHANNEL }, channel_members: { data: member({ status: "claimed" }) } });
    await expect(setMemberStatus(client, ACTOR, { channelKey: "f2g", memberId: "m1", status: "lapsed" })).rejects.toThrow(/cannot move from 'claimed' to 'lapsed'/);
    const gone = makeClient({ channels: { data: CHANNEL }, channel_members: { data: member({ status: "removed" }) } });
    for (const status of STAFF_SETTABLE_STATUSES) {
      await expect(setMemberStatus(gone.client, ACTOR, { channelKey: "f2g", memberId: "m1", status })).rejects.toThrow(/cannot move/);
    }
    expect(captures.updates).toHaveLength(0);
  });

  it("refuses an unknown channel or a member outside it, without writing", async () => {
    const noChannel = makeClient({ channels: { data: null } });
    await expect(setMemberStatus(noChannel.client, ACTOR, { channelKey: "nope", memberId: "m1", status: "live" })).rejects.toThrow(/unknown channel/);
    const noMember = makeClient({ channels: { data: CHANNEL }, channel_members: { data: null } });
    await expect(setMemberStatus(noMember.client, ACTOR, { channelKey: "f2g", memberId: "m1", status: "live" })).rejects.toThrow(/not found/);
    expect(noMember.captures.updates).toHaveLength(0);
  });
});
