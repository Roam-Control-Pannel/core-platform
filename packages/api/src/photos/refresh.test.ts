import { describe, it, expect } from "vitest";
import {
  isStalePhotoRefResponse,
  pickFreshRow,
  refreshVenueGooglePhotosCore,
  RECENTLY_REFRESHED_MS,
  type RefreshVenuePhotosDeps,
  type FreshPhotoRow,
} from "./refresh.js";

const GOOGLE_EXPIRED_BODY = JSON.stringify({
  error: {
    code: 400,
    message: "The photo resource in the request is invalid. Please retrieve it from Places API endpoints.",
    status: "INVALID_ARGUMENT",
  },
});

describe("isStalePhotoRefResponse — heal only when the REF is bad, never when the CALL is", () => {
  it("400 + Google's INVALID_ARGUMENT expired-ref body → stale (heal)", () => {
    expect(isStalePhotoRefResponse(400, GOOGLE_EXPIRED_BODY)).toBe(true);
  });
  it("404 → the photo is gone → stale (heal)", () => {
    expect(isStalePhotoRefResponse(404, "")).toBe(true);
  });
  it("400 with no readable body → assume expired (heal)", () => {
    expect(isStalePhotoRefResponse(400, "")).toBe(true);
    expect(isStalePhotoRefResponse(400, null)).toBe(true);
  });
  it("400 for a malformed request of ours → NOT stale (healing cannot fix it)", () => {
    expect(isStalePhotoRefResponse(400, '{"error":{"message":"maxWidthPx must be between 1 and 4800"}}')).toBe(false);
  });
  it("403 / 429 / 5xx → key, quota or outage → NOT stale (never spend budget masking the fault)", () => {
    expect(isStalePhotoRefResponse(403, "PERMISSION_DENIED")).toBe(false);
    expect(isStalePhotoRefResponse(429, "RESOURCE_EXHAUSTED")).toBe(false);
    expect(isStalePhotoRefResponse(500, "")).toBe(false);
    expect(isStalePhotoRefResponse(502, GOOGLE_EXPIRED_BODY)).toBe(false);
  });
});

describe("pickFreshRow — serve the same gallery position, else the cover", () => {
  const rows: FreshPhotoRow[] = [
    { id: "n2", position: 2, places_photo_ref: "places/x/photos/n2" },
    { id: "n0", position: 0, places_photo_ref: "places/x/photos/n0" },
    { id: "n1", position: 1, places_photo_ref: "places/x/photos/n1" },
  ];
  it("returns the row at the requested position", () => {
    expect(pickFreshRow(rows, 1)?.id).toBe("n1");
  });
  it("falls back to the lowest position (the cover) when that position no longer exists", () => {
    expect(pickFreshRow(rows, 7)?.id).toBe("n0");
  });
  it("returns null when Google returned no photos", () => {
    expect(pickFreshRow([], 0)).toBeNull();
  });
});

/** A fake deps bag that records every call; each collaborator can be overridden. */
function fakeDeps(overrides: Partial<RefreshVenuePhotosDeps> = {}) {
  const calls = { quota: 0, getPhotos: [] as string[], refreshRows: [] as { venueId: string; n: number }[], list: 0 };
  const fresh: FreshPhotoRow[] = [
    { id: "f0", position: 0, places_photo_ref: "places/ChIJ_v/photos/fresh0" },
    { id: "f1", position: 1, places_photo_ref: "places/ChIJ_v/photos/fresh1" },
  ];
  const deps: RefreshVenuePhotosDeps = {
    getVenue: async () => ({ sourceRef: "ChIJ_v", refreshedAt: null, hasOwnerUploads: false }),
    claimDetailsQuota: async () => {
      calls.quota++;
      return true;
    },
    getPhotos: async (placeId) => {
      calls.getPhotos.push(placeId);
      return {
        id: placeId,
        photos: [{ name: "places/ChIJ_v/photos/fresh0" }, { name: "places/ChIJ_v/photos/fresh1" }],
      };
    },
    refreshRows: async (venueId, photos) => {
      calls.refreshRows.push({ venueId, n: photos.length });
      return photos.length;
    },
    listFreshRows: async () => {
      calls.list++;
      return fresh;
    },
    now: () => 1_000_000_000_000,
    ...overrides,
  };
  return { deps, calls, fresh };
}

describe("refreshVenueGooglePhotosCore", () => {
  it("happy path: claims budget, fetches by place id, replaces rows (positioned), returns the fresh rows", async () => {
    const { deps, calls, fresh } = fakeDeps();
    const out = await refreshVenueGooglePhotosCore("venue-1", deps);
    expect(out).toEqual({ kind: "refreshed", rows: fresh, inserted: 2 });
    expect(calls.quota).toBe(1);
    expect(calls.getPhotos).toEqual(["ChIJ_v"]);
    expect(calls.refreshRows).toEqual([{ venueId: "venue-1", n: 2 }]);
  });

  it("owner library → skipped BEFORE any budget claim or Google call", async () => {
    const { deps, calls } = fakeDeps({
      getVenue: async () => ({ sourceRef: "ChIJ_v", refreshedAt: null, hasOwnerUploads: true }),
    });
    expect(await refreshVenueGooglePhotosCore("venue-1", deps)).toEqual({ kind: "skipped", reason: "owner-library" });
    expect(calls.quota).toBe(0);
    expect(calls.getPhotos).toEqual([]);
  });

  it("refreshed within the hour → skipped without spending anything (negative cache)", async () => {
    const nowMs = 1_000_000_000_000;
    const { deps, calls } = fakeDeps({
      getVenue: async () => ({
        sourceRef: "ChIJ_v",
        refreshedAt: new Date(nowMs - RECENTLY_REFRESHED_MS / 2).toISOString(),
        hasOwnerUploads: false,
      }),
    });
    expect(await refreshVenueGooglePhotosCore("venue-1", deps)).toEqual({ kind: "skipped", reason: "recently-refreshed" });
    expect(calls.quota).toBe(0);
  });

  it("refreshed longer ago than the window → refreshes again", async () => {
    const nowMs = 1_000_000_000_000;
    const { deps } = fakeDeps({
      getVenue: async () => ({
        sourceRef: "ChIJ_v",
        refreshedAt: new Date(nowMs - RECENTLY_REFRESHED_MS * 3).toISOString(),
        hasOwnerUploads: false,
      }),
    });
    expect((await refreshVenueGooglePhotosCore("venue-1", deps)).kind).toBe("refreshed");
  });

  it("budget exhausted → skipped, no Google call", async () => {
    const { deps, calls } = fakeDeps({ claimDetailsQuota: async () => false });
    expect(await refreshVenueGooglePhotosCore("venue-1", deps)).toEqual({ kind: "skipped", reason: "budget-exhausted" });
    expect(calls.getPhotos).toEqual([]);
  });

  it("no source_ref / missing venue → skipped", async () => {
    const a = fakeDeps({ getVenue: async () => ({ sourceRef: null, refreshedAt: null, hasOwnerUploads: false }) });
    expect(await refreshVenueGooglePhotosCore("v", a.deps)).toEqual({ kind: "skipped", reason: "no-source-ref" });
    const b = fakeDeps({ getVenue: async () => null });
    expect(await refreshVenueGooglePhotosCore("v", b.deps)).toEqual({ kind: "skipped", reason: "no-venue" });
  });

  it("Google fetch throws → failed (a value, never an exception), rows untouched", async () => {
    const { deps, calls } = fakeDeps({
      getPhotos: async () => {
        throw new Error("Places getPlacePhotos(ChIJ_v) failed: 503");
      },
    });
    const out = await refreshVenueGooglePhotosCore("venue-1", deps);
    expect(out.kind).toBe("failed");
    expect(calls.refreshRows).toEqual([]);
  });

  it("Google now returns NO photos → rows cleared, reported as refreshed with an empty set", async () => {
    const { deps, calls } = fakeDeps({ getPhotos: async (id) => ({ id, photos: [] }) });
    expect(await refreshVenueGooglePhotosCore("venue-1", deps)).toEqual({ kind: "refreshed", rows: [], inserted: 0 });
    expect(calls.refreshRows).toEqual([{ venueId: "venue-1", n: 0 }]);
    expect(calls.list).toBe(0); // nothing to list
  });

  it("fresh photos offered but the DB policy wrote nothing → policy-declined (not a fake success)", async () => {
    const { deps } = fakeDeps({ refreshRows: async () => 0 });
    expect(await refreshVenueGooglePhotosCore("venue-1", deps)).toEqual({ kind: "skipped", reason: "policy-declined" });
  });
});
