import { describe, it, expect } from "vitest";
import type { RoamClient } from "@roam/db";
import { fsaReviewQueue, fsaSearch, confirmFsaMatch, unlinkFsaMatch, setFsaMatchDismissed, fsaCoverage } from "./fsaReview.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A chainable, thenable Supabase stand-in (same idiom as reviewQueue.test.ts): every builder method
 * returns the proxy; awaiting it resolves to the per-table response. Writes are captured. A table's
 * response may be a function of the calls made on the chain, so one table can answer differently to
 * different filters (external_refs is read for linked ids AND written for a confirm).
 */
function makeClient(byTable: Record<string, { data?: any; error?: any; count?: number }>) {
  const captures = { upserts: [] as any[], deletes: [] as any[], inserts: [] as any[] };
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
            if (prop === "insert") captures.inserts.push({ table, payload: args[0] });
            if (prop === "delete") captures.deletes.push({ table });
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

const VENUE = { id: "v-cape", name: "Cape Cod Ballymena", address: "12 Broughshane St, Ballymena BT42 3AU", slug: "cape-cod" };
const EST_MATCH = { fhrsid: "111", business_name: "Cape Cod", address: "12 Broughshane Street", postcode: "BT42 3AU", rating_value: "5", local_authority: "Mid and East Antrim" };
const EST_OTHER = { fhrsid: "222", business_name: "Greggs PLC", address: "Broughshane St", postcode: "BT42 3AU", rating_value: "5", local_authority: "Mid and East Antrim" };
const EST_BT429 = { fhrsid: "333", business_name: "Cape Cod", address: "Elsewhere", postcode: "BT429ZZ", rating_value: "4", local_authority: "Mid and East Antrim" };

describe("fsaReviewQueue", () => {
  it("lists an unlinked food venue with its same-block candidates ranked, and drops noise below the review floor", async () => {
    const { client } = makeClient({
      external_refs: { data: [] },
      fsa_match_dismissals: { data: [] },
      venues: { data: [VENUE] },
      fsa_establishments: { data: [EST_MATCH, EST_OTHER, EST_BT429] },
    });
    const page = await fsaReviewQueue(client, { limit: 25, offset: 0 });
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.venueId).toBe("v-cape");
    expect(item.postcode).toBe("BT42 3AU");
    // Cape Cod at the same full postcode is the top candidate; Greggs is below the review floor.
    expect(item.candidates[0]?.fhrsid).toBe("111");
    expect(item.candidates[0]?.postcodeAgreement).toBe("full");
    expect(item.candidates.map((c) => c.fhrsid)).not.toContain("222");
    // BT42 9ZZ is a different outward-block match? No — same outward (BT42), different unit: shown but not full.
    expect(item.bestScore).toBeGreaterThanOrEqual(0.85);
    expect(page.hasMore).toBe(false);
  });

  it("skips venues that already carry an FSA link, and dismissed ones unless asked", async () => {
    const base = {
      venues: { data: [VENUE, { ...VENUE, id: "v-linked", name: "Linked Cafe" }, { ...VENUE, id: "v-dismissed", name: "Dismissed Cafe" }] },
      fsa_establishments: { data: [EST_MATCH] },
      external_refs: { data: [{ entity_id: "v-linked" }] },
      fsa_match_dismissals: { data: [{ venue_id: "v-dismissed", note: "closed" }] },
    };
    const a = await fsaReviewQueue(makeClient(base).client, { limit: 25, offset: 0 });
    expect(a.items.map((i) => i.venueId)).toEqual(["v-cape"]);
    const b = await fsaReviewQueue(makeClient(base).client, { limit: 25, offset: 0, includeDismissed: true });
    expect(b.items.map((i) => i.venueId).sort()).toEqual(["v-cape", "v-dismissed"]);
    expect(b.items.find((i) => i.venueId === "v-dismissed")?.dismissedNote).toBe("closed");
  });

  it("skips a venue whose postcode block has no FSA establishments (outside the synced corpus)", async () => {
    const { client } = makeClient({
      external_refs: { data: [] },
      fsa_match_dismissals: { data: [] },
      venues: { data: [{ ...VENUE, id: "v-gb", address: "1 High St, Darlington DL1 1AA" }] },
      fsa_establishments: { data: [] },
    });
    const page = await fsaReviewQueue(client, { limit: 25, offset: 0 });
    expect(page.items).toHaveLength(0);
    expect(page.scanned).toBe(1);
  });

  it("pages: hasMore + nextOffset resume at the (limit+1)th queue venue", async () => {
    const venues = ["a", "b", "c"].map((k) => ({ ...VENUE, id: `v-${k}`, name: `Cape Cod ${k}` }));
    const { client } = makeClient({
      external_refs: { data: [] },
      fsa_match_dismissals: { data: [] },
      venues: { data: venues },
      fsa_establishments: { data: [EST_MATCH] },
    });
    const page = await fsaReviewQueue(client, { limit: 2, offset: 0 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(2);
  });
});

describe("fsaSearch", () => {
  it("returns corpus rows by trading name with no scores (reviewer judges)", async () => {
    const { client } = makeClient({ fsa_establishments: { data: [EST_MATCH] } });
    const rows = await fsaSearch(client, { q: "cape" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fhrsid: "111", name: "Cape Cod", ratingValue: "5", score: 0 });
  });
  it("ignores a query shorter than 2 characters", async () => {
    const { client } = makeClient({ fsa_establishments: { data: [EST_MATCH] } });
    expect(await fsaSearch(client, { q: " a " })).toEqual([]);
  });
});

describe("confirmFsaMatch", () => {
  it("writes the manual external_ref, clears any dismissal, and audits", async () => {
    const { client, captures } = makeClient({
      venues: { data: { id: "v-cape" } },
      fsa_establishments: { data: { fhrsid: "111" } },
      external_refs: { data: null },
      fsa_match_dismissals: { data: null },
      admin_audit_log: { data: null },
    });
    await confirmFsaMatch(client, ACTOR, { venueId: "v-cape", fhrsid: "111" });
    expect(captures.upserts[0]).toMatchObject({
      table: "external_refs",
      payload: { entity_type: "venue", entity_id: "v-cape", dataset: "fsa", external_id: "111", method: "manual", matched_by: ACTOR.id },
    });
    expect(captures.deletes).toContainEqual({ table: "fsa_match_dismissals" });
    expect(captures.inserts[0]).toMatchObject({ table: "admin_audit_log", payload: { action: "confirm_fsa_match", entity_id: "v-cape" } });
  });

  it("refuses an fhrsid that is not in the synced corpus (never links to a phantom record)", async () => {
    const { client, captures } = makeClient({ venues: { data: { id: "v-cape" } }, fsa_establishments: { data: null } });
    await expect(confirmFsaMatch(client, ACTOR, { venueId: "v-cape", fhrsid: "nope" })).rejects.toThrow(/not found/);
    expect(captures.upserts).toHaveLength(0);
  });
});

describe("unlinkFsaMatch / setFsaMatchDismissed", () => {
  it("unlink removes the ref AND dismisses (so the nightly sync cannot re-link), audited", async () => {
    const { client, captures } = makeClient({ external_refs: { data: null }, fsa_match_dismissals: { data: null }, admin_audit_log: { data: null } });
    await unlinkFsaMatch(client, ACTOR, { venueId: "v-cape", note: "wrong branch" });
    expect(captures.deletes).toContainEqual({ table: "external_refs" });
    expect(captures.upserts[0]).toMatchObject({ table: "fsa_match_dismissals", payload: { venue_id: "v-cape", dismissed_by: ACTOR.id, note: "wrong branch" } });
    expect(captures.inserts[0]).toMatchObject({ table: "admin_audit_log", payload: { action: "unlink_fsa_match" } });
  });

  it("dismiss writes the marker; undismiss deletes it; both audited", async () => {
    const { client, captures } = makeClient({ fsa_match_dismissals: { data: null }, admin_audit_log: { data: null } });
    await setFsaMatchDismissed(client, ACTOR, { venueId: "v-cape", dismissed: true, note: "FSA has no record" });
    expect(captures.upserts[0]).toMatchObject({ table: "fsa_match_dismissals", payload: { venue_id: "v-cape", note: "FSA has no record" } });
    await setFsaMatchDismissed(client, ACTOR, { venueId: "v-cape", dismissed: false });
    expect(captures.deletes).toContainEqual({ table: "fsa_match_dismissals" });
    expect(captures.inserts.map((i) => i.payload.action)).toEqual(["dismiss_fsa_match", "undismiss_fsa_match"]);
  });
});

describe("fsaCoverage", () => {
  it("reports counts and a rounded percentage", async () => {
    const { client } = makeClient({
      venues: { count: 1238 },
      external_refs: { count: 921 },
      fsa_match_dismissals: { count: 3 },
    });
    expect(await fsaCoverage(client)).toEqual({ foodVenues: 1238, linked: 921, dismissed: 3, pct: 74.4 });
  });
});
