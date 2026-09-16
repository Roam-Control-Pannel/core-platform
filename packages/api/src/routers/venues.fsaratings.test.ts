import { describe, it, expect } from "vitest";
import { mapFsaRatings } from "./venues.js";

/**
 * Unit tests for the PURE mapFsaRatings — the batch venue→FSA rating assembler behind the
 * `venues.fsaRatings` card/grid read. No db, no tRPC. The load-bearing property is the display gate
 * (via @roam/core/fsa.isDisplayableRating): a real 0–5 score renders as a score; a non-numeric status
 * renders as a status, NEVER as a number; anything unrenderable is DROPPED (the card shows no badge).
 */

const est = (fhrsid: string, rating_value: string, rating_key: string | null = null) => ({
  fhrsid,
  rating_value,
  rating_key,
  rating_date: "2025-01-01",
  synced_at: "2025-06-01T00:00:00Z",
  local_authority: "Belfast",
});

describe("mapFsaRatings", () => {
  it("maps a genuine 0–5 score to a score rating with the official badge for its FSA key", () => {
    const out = mapFsaRatings(
      [{ entity_id: "v1", external_id: "111" }],
      [est("111", "5", "fhrs_5_en-gb")],
    );
    expect(out.v1?.rating).toEqual({ kind: "score", score: 5 });
    expect(out.v1?.badge).toEqual({ assetId: "fhrs_5_en-gb", alt: "Food Hygiene Rating: 5 out of 5 (Very good)" });
    expect(out.v1?.fhrsid).toBe("111");
  });

  it("still renders the score with NO official badge when the row carries no FSA key", () => {
    const out = mapFsaRatings([{ entity_id: "v1", external_id: "111" }], [est("111", "5")]);
    expect(out.v1?.rating).toEqual({ kind: "score", score: 5 });
    expect(out.v1?.badge).toBeNull();
  });

  it("maps a non-numeric status to its kind, never a number — with its own official badge", () => {
    const out = mapFsaRatings(
      [{ entity_id: "v2", external_id: "222" }],
      [est("222", "AwaitingInspection", "fhrs_awaitinginspection_en-gb")],
    );
    expect(out.v2?.rating.kind).toBe("awaiting");
    expect(out.v2?.badge).toEqual({
      assetId: "fhrs_awaitinginspection_en-gb",
      alt: "Food Hygiene Rating: Awaiting inspection",
    });
  });

  it("refuses an official badge whose key disagrees with the displayed value", () => {
    const out = mapFsaRatings([{ entity_id: "v2", external_id: "222" }], [est("222", "4", "fhrs_5_en-gb")]);
    expect(out.v2?.rating).toEqual({ kind: "score", score: 4 });
    expect(out.v2?.badge).toBeNull();
  });

  it("DROPS a venue whose value is not renderable (no badge shown)", () => {
    const out = mapFsaRatings(
      [{ entity_id: "v3", external_id: "333" }],
      [est("333", "SomeUnknownScheme")],
    );
    expect(out.v3).toBeUndefined();
  });

  it("omits a venue with a link but no matching establishment row", () => {
    const out = mapFsaRatings(
      [{ entity_id: "v4", external_id: "444" }],
      [], // establishment not (yet) synced
    );
    expect(out.v4).toBeUndefined();
    expect(Object.keys(out)).toHaveLength(0);
  });

  it("skips a ref with a null external_id and maps only the resolvable venues", () => {
    const out = mapFsaRatings(
      [
        { entity_id: "v5", external_id: null },
        { entity_id: "v6", external_id: "666" },
      ],
      [est("666", "4")],
    );
    expect(out.v5).toBeUndefined();
    expect(out.v6?.rating).toEqual({ kind: "score", score: 4 });
    expect(Object.keys(out)).toEqual(["v6"]);
  });
});
