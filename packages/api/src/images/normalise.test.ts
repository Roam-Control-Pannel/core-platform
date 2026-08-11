import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  venuePrefixOf,
  deriveNormalisedPath,
  buildPublicUrl,
  normaliseImageBytes,
  PROFILES,
} from "./normalise.js";

describe("venuePrefixOf", () => {
  it("returns the first path segment", () => {
    expect(venuePrefixOf("ven-123/product-abc.jpg")).toBe("ven-123");
    expect(venuePrefixOf("ven-123/norm/product-abc.webp")).toBe("ven-123");
  });
  it("returns null when there is no prefix", () => {
    expect(venuePrefixOf("product-abc.jpg")).toBeNull();
    expect(venuePrefixOf("/leading-slash.jpg")).toBeNull();
  });
});

describe("deriveNormalisedPath", () => {
  it("puts a .webp sibling under norm/", () => {
    expect(deriveNormalisedPath("ven-123/product-abc.jpg")).toBe("ven-123/norm/product-abc.webp");
    expect(deriveNormalisedPath("ven-123/product-abc.PNG")).toBe("ven-123/norm/product-abc.webp");
  });
  it("handles an extensionless / dotfile name", () => {
    expect(deriveNormalisedPath("ven-123/photo")).toBe("ven-123/norm/photo.webp");
    expect(deriveNormalisedPath("ven-123/.thing")).toBe("ven-123/norm/.thing.webp");
  });
  it("handles a bare filename with no directory", () => {
    expect(deriveNormalisedPath("image.jpg")).toBe("norm/image.webp");
  });
});

describe("buildPublicUrl", () => {
  it("builds a keyless public object URL, segment-encoded, no double slash", () => {
    expect(buildPublicUrl("https://x.supabase.co/", "venue-media", "ven-1/norm/a b.webp")).toBe(
      "https://x.supabase.co/storage/v1/object/public/venue-media/ven-1/norm/a%20b.webp",
    );
  });
});

describe("normaliseImageBytes (real sharp)", () => {
  async function makeImage(width: number, height: number, format: "jpeg" | "png") {
    const base = sharp({
      create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
    });
    return (format === "jpeg" ? base.jpeg() : base.png()).toBuffer();
  }

  it("cover-crops a product image to a square within the cap and outputs WebP", async () => {
    const input = await makeImage(2000, 1000, "jpeg");
    const out = await normaliseImageBytes(input, "product");
    expect(out.width).toBe(out.height); // square
    expect(out.width).toBeLessThanOrEqual(PROFILES.product.maxEdge);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe("webp");
  });

  it("fits a photo inside the cap, preserving aspect (not square)", async () => {
    const input = await makeImage(3000, 1500, "png");
    const out = await normaliseImageBytes(input, "photo");
    expect(out.width).toBe(PROFILES.photo.maxEdge); // 2000
    expect(out.height).toBe(PROFILES.photo.maxEdge / 2); // 1000, aspect kept
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe("webp");
  });

  it("does not enlarge an image smaller than the cap", async () => {
    const input = await makeImage(300, 300, "png");
    const out = await normaliseImageBytes(input, "product");
    expect(out.width).toBe(300);
    expect(out.height).toBe(300);
  });
});
