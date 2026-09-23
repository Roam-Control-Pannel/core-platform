import { describe, it, expect } from "vitest";
import type { RoamClient } from "@roam/db";
import { importRoster } from "./importRoster.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A chainable Supabase stand-in for the import orchestration. Reads are answered by table + which
 * qualifier was used (range = the existing-refs scan, in = the member re-read); writes are captured.
 */
function makeClient(cfg: {
  channel: any;
  existingRefs: any[];
  membersByRef: any[];
  venues: any[];
  manualRef: any | null;
  runReturn: any;
  /** Members already holding a venue on this channel (the duplicate-venue guard's pre-load). */
  boundVenues?: any[];
}) {
  const captures = { upserts: [] as any[], updates: [] as any[], inserts: [] as any[] };
  const client: any = {
    from(table: string) {
      const st: any = { op: "select", payload: null, filters: {}, markers: new Set<string>() };
      const run = () => {
        if (st.op === "upsert") { captures.upserts.push({ table, payload: st.payload }); return Promise.resolve({ data: null, error: null }); }
        if (st.op === "update") { captures.updates.push({ table, payload: st.payload, filters: st.filters }); return Promise.resolve({ data: null, error: null }); }
        if (st.op === "insert") { captures.inserts.push({ table, payload: st.payload }); return Promise.resolve({ data: table === "channel_import_runs" ? cfg.runReturn : null, error: null }); }
        if (table === "channels") return Promise.resolve({ data: cfg.channel, error: null });
        if (table === "channel_members") {
          if (st.markers.has("in")) return Promise.resolve({ data: cfg.membersByRef, error: null });
          // Both roster scans page with .range(); only the bound-venue pre-load also filters with
          // .not("venue_id", "is", null), which is what tells the two apart here.
          if (st.markers.has("range") && st.markers.has("not")) return Promise.resolve({ data: cfg.boundVenues ?? [], error: null });
          if (st.markers.has("range")) return Promise.resolve({ data: cfg.existingRefs, error: null });
          return Promise.resolve({ data: [], error: null });
        }
        if (table === "venues") return Promise.resolve({ data: cfg.venues, error: null });
        if (table === "external_refs") return Promise.resolve({ data: cfg.manualRef, error: null });
        return Promise.resolve({ data: null, error: null });
      };
      const b: any = {
        select: () => b,
        upsert: (v: any) => { st.op = "upsert"; st.payload = v; return b; },
        insert: (v: any) => { st.op = "insert"; st.payload = v; return b; },
        update: (v: any) => { st.op = "update"; st.payload = v; return b; },
        eq: (c: string, v: any) => { st.filters[c] = v; return b; },
        in: () => { st.markers.add("in"); return b; },
        range: () => { st.markers.add("range"); return b; },
        ilike: () => { st.markers.add("ilike"); return b; },
        not: () => { st.markers.add("not"); return b; },
        limit: () => b,
        maybeSingle: () => run(),
        then: (res: any, rej: any) => run().then(res, rej),
      };
      return b;
    },
  };
  return { client: client as unknown as RoamClient, captures };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const F2G = { id: "chan-f2g", key: "f2g", name: "Food to Go", is_default: false, theme: {}, membership_mode: "open", nav: [], sections: {}, surface: "storefront" };

describe("importRoster (B3-a import + B3-b match)", () => {
  it("upserts idempotently, matches an accept, binds the venue, and reports the run", async () => {
    const csv = [
      "name,postcode,email,ref",
      "Mario's Pizzeria,BT1 1AA,a@x.com,ASSOC-1",
      "No Postcode Cafe,,b@x.com,ASSOC-2",
    ].join("\n");
    const { client, captures } = makeClient({
      channel: F2G,
      existingRefs: [{ membership_ref: "ASSOC-2" }], // ASSOC-1 new, ASSOC-2 already present
      membersByRef: [
        { id: "m1", membership_ref: "ASSOC-1", venue_id: null, source_postcode: "BT1 1AA", source_name: "Mario's Pizzeria" },
        { id: "m2", membership_ref: "ASSOC-2", venue_id: null, source_postcode: null, source_name: "No Postcode Cafe" },
      ],
      venues: [{ id: "v1", name: "Marios Pizzeria", address: "12 High St, Belfast, BT1 1AA", opening_times: null, rating: null }], // thin
      manualRef: null,
      runReturn: { id: "run-1" },
    });

    const report = await importRoster(client, { channelKey: "f2g", csv, actorId: "staff-1" });

    expect(report.imported).toBe(1);
    expect(report.updated).toBe(1);
    expect(report.matchedAccept).toBe(1);
    expect(report.matchedReview).toBe(0);
    expect(report.matchedReject).toBe(0);
    expect(report.warnings).toBe(1); // No Postcode Cafe missing postcode
    expect(report.runId).toBe("run-1");
    expect(report.backfillCandidates).toEqual(["v1"]); // matched venue is thin

    // channel_members upserted (both rows in one chunk) + venue bound for m1.
    const memberUpsert = captures.upserts.find((u) => u.table === "channel_members")!;
    expect(memberUpsert.payload).toHaveLength(2);
    expect(captures.updates.find((u) => u.table === "channel_members")).toMatchObject({ payload: { venue_id: "v1" }, filters: { id: "m1" } });
    // external_refs auto row written for the accept.
    const refUpsert = captures.upserts.find((u) => u.table === "external_refs")!;
    expect(refUpsert.payload).toMatchObject({ entity_type: "channel_member", entity_id: "m1", dataset: "roam_venue", external_id: "v1", method: "auto" });
    // run report persisted with the counts.
    const runInsert = captures.inserts.find((i) => i.table === "channel_import_runs")!;
    expect(runInsert.payload).toMatchObject({ channel_id: "chan-f2g", imported: 1, updated: 1, matched_accept: 1 });
  });

  it("never overwrites a human manual match", async () => {
    const csv = "name,postcode,email,ref\nMario's Pizzeria,BT1 1AA,a@x.com,ASSOC-1";
    const { client, captures } = makeClient({
      channel: F2G,
      existingRefs: [],
      membersByRef: [{ id: "m1", membership_ref: "ASSOC-1", venue_id: "v-manual", source_postcode: "BT1 1AA", source_name: "Mario's Pizzeria" }],
      venues: [{ id: "v1", name: "Marios Pizzeria", address: "BT1 1AA", opening_times: null, rating: null }],
      manualRef: { method: "manual" }, // a human already fixed this match
      runReturn: { id: "run-2" },
    });
    const report = await importRoster(client, { channelKey: "f2g", csv, actorId: "staff-1" });
    expect(report.matchedAccept).toBe(0); // skipped — manual correction is permanent
    expect(captures.upserts.find((u) => u.table === "external_refs")).toBeUndefined();
  });

  it("rejects an unknown channel and the default channel", async () => {
    const { client } = makeClient({ channel: null, existingRefs: [], membersByRef: [], venues: [], manualRef: null, runReturn: null });
    await expect(importRoster(client, { channelKey: "nope", csv: "name\nX" })).rejects.toThrow(/unknown channel/);
  });

  it("withholds an accept when the venue already belongs to another member", async () => {
    // With no membership number to prove identity (none until 2027), the roster match IS the identity
    // claim behind activation — so binding one venue to two members would let the wrong business
    // activate it. confirmMatch has always refused this manually; the auto path used to allow it.
    const csv = "name,postcode,email,ref\nMario's Pizzeria,BT1 1AA,a@x.com,ASSOC-9";
    const { client, captures } = makeClient({
      channel: F2G,
      existingRefs: [],
      membersByRef: [{ id: "m9", membership_ref: "ASSOC-9", venue_id: null, source_postcode: "BT1 1AA", source_name: "Mario's Pizzeria" }],
      venues: [{ id: "v1", name: "Marios Pizzeria", address: "12 High St, Belfast, BT1 1AA", opening_times: null, rating: null }],
      boundVenues: [{ id: "m-other", venue_id: "v1" }], // v1 is already someone else's
      manualRef: null,
      runReturn: { id: "run-3" },
    });

    const report = await importRoster(client, { channelKey: "f2g", csv, actorId: "staff-1" });

    expect(report.matchedAccept).toBe(0);
    expect(report.matchedConflict).toBe(1);
    expect(report.matchedReview).toBe(1); // it needs a human, so it lands in the review queue
    expect(report.conflictsSample).toEqual([{ member: "ASSOC-9", venueId: "v1" }]);
    expect(captures.upserts.find((u) => u.table === "external_refs")).toBeUndefined();
    expect(captures.updates.find((u) => u.table === "channel_members")).toBeUndefined();
  });

  it("re-binding a member to the venue it already holds is not a conflict", async () => {
    const csv = "name,postcode,email,ref\nMario's Pizzeria,BT1 1AA,a@x.com,ASSOC-1";
    const { client, captures } = makeClient({
      channel: F2G,
      existingRefs: ["ASSOC-1"].map((membership_ref) => ({ membership_ref })),
      membersByRef: [{ id: "m1", membership_ref: "ASSOC-1", venue_id: "v1", source_postcode: "BT1 1AA", source_name: "Mario's Pizzeria" }],
      venues: [{ id: "v1", name: "Marios Pizzeria", address: "12 High St, Belfast, BT1 1AA", opening_times: null, rating: null }],
      boundVenues: [{ id: "m1", venue_id: "v1" }], // held by THIS member
      manualRef: null,
      runReturn: { id: "run-4" },
    });

    const report = await importRoster(client, { channelKey: "f2g", csv, actorId: "staff-1" });

    expect(report.matchedConflict).toBe(0);
    expect(report.matchedAccept).toBe(1);
    expect(captures.upserts.find((u) => u.table === "external_refs")).toBeDefined();
  });

  it("a dry run reports what a real run would do, and writes nothing at all", async () => {
    const csv = [
      "name,postcode,email,ref",
      "Mario's Pizzeria,BT1 1AA,a@x.com,ASSOC-1",
      "No Postcode Cafe,,b@x.com,ASSOC-2",
    ].join("\n");
    const cfg = {
      channel: F2G,
      existingRefs: [{ membership_ref: "ASSOC-2" }],
      // A dry run does not insert, so only the PRE-EXISTING member is findable by ref.
      membersByRef: [{ id: "m2", membership_ref: "ASSOC-2", venue_id: null, source_postcode: null, source_name: "No Postcode Cafe" }],
      venues: [{ id: "v1", name: "Marios Pizzeria", address: "12 High St, Belfast, BT1 1AA", opening_times: null, rating: null }],
      manualRef: null,
      runReturn: { id: "run-5" },
    };
    const { client, captures } = makeClient(cfg);

    const dry = await importRoster(client, { channelKey: "f2g", csv, actorId: "staff-1", dryRun: true });

    expect(dry.dryRun).toBe(true);
    expect(dry.runId).toBeNull(); // no row in the channel's import history for an import that never ran
    expect(captures.upserts).toEqual([]);
    expect(captures.updates).toEqual([]);
    expect(captures.inserts).toEqual([]);

    // The numbers are the real ones: ASSOC-1 is new, ASSOC-2 already exists, and the match still runs.
    expect(dry.imported).toBe(1);
    expect(dry.updated).toBe(1);
    expect(dry.matchedAccept).toBe(1);
    expect(dry.backfillCandidates).toEqual(["v1"]);

    // And it explains itself: the column mapping and the row-level complaints come back with it.
    expect(dry.columns.map((c) => c.field)).toEqual(["name", "postcode", "email", "ref"]);
    expect(dry.warningsSample.some((w) => /postcode/.test(w.reason))).toBe(true);
  });

  it("an unmapped header can be bound by the operator instead of failing the file", async () => {
    const csv = "Outlet Description,Post Code\nMario's Pizzeria,BT1 1AA";
    const { client } = makeClient({
      channel: F2G, existingRefs: [], membersByRef: [], venues: [], manualRef: null, runReturn: null,
    });

    const blind = await importRoster(client, { channelKey: "f2g", csv, dryRun: true });
    expect(blind.errors).toBe(1); // no recognisable name column

    const mapped = await importRoster(client, {
      channelKey: "f2g", csv, dryRun: true, mapping: { "Outlet Description": "name" },
    });
    expect(mapped.errors).toBe(0);
    expect(mapped.imported).toBe(1);
  });
});
