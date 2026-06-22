import { describe, it, expect } from "vitest";
import { buildPhotoMediaRequestUrl } from "./venues.js";

/**
 * Unit tests for the PURE buildPhotoMediaRequestUrl: the Places (New) photo-media
 * request URL builder. No network, no key, no tRPC — runs in CI. The live fetch
 * (real key → real googleusercontent URL) is proven by the slice's live gate; here
 * we pin the URL SHAPE the photoMediaUrl procedure depends on: the /media resource
 * path, the key, the width, and skipHttpRedirect=true (the flag that makes Google
 * return JSON { photoUri } instead of a 302 to bytes).
 */

const REF = "places/ChIJabc123/photos/AeJbb0xPhotoRef";
const KEY = "test-places-key";

describe("buildPhotoMediaRequestUrl", () => {
  it("targets the /media resource on the ref", () => {
    const url = buildPhotoMediaRequestUrl(REF, KEY, 1200);
    expect(url.startsWith(`https://places.googleapis.com/v1/${REF}/media?`)).toBe(true);
  });

  it("carries key, maxWidthPx and skipHttpRedirect=true", () => {
    const url = buildPhotoMediaRequestUrl(REF, KEY, 1200);
    const params = new URL(url).searchParams;
    expect(params.get("key")).toBe(KEY);
    expect(params.get("maxWidthPx")).toBe("1200");
    expect(params.get("skipHttpRedirect")).toBe("true");
  });

  it("reflects the requested width", () => {
    const url = buildPhotoMediaRequestUrl(REF, KEY, 480);
    expect(new URL(url).searchParams.get("maxWidthPx")).toBe("480");
  });

  it("url-encodes a key with reserved characters", () => {
    const url = buildPhotoMediaRequestUrl(REF, "a/b+c=d", 1200);
    // The encoded form must round-trip back to the raw key via URL parsing.
    expect(new URL(url).searchParams.get("key")).toBe("a/b+c=d");
  });

  it("preserves the ref verbatim in the path", () => {
    const url = buildPhotoMediaRequestUrl(REF, KEY, 1200);
    expect(new URL(url).pathname).toBe(`/v1/${REF}/media`);
  });
});
