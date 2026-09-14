import { describe, it, expect, vi, afterEach } from "vitest";
import type { RoamClient } from "@roam/db";
import { runFsaSync } from "./syncFsaNi.js";
import type { FsaConfig } from "../fsa/client.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CFG: FsaConfig = { baseUrl: "https://fsa.example", authorityIds: [1], pageSize: 5000 };

/** A fake service client: builder methods chain; terminals resolve per-table; writes are captured. */
function makeService(opts: { venues?: any[]; linked?: any[]; manualRef?: any | null }) {
  const captures = { fsaUpserts: [] as any[], refUpserts: [] as any[] };
  function builder(table: string): any {
    const b: any = {
      select: () => b,
      eq: () => b,
      ilike: () => b,
      not: () => b,
      range: async () => ({ data: table === "external_refs" ? (opts.linked ?? []) : [], error: null }),
      limit: async () => ({ data: table === "venues" ? (opts.venues ?? []) : [], error: null }),
      maybeSingle: async () => ({ data: table === "external_refs" ? (opts.manualRef ?? null) : null, error: null }),
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
    const { client, captures } = makeService({ venues: [MATCHING_VENUE], linked: [], manualRef: null });
    const r = await runFsaSync(client, CFG);
    expect(r).toMatchObject({ authorities: 1, fetched: 1, upserted: 1, matched: 1, status: "ok" });
    expect(captures.fsaUpserts[0][0]).toMatchObject({ fhrsid: "123456", rating_value: "5", rating_date: "2026-01-15" });
    expect(captures.refUpserts[0]).toMatchObject({
      entity_type: "venue",
      entity_id: "v-1",
      dataset: "fsa",
      external_id: "123456",
      method: "auto",
    });
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
    const { client, captures } = makeService({ venues: [MATCHING_VENUE], linked: [], manualRef: { method: "manual" } });
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
