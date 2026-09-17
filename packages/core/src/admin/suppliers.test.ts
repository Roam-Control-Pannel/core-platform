import { describe, it, expect } from "vitest";
import type { RoamClient } from "@roam/db";
import { moderateSupplier, pendingSuppliers } from "./suppliers.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeClient(byTable: Record<string, { data?: any; error?: any; count?: number }>) {
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

const ACTOR = { id: "00000000-0000-0000-0000-0000000000a1", email: "staff@roam.example" };

describe("pendingSuppliers", () => {
  it("maps rows to the review shape with the owner's handle and the exact pending count", async () => {
    const { client } = makeClient({
      orgs: {
        data: [{ id: "o1", name: "Ards Bakery Supplies", slug: "ards-bakery-supplies", description: null, category: "supplier", website: "https://x.example", locality: "Newtownards", logo_url: null, status: "draft", moderation: "pending", owner_id: "u1", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", profiles: { handle: "ards" } }],
        count: 7,
      },
    });
    const out = await pendingSuppliers(client, 50);
    expect(out.pendingCount).toBe(7);
    expect(out.items).toEqual([expect.objectContaining({ id: "o1", name: "Ards Bakery Supplies", ownerHandle: "ards", status: "draft", moderation: "pending", website: "https://x.example" })]);
  });
});

describe("moderateSupplier", () => {
  it("approve sets moderation approved AND status live (the public gate needs both), audited", async () => {
    const { client, captures } = makeClient({ orgs: { data: { id: "o1", status: "draft", moderation: "pending" } } });
    const r = await moderateSupplier(client, ACTOR, { orgId: "o1", decision: "approved" });
    expect(r).toEqual({ orgId: "o1", decision: "approved", status: "live" });
    expect(captures.updates).toEqual([{ table: "orgs", payload: { moderation: "approved", status: "live" } }]);
    const audit = captures.inserts.find((i) => i.table === "admin_audit_log")?.payload;
    expect(audit).toMatchObject({ action: "moderate_supplier", entity_type: "org", entity_id: "o1", actor_id: ACTOR.id });
    expect(audit.detail).toMatchObject({ decision: "approved", from: { status: "draft", moderation: "pending" } });
  });

  it("reject only marks moderation rejected — the owner keeps their draft to fix and resubmit", async () => {
    const { client, captures } = makeClient({ orgs: { data: { id: "o1", status: "draft", moderation: "pending" } } });
    const r = await moderateSupplier(client, ACTOR, { orgId: "o1", decision: "rejected", note: "no website" });
    expect(r.status).toBe("draft");
    expect(captures.updates).toEqual([{ table: "orgs", payload: { moderation: "rejected" } }]);
    expect(captures.inserts[0]?.payload.detail).toMatchObject({ note: "no website" });
  });

  it("refuses a missing or removed supplier without writing", async () => {
    const missing = makeClient({ orgs: { data: null } });
    await expect(moderateSupplier(missing.client, ACTOR, { orgId: "nope", decision: "approved" })).rejects.toThrow(/not found/);
    const removed = makeClient({ orgs: { data: { id: "o1", status: "removed", moderation: "pending" } } });
    await expect(moderateSupplier(removed.client, ACTOR, { orgId: "o1", decision: "approved" })).rejects.toThrow(/removed/);
    expect(missing.captures.updates).toHaveLength(0);
    expect(removed.captures.updates).toHaveLength(0);
  });
});
