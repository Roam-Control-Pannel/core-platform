import { describe, it, expect } from "vitest";
import { selectHero, galleryOrder, type VenuePhotoRow } from "./index.js";

/** Helper to build a row with only the fields the policy reads. */
function row(
  source: VenuePhotoRow["source"],
  position: number,
  is_cover = false,
): VenuePhotoRow {
  return { source, position, is_cover };
}

describe("selectHero", () => {
  it("returns null for no photos", () => {
    expect(selectHero([])).toBeNull();
  });

  it("prefers owner_upload over google_places", () => {
    const photos = [row("google_places", 0), row("owner_upload", 0)];
    expect(selectHero(photos)).toEqual(row("owner_upload", 0));
  });

  it("an explicit cover wins even over a lower-position owner photo", () => {
    const photos = [
      row("owner_upload", 0),
      row("owner_upload", 1, true), // pinned cover, higher position
    ];
    expect(selectHero(photos)).toEqual(row("owner_upload", 1, true));
  });

  it("a cover wins even if it is a google_places row", () => {
    // (owners cannot set is_cover on a places row via RLS, but the pure function must
    // honour whatever flag it is given — the DB enforces who can set it, not core.)
    const photos = [row("owner_upload", 0), row("google_places", 0, true)];
    expect(selectHero(photos)).toEqual(row("google_places", 0, true));
  });

  it("falls back to the first google_places by position when no owner photos", () => {
    const photos = [row("google_places", 2), row("google_places", 0), row("google_places", 1)];
    expect(selectHero(photos)).toEqual(row("google_places", 0));
  });

  it("picks the lowest-position owner photo when several exist", () => {
    const photos = [row("owner_upload", 3), row("owner_upload", 1), row("owner_upload", 2)];
    expect(selectHero(photos)).toEqual(row("owner_upload", 1));
  });
});

describe("galleryOrder", () => {
  it("returns [] for no photos", () => {
    expect(galleryOrder([])).toEqual([]);
  });

  it("orders owner block (by position) before places block (by position)", () => {
    const photos = [
      row("google_places", 0),
      row("owner_upload", 1),
      row("owner_upload", 0),
      row("google_places", 1),
    ];
    expect(galleryOrder(photos)).toEqual([
      row("owner_upload", 0),
      row("owner_upload", 1),
      row("google_places", 0),
      row("google_places", 1),
    ]);
  });

  it("handles an all-places gallery (unclaimed venue)", () => {
    const photos = [row("google_places", 1), row("google_places", 0)];
    expect(galleryOrder(photos)).toEqual([
      row("google_places", 0),
      row("google_places", 1),
    ]);
  });

  it("does not mutate the input array", () => {
    const photos = [row("google_places", 1), row("owner_upload", 0)];
    const snapshot = [...photos];
    galleryOrder(photos);
    expect(photos).toEqual(snapshot);
  });
});
