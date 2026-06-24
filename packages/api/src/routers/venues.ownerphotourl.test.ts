import { describe, it, expect } from "vitest";
import { buildOwnerPhotoPublicUrl } from "./venues.js";

/**
 * Unit tests for the PURE buildOwnerPhotoPublicUrl: the owner_upload public-CDN-URL
 * builder (the owner twin of buildPhotoMediaRequestUrl). No network, no key, no tRPC —
 * runs in CI. The live upload→public-URL round-trip is proven by the slice's live gate;
 * here we pin the URL SHAPE photoMediaUrl depends on: the /storage/v1/object/public
 * resource path, the bucket, the object path, trailing-slash safety, and segment-wise
 * encoding (spaces/unicode encoded, '/' separators preserved).
 */

const SUPA = "https://kyancopdkxotzzkzqsmf.supabase.co";
const BUCKET = "venue-media";
const VENUE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("buildOwnerPhotoPublicUrl", () => {
  it("builds the canonical public object URL", () => {
    expect(buildOwnerPhotoPublicUrl(SUPA, BUCKET, `${VENUE}/abc123.jpg`)).toBe(
      `${SUPA}/storage/v1/object/public/${BUCKET}/${VENUE}/abc123.jpg`,
    );
  });

  it("trims a trailing slash on the base url (no double slash)", () => {
    expect(buildOwnerPhotoPublicUrl(`${SUPA}/`, BUCKET, `${VENUE}/abc123.jpg`)).toBe(
      `${SUPA}/storage/v1/object/public/${BUCKET}/${VENUE}/abc123.jpg`,
    );
  });

  it("encodes a space in the filename", () => {
    expect(buildOwnerPhotoPublicUrl(SUPA, BUCKET, `${VENUE}/my photo.jpg`)).toBe(
      `${SUPA}/storage/v1/object/public/${BUCKET}/${VENUE}/my%20photo.jpg`,
    );
  });

  it("preserves the / separator between path segments", () => {
    expect(buildOwnerPhotoPublicUrl(SUPA, BUCKET, `${VENUE}/sub/x.png`)).toBe(
      `${SUPA}/storage/v1/object/public/${BUCKET}/${VENUE}/sub/x.png`,
    );
  });

  it("produces a URL that parses and round-trips", () => {
    const url = buildOwnerPhotoPublicUrl(SUPA, BUCKET, `${VENUE}/abc.webp`);
    expect(new URL(url).toString()).toBe(url);
  });

  it("a built URL's decoded pathname recovers the original filename", () => {
    const url = buildOwnerPhotoPublicUrl(SUPA, BUCKET, `${VENUE}/my photo.jpg`);
    expect(decodeURIComponent(new URL(url).pathname).endsWith(`/${VENUE}/my photo.jpg`)).toBe(
      true,
    );
  });
});
