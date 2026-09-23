import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RoamClient } from "@roam/db";
import { runHubspotSync } from "./syncHubspotMembers.js";
import type { HubspotConfig } from "../hubspot/client.js";
import { hubspot } from "@roam/core";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CFG: HubspotConfig = {
  baseUrl: "https://api.hubapi.test",
  token: "pat-test",
  channelKey: "f2g",
  propertyMap: hubspot.DEFAULT_PROPERTY_MAP,
  pageSize: 100,
  maxPages: 10,
};

const F2G = { id: "chan-f2g", key: "f2g", name: "Food to Go", is_default: false, theme: {}, membership_mode: "open", nav: [], sections: {}, surface: "storefront" };

/**
 * Chainable Supabase stand-in. channel_members reads are answered by which qualifier was used:
 *   eq(source_system) → the existing-hubspot-members scan
 *   not(venue_id)     → the bound-venue pre-load of the shared match phase
 */
function makeClient(cfg: { channel: any; existing: any[]; bound?: any[]; venues?: any[] }) {
  const captures = { inserts: [] as any[], updates: [] as any[], upserts: [] as any[] };
  const client: any = {
    from(table: string) {
      const st: any = { op: "select", payload: null, filters: {} as Record<string, any>, markers: new Set<string>() };
      const run = () => {
        if (st.op === "insert") { captures.inserts.push({ table, payload: st.payload }); return Promise.resolve({ data: null, error: null }); }
        if (st.op === "update") { captures.updates.push({ table, payload: st.payload, filters: st.filters }); return Promise.resolve({ data: null, error: null }); }
        if (st.op === "upsert") { captures.upserts.push({ table, payload: st.payload }); return Promise.resolve({ data: null, error: null }); }
        if (table === "channels") return Promise.resolve({ data: cfg.channel, error: null });
        if (table === "channel_members") {
          if (st.markers.has("not")) return Promise.resolve({ data: cfg.bound ?? [], error: null });
          return Promise.resolve({ data: cfg.existing, error: null });
        }
        if (table === "venues") return Promise.resolve({ data: cfg.venues ?? [], error: null });
        if (table === "external_refs") return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: null, error: null });
      };
      const b: any = {
        select: () => b,
        insert: (v: any) => { st.op = "insert"; st.payload = v; return b; },
        update: (v: any) => { st.op = "update"; st.payload = v; return b; },
        upsert: (v: any) => { st.op = "upsert"; st.payload = v; return b; },
        eq: (c: string, v: any) => { st.filters[c] = v; return b; },
        in: () => b,
        range: () => b,
        ilike: () => b,
        limit: () => b,
        not: () => { st.markers.add("not"); return b; },
        maybeSingle: () => run(),
        then: (res: any, rej: any) => run().then(res, rej),
      };
      return b;
    },
  };
  return { client: client as unknown as RoamClient, captures };
}

/** Stub the HubSpot REST surface: one page of companies, associations, and contact records. */
function stubHubspot(companies: any[], assoc: any[] = [], contacts: any[] = []): typeof globalThis.fetch {
  return vi.fn(async (url: any) => {
    const u = String(url);
    const ok = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as any;
    if (u.includes("/crm/v3/objects/companies")) return ok({ results: companies });
    if (u.includes("/crm/v4/associations/companies/contacts/batch/read")) return ok({ results: assoc });
    if (u.includes("/crm/v3/objects/contacts/batch/read")) return ok({ results: contacts });
    throw new Error(`unexpected fetch: ${u}`);
  });
}

const originalFetch = globalThis.fetch;
beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { globalThis.fetch = originalFetch; });

describe("runHubspotSync", () => {
  it("is dormant with no config — it must deploy safely long before a token exists", async () => {
    const { client, captures } = makeClient({ channel: F2G, existing: [] });
    const r = await runHubspotSync(client, null);
    expect(r.status).toBe("unconfigured");
    expect(captures.inserts).toEqual([]);
  });

  it("inserts a new member keyed on the company id, with the contact's e-mail", async () => {
    globalThis.fetch = stubHubspot(
      [{ id: "8001", properties: { name: "Harbour Grill", address: "22 Parade", city: "Donaghadee", zip: "BT21 0HE" } }],
      [{ from: { id: "8001" }, to: [{ toObjectId: "c1" }] }],
      [{ id: "c1", properties: { email: "owner@harbour.example", firstname: "Ada", createdate: "2020-01-01T00:00:00Z" } }],
    );
    const { client, captures } = makeClient({ channel: F2G, existing: [] });

    const r = await runHubspotSync(client, CFG);

    expect(r.status).toBe("ok");
    expect(r.inserted).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.withEmail).toBe(1);

    const insert = captures.inserts.find((i) => i.table === "channel_members")!;
    expect(insert.payload[0]).toMatchObject({
      channel_id: "chan-f2g",
      source_system: "hubspot",
      source_system_id: "8001",
      membership_ref: "HS:8001",
      source_name: "Harbour Grill",
      source_postcode: "BT21 0HE",
      source_email: "owner@harbour.example",
    });
  });

  it("updates an existing member in place — a re-sync can never duplicate one", async () => {
    globalThis.fetch = stubHubspot(
      // The Association has since corrected the name AND the postcode.
      [{ id: "8001", properties: { name: "Harbour Grill Ltd", address: "22 The Parade", city: "Donaghadee", zip: "BT21 0HF" } }],
    );
    const { client, captures } = makeClient({
      channel: F2G,
      existing: [{ id: "m1", source_system_id: "8001" }],
    });

    const r = await runHubspotSync(client, CFG);

    expect(r.inserted).toBe(0);
    expect(r.updated).toBe(1);
    expect(captures.inserts.find((i) => i.table === "channel_members")).toBeUndefined();
    const update = captures.updates.find((u) => u.table === "channel_members" && u.payload.source_name)!;
    expect(update.filters).toMatchObject({ id: "m1" });
    expect(update.payload).toMatchObject({ source_name: "Harbour Grill Ltd", source_postcode: "BT21 0HF" });
  });

  it("never writes onboarding state — status, venue_id and claimed_by are Roam's, not the CRM's", async () => {
    globalThis.fetch = stubHubspot([{ id: "8001", properties: { name: "Harbour Grill", zip: "BT21 0HE" } }]);
    const { client, captures } = makeClient({ channel: F2G, existing: [{ id: "m1", source_system_id: "8001" }] });

    await runHubspotSync(client, CFG);

    // A sync must never roll a live member backwards or re-point their venue.
    const memberWrites = [
      ...captures.updates.filter((u) => u.table === "channel_members" && u.payload.source_name),
      ...captures.inserts.filter((i) => i.table === "channel_members"),
    ];
    for (const w of memberWrites) {
      const payload = Array.isArray(w.payload) ? w.payload : [w.payload];
      for (const p of payload) {
        expect(p).not.toHaveProperty("status");
        expect(p).not.toHaveProperty("venue_id");
        expect(p).not.toHaveProperty("claimed_by");
        expect(p).not.toHaveProperty("source_council"); // council is derived from FSA (0154)
      }
    }
  });

  it("treats an empty pull as no change — an outage must not look like an empty roster", async () => {
    globalThis.fetch = stubHubspot([]);
    const { client, captures } = makeClient({ channel: F2G, existing: [{ id: "m1", source_system_id: "8001" }] });

    const r = await runHubspotSync(client, CFG);

    expect(r.status).toBe("ok");
    expect(r.fetched).toBe(0);
    expect(captures.inserts).toEqual([]);
    expect(captures.updates).toEqual([]);
  });

  it("counts a member with no contact as un-invitable rather than failing", async () => {
    globalThis.fetch = stubHubspot([{ id: "8002", properties: { name: "Quiet Cafe", zip: "BT1 1AA" } }]);
    const { client } = makeClient({ channel: F2G, existing: [] });

    const r = await runHubspotSync(client, CFG);

    expect(r.withEmail).toBe(0);
    expect(r.withoutEmail).toBe(1); // the ceiling on self-serve onboarding, reported every run
  });

  it("reports how often the contact tie-break had to choose — the open question, measured", async () => {
    globalThis.fetch = stubHubspot(
      [{ id: "8001", properties: { name: "Harbour Grill", zip: "BT21 0HE" } }],
      [{ from: { id: "8001" }, to: [{ toObjectId: "c1" }, { toObjectId: "c2" }] }],
      [
        { id: "c1", properties: { email: "new@x.example", createdate: "2026-01-01T00:00:00Z" } },
        { id: "c2", properties: { email: "old@x.example", createdate: "2019-01-01T00:00:00Z" } },
      ],
    );
    const { client, captures } = makeClient({ channel: F2G, existing: [] });

    const r = await runHubspotSync(client, CFG);

    expect(r.ambiguousContacts).toBe(1);
    const insert = captures.inserts.find((i) => i.table === "channel_members")!;
    expect(insert.payload[0].source_email).toBe("old@x.example"); // oldest wins, deterministically
  });

  it("a dry run reports what would happen and writes nothing at all", async () => {
    globalThis.fetch = stubHubspot([{ id: "8003", properties: { name: "Rehearsal Cafe", zip: "BT1 1AA" } }]);
    const { client, captures } = makeClient({ channel: F2G, existing: [] });

    const r = await runHubspotSync(client, CFG, { dryRun: true });

    expect(r.dryRun).toBe(true);
    expect(r.inserted).toBe(1); // ...as it WOULD be
    expect(captures.inserts).toEqual([]);
    expect(captures.updates).toEqual([]);
    expect(captures.upserts).toEqual([]);
  });

  it("refuses a channel that does not exist rather than writing a roster nowhere", async () => {
    globalThis.fetch = stubHubspot([{ id: "8001", properties: { name: "X", zip: "BT1 1AA" } }]);
    const { client } = makeClient({ channel: null, existing: [] });
    await expect(runHubspotSync(client, CFG)).rejects.toThrow(/unknown channel/);
  });
});
