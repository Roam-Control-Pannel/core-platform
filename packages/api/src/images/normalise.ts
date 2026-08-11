/**
 * Server-side image normalisation (Food to Go · Phase 1C).
 *
 * The browser already best-effort-normalises uploads (apps/web/src/lib/prepareImage.ts: EXIF fix +
 * downscale + WebP). But that is UX, not a guarantee — GIF/SVG bypass it and it silently falls back
 * to the original file on any failure. For a marketplace whose storefront lives or dies on looking
 * uniform, we want a server GUARANTEE: whatever bytes reached storage, produce one canonical
 * rendition — orientation baked in, capped dimensions, re-encoded WebP — that the storefront renders.
 *
 * Split deliberately:
 *   - PURE helpers (path derivation, the public-URL builder, the profile specs) — no sharp, no I/O.
 *   - normaliseImageBytes — the sharp transform, bytes in → bytes out. No storage; unit-testable.
 *   - normaliseStoredImage — download from Storage, transform, upload the canonical object. Thin.
 *
 * Runs inside the @roam/api Node service (which already carries native deps); it is only ever
 * type-imported by the web/native shells, so `sharp` never enters a client bundle.
 */
import sharp from "sharp";
import type { RoamClient } from "@roam/db";

/** Which rendition to produce. */
export type NormaliseProfile = "product" | "photo";

export interface ProfileSpec {
  /** Longest edge (px). Images are never enlarged past their source. */
  maxEdge: number;
  /** Square cover-crop (product tiles) vs fit-inside (venue photos). */
  square: boolean;
}

/**
 * product — the F2G menu tile: a square, cover-cropped shot so a grid of vendors reads uniformly.
 * photo   — a venue cover: fit inside a cap, aspect preserved.
 */
export const PROFILES: Record<NormaliseProfile, ProfileSpec> = {
  product: { maxEdge: 1200, square: true },
  photo: { maxEdge: 2000, square: false },
};

/** WebP quality — matches the browser pipeline's 0.85 closely while cutting bytes hard. */
export const WEBP_QUALITY = 82;

/** The bucket vendor media lives in (public; owners upload under their venue-id prefix). */
export const VENUE_MEDIA_BUCKET = "venue-media";

/**
 * The venue-id path prefix of a storage object (`{venueId}/product-x.jpg` → `{venueId}`), or null
 * if the path has no prefix segment. Used to verify a caller only normalises their own uploads.
 */
export function venuePrefixOf(storagePath: string): string | null {
  const i = storagePath.indexOf("/");
  return i > 0 ? storagePath.slice(0, i) : null;
}

/**
 * Canonical output path for a normalised object: a `norm/` sibling with a `.webp` extension.
 * `{venueId}/product-abc.jpg` → `{venueId}/norm/product-abc.webp`. Deterministic, so re-normalising
 * the same source overwrites rather than piling up.
 */
export function deriveNormalisedPath(storagePath: string): string {
  const slash = storagePath.lastIndexOf("/");
  const dir = slash >= 0 ? storagePath.slice(0, slash) : "";
  const file = slash >= 0 ? storagePath.slice(slash + 1) : storagePath;
  const dot = file.lastIndexOf(".");
  const base = (dot > 0 ? file.slice(0, dot) : file) || "image";
  return dir ? `${dir}/norm/${base}.webp` : `norm/${base}.webp`;
}

/** Keyless public-CDN URL for a public-bucket object, segment-wise URL-encoded. */
export function buildPublicUrl(supabaseUrl: string, bucket: string, path: string): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${base}/storage/v1/object/public/${bucket}/${encoded}`;
}

export interface NormalisedBytes {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * The transform itself: decode (tolerantly), bake EXIF orientation, resize per profile without
 * enlarging, re-encode WebP. Pure function of bytes → bytes; no storage, no network.
 */
export async function normaliseImageBytes(
  input: Buffer,
  profile: NormaliseProfile,
): Promise<NormalisedBytes> {
  const spec = PROFILES[profile];
  const img = sharp(input, { failOn: "none" }).rotate(); // apply + bake EXIF orientation

  if (spec.square) {
    // A GUARANTEED square that never upscales: cover-crop to a side = min(cap, shorter source edge).
    // (min(w,h) is orientation-invariant, so this holds regardless of the baked rotation.)
    const meta = await img.metadata();
    const shortEdge = Math.min(meta.width ?? spec.maxEdge, meta.height ?? spec.maxEdge);
    const side = Math.max(1, Math.min(spec.maxEdge, shortEdge));
    const { data, info } = await img
      .resize(side, side, { fit: "cover" })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  }

  const { data, info } = await img
    .resize(spec.maxEdge, undefined, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

export interface NormaliseResult {
  path: string;
  url: string;
  width: number;
  height: number;
}

/**
 * Download a just-uploaded object, normalise it, and upload the canonical WebP rendition alongside
 * it. Returns the public URL the caller should persist as the image's URL. Uses a service-role
 * client (RLS-bypass) for the byte I/O — the CALLER is responsible for verifying ownership first.
 */
export async function normaliseStoredImage(
  service: RoamClient,
  supabaseUrl: string,
  storagePath: string,
  profile: NormaliseProfile,
  bucket: string = VENUE_MEDIA_BUCKET,
): Promise<NormaliseResult> {
  const { data, error } = await service.storage.from(bucket).download(storagePath);
  if (error || !data) {
    throw new Error(`normalise: download failed: ${error?.message ?? "no data"}`);
  }
  const input = Buffer.from(await data.arrayBuffer());
  const { buffer, width, height } = await normaliseImageBytes(input, profile);
  const outPath = deriveNormalisedPath(storagePath);
  const { error: upErr } = await service.storage
    .from(bucket)
    .upload(outPath, buffer, { contentType: "image/webp", upsert: true });
  if (upErr) throw new Error(`normalise: upload failed: ${upErr.message}`);
  return { path: outPath, url: buildPublicUrl(supabaseUrl, bucket, outPath), width, height };
}
