import { describe, it, expect, vi, afterEach } from "vitest";
import type { RoamClient } from "@roam/db";
import { runFsaSync } from "./syncFsaNi.js";
import type { FsaConfig } from "../fsa/client.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CFG: FsaConfig = { baseUrl: "https://fsa.example", authorityIds: [1], pageSize: 5000 };

/**
 * A fake service client: builder methods chain; terminals resolve per-table; writes are captured.
 * Models the sync's three reads: the linked-fhrsid page (external_refs), the manual-refs page
 * (external_refs filtered by method='manual'), and a postcode block's venues (venues, paged).
 */
function makeService(opts: { venues?: any[]; linked?: any[]; manualRefs?: any[] }) {
  const captures = { fsaUpserts: [] as any[], refUpserts: [] as any[], venueReads: 0 };
  function builder(table: string): any {
    let manualFilter = false;
    const b: any = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        if (col === "method" && val === "manual") manualFilter = true;
        return b;
      },
      ilike: () => b,
      not: () => b,
      range: async () => {
        if (table === "venues") {
          captures.venueReads++;
          return { data: opts.venues ?? [], error: null };
        }
        if (table === "external_refs") {
          return { data: manualFilter ? (opts.manualRefs ?? []) : (opts.linked ?? []), error: null };
        }
        return { data: [], error: null };
      },
      upsert: async (payload: any) => {
        if (table === "fsa_establishments") captures.fsaUpserts.push(payload);
        if (table === "external_refs") captures.refUpserts.push(payload);
        return { error: null };
      },
    };
    return b;
  }
  return { client: { from: builder } as unknown as RoamClient, captures };
}

/** Stub global fetch to return one page of FSA establishments for the authority, empty otherwise. */
function stubFsaFetch(establishments: any[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const isPage1 = /pageNumber=1\b/.test(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ establishments: isPage1 ? establishments : [] }),
      } as any;
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

const EST = {
  FHRSID: "123456",
  BusinessName: "Verbatim Cafe",
  PostCode: "BT1 1AA",
  RatingValue: "5",
  RatingKey: "fhrs_5_en-gb",
  RatingDate: "2026-01-15T00:00:00",
  LocalAuthorityName: "Belfast",
};
const MATCHING_VENUE = { id: "v-1", name: "Verbatim Cafe", address: "12 High St, BT1 1AA" };

describe("runFsaSync", () => {
  it("is a no-op when unconfigured", async () => {
    const { client } = makeService({});
    expect(await runFsaSync(client, null)).toMatchObject({ status: "unconfigured", fetched: 0, upserted: 0, matched: 0 });
  });

  it("upserts the corpus and writes a venue↔fsa match on an accept", async () => {
    stubFsaFetch([EST]);
    const { client, captures } = makeService({ venues: [MATCHING_VENUE], linked: [], manualRefs: [] });
    const r = await runFsaSync(client, CFG);
    expect(r).toMatchObject({ authorities: 1, fetched: 1, upserted: 1, matched: 1, status: "ok" });
    expect(captures.fsaUpserts[0][0]).toMatchObject({ fhrsid: "123456", rating_value: "5", rating_date: "2026-01-15" });
    // Links are written in batches (one upsert per chunk), not one round-trip per match.
    expect(captures.refUpserts).toHaveLength(1);
    expect(captures.refUpserts[0][0]).toMatchObject({
      entity_type: "venue",
      entity_id: "v-1",
      dataset: "fsa",
      external_id: "123456",
      method: "auto",
    });
  });

  it("reads each postcode block's candidates ONCE, however many establishments share it", async () => {
    stubFsaFetch([
      EST,
      { ...EST, FHRSID: "222", BusinessName: "Other Cafe", PostCode: "BT1 2BB" },
      { ...EST, FHRSID: "333", BusinessName: "Third Cafe", PostCode: "BT1 3CC" },
    ]);
    const { client, captures } = makeService({ venues: [MATCHING_VENUE], linked: [], manualRefs: [] });
    const r = await runFsaSync(client, CFG);
    expect(r.fetched).toBe(3);
    expect(captures.venueReads).toBe(1); // all three are in the BT1 block → one candidate read
    expect(r.matched).toBe(1); // only the verbatim name accepts; and a venue links to one establishment per run
  });

  it("skips matching an establishment already linked to a venue", async () => {
    stubFsaFetch([EST]);
    const { client, captures } = makeService({ venues: [MATCHING_VENUE], linked: [{ external_id: "123456" }] });
    const r = await runFsaSync(client, CFG);
    expect(r.upserted).toBe(1); // still refreshed in the corpus
    expect(r.matched).toBe(0); // but not re-matched
    expect(captures.refUpserts).toHaveLength(0);
  });

  it("never overwrites a human manual match", async () => {
    stubFsaFetch([EST]);
    const { client, captures } = makeService({ venues: [MATCHING_VENUE], linked: [], manualRefs: [{ entity_id: "v-1" }] });
    const r = await runFsaSync(client, CFG);
    expect(r.matched).toBe(0);
    expect(captures.refUpserts).toHaveLength(0);
  });

  it("treats an empty pull as no-change (never blanks the corpus)", async () => {
    stubFsaFetch([]);
    const { client, captures } = makeService({});
    const r = await runFsaSync(client, CFG);
    expect(r).toMatchObject({ fetched: 0, upserted: 0, matched: 0, status: "ok" });
    expect(captures.fsaUpserts).toHaveLength(0);
  });

  it("does not match an establishment with no postcode", async () => {
    stubFsaFetch([{ ...EST, PostCode: "" }]);
    const { client, captures } = makeService({ venues: [MATCHING_VENUE], linked: [] });
    const r = await runFsaSync(client, CFG);
    expect(r.upserted).toBe(1);
    expect(r.matched).toBe(0);
    expect(captures.refUpserts).toHaveLength(0);
  });
});
