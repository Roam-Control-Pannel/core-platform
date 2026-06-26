import { describe, it, expect } from "vitest";
import type { places as corePlaces } from "@roam/core";
import {
  backfillVenuePhotosCore,
  type BackfillPhotoEntry,
  type PhotolessVenue,
} from "./photos.js";

/** A PlaceResult with `n` photos (each carrying a usable ref). */
function placeWithPhotos(id: string, n: number): corePlaces.PlaceResult {
  return {
    id,
    photos: Array.from({ length: n }, (_, i) => ({
      name: `places/${id}/photos/${i}`,
      widthPx: 1000 + i,
      heightPx: 800 + i,
      authorAttributions: [{ displayName: "A", uri: "https://x" }],
    })),
  };
}

/** A getDetails fake driven by a fixture map; records the ids it was asked for. */
function fakeDetails(fixtures: Record<string, corePlaces.PlaceResult | Error>) {
  const asked: string[] = [];
  return {
    asked,
    getDetails: async (placeId: string) => {
      asked.push(placeId);
      const f = fixtures[placeId];
      if (f instanceof Error) throw f;
      if (!f) throw new Error(`no fixture for ${placeId}`);
      return f;
    },
  };
}

/** An upsert sink that records every batch and returns the total rows "inserted". */
function fakeUpsert() {
  const batches: BackfillPhotoEntry[][] = [];
  return {
    batches,
    upsertVenuePhotos: async (payload: BackfillPhotoEntry[]) => {
      batches.push(payload);
      return payload.reduce((acc, e) => acc + e.photos.length, 0);
    },
  };
}

const venues: PhotolessVenue[] = [
  { id: "v1", source_ref: "p1", name: "One" },
  { id: "v2", source_ref: "p2", name: "Two" },
  { id: "v3", source_ref: "p3", name: "Three" },
];

describe("backfillVenuePhotosCore", () => {
  it("fetches each venue's photos and upserts the mapped, positioned rows", async () => {
    const details = fakeDetails({
      p1: placeWithPhotos("p1", 2),
      p2: placeWithPhotos("p2", 1),
      p3: placeWithPhotos("p3", 3),
    });
    const sink = fakeUpsert();

    const res = await backfillVenuePhotosCore(venues, {
      getDetails: details.getDetails,
      upsertVenuePhotos: sink.upsertVenuePhotos,
    });

    expect(details.asked).toEqual(["p1", "p2", "p3"]);
    expect(res.considered).toBe(3);
    expect(res.fetched).toBe(3);
    expect(res.failed).toBe(0);
    expect(res.venuesWithPhotos).toBe(3);
    expect(res.venuesWithoutPhotos).toBe(0);
    expect(res.photosUpserted).toBe(6);

    // positions stamped in array order
    const all = sink.batches.flat();
    const v3 = all.find((e) => e.venue_id === "v3")!;
    expect(v3.photos.map((p) => p.position)).toEqual([0, 1, 2]);
    expect(v3.photos[0]!.places_photo_ref).toBe("places/p3/photos/0");
  });

  it("counts venues with no Google photos and does not upsert them", async () => {
    const details = fakeDetails({
      p1: placeWithPhotos("p1", 0), // Google genuinely has none
      p2: placeWithPhotos("p2", 2),
      p3: placeWithPhotos("p3", 0),
    });
    const sink = fakeUpsert();

    const res = await backfillVenuePhotosCore(venues, {
      getDetails: details.getDetails,
      upsertVenuePhotos: sink.upsertVenuePhotos,
    });

    expect(res.venuesWithPhotos).toBe(1);
    expect(res.venuesWithoutPhotos).toBe(2);
    expect(res.photosUpserted).toBe(2);
    expect(sink.batches.flat().map((e) => e.venue_id)).toEqual(["v2"]);
  });

  it("records a per-venue fetch failure and keeps going", async () => {
    const details = fakeDetails({
      p1: placeWithPhotos("p1", 1),
      p2: new Error("boom"),
      p3: placeWithPhotos("p3", 1),
    });
    const sink = fakeUpsert();

    const res = await backfillVenuePhotosCore(venues, {
      getDetails: details.getDetails,
      upsertVenuePhotos: sink.upsertVenuePhotos,
    });

    expect(res.fetched).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.venuesWithPhotos).toBe(2);
    expect(res.photosUpserted).toBe(2);
    expect(details.asked).toEqual(["p1", "p2", "p3"]); // p2's failure didn't abort
  });

  it("respects limit (cost guard) — only the first N venues are touched", async () => {
    const details = fakeDetails({
      p1: placeWithPhotos("p1", 1),
      p2: placeWithPhotos("p2", 1),
      p3: placeWithPhotos("p3", 1),
    });
    const sink = fakeUpsert();

    const res = await backfillVenuePhotosCore(
      venues,
      { getDetails: details.getDetails, upsertVenuePhotos: sink.upsertVenuePhotos },
      { limit: 2 },
    );

    expect(res.considered).toBe(2);
    expect(details.asked).toEqual(["p1", "p2"]);
  });

  it("dry run fetches and maps but writes nothing", async () => {
    const details = fakeDetails({
      p1: placeWithPhotos("p1", 2),
      p2: placeWithPhotos("p2", 1),
      p3: placeWithPhotos("p3", 1),
    });
    const sink = fakeUpsert();

    const res = await backfillVenuePhotosCore(
      venues,
      { getDetails: details.getDetails, upsertVenuePhotos: sink.upsertVenuePhotos },
      { dryRun: true },
    );

    expect(res.fetched).toBe(3);
    expect(res.venuesWithPhotos).toBe(3);
    expect(res.photosUpserted).toBe(0);
    expect(sink.batches).toEqual([]); // never called
  });

  it("flushes the upsert payload in batches of batchSize", async () => {
    const many: PhotolessVenue[] = Array.from({ length: 5 }, (_, i) => ({
      id: `v${i}`,
      source_ref: `p${i}`,
    }));
    const fixtures: Record<string, corePlaces.PlaceResult> = {};
    for (let i = 0; i < 5; i++) fixtures[`p${i}`] = placeWithPhotos(`p${i}`, 1);
    const details = fakeDetails(fixtures);
    const sink = fakeUpsert();

    await backfillVenuePhotosCore(
      many,
      { getDetails: details.getDetails, upsertVenuePhotos: sink.upsertVenuePhotos },
      { batchSize: 2 },
    );

    // 5 venues, batchSize 2 → flushes of 2, 2, then a final 1
    expect(sink.batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it("enriches venue card fields from the same Details call when the dep is provided", async () => {
    const details = fakeDetails({
      p1: { ...placeWithPhotos("p1", 1), rating: 4.6, userRatingCount: 1240, priceLevel: "PRICE_LEVEL_MODERATE" },
      p2: { ...placeWithPhotos("p2", 0), rating: 3.9, userRatingCount: 12 },
      p3: { ...placeWithPhotos("p3", 2), businessStatus: "CLOSED_TEMPORARILY" },
    });
    const sink = fakeUpsert();
    const updates: { id: string; fields: corePlaces.PlaceCardFields }[] = [];

    const res = await backfillVenuePhotosCore(venues, {
      getDetails: details.getDetails,
      upsertVenuePhotos: sink.upsertVenuePhotos,
      updateVenueFields: async (id, fields) => {
        updates.push({ id, fields });
      },
    });

    expect(res.enriched).toBe(3);
    expect(updates.map((u) => u.id)).toEqual(["v1", "v2", "v3"]);
    expect(updates[0]!.fields.rating_count).toBe(1240);
    expect(updates[0]!.fields.price_level).toBe("PRICE_LEVEL_MODERATE");
    expect(updates[2]!.fields.business_status).toBe("CLOSED_TEMPORARILY");
  });

  it("does not enrich in a dry run", async () => {
    const details = fakeDetails({
      p1: placeWithPhotos("p1", 1),
      p2: placeWithPhotos("p2", 1),
      p3: placeWithPhotos("p3", 1),
    });
    const sink = fakeUpsert();
    let updateCalls = 0;

    const res = await backfillVenuePhotosCore(
      venues,
      {
        getDetails: details.getDetails,
        upsertVenuePhotos: sink.upsertVenuePhotos,
        updateVenueFields: async () => {
          updateCalls++;
        },
      },
      { dryRun: true },
    );

    expect(res.enriched).toBe(0);
    expect(updateCalls).toBe(0);
  });

  it("skips a venue with an empty source_ref without fetching", async () => {
    const details = fakeDetails({ p2: placeWithPhotos("p2", 1) });
    const sink = fakeUpsert();

    const res = await backfillVenuePhotosCore(
      [
        { id: "v1", source_ref: "" },
        { id: "v2", source_ref: "p2" },
      ],
      { getDetails: details.getDetails, upsertVenuePhotos: sink.upsertVenuePhotos },
    );

    expect(details.asked).toEqual(["p2"]);
    expect(res.fetched).toBe(1);
    expect(res.venuesWithPhotos).toBe(1);
  });
});
