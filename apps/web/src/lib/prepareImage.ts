/**
 * prepareImage — the client-side image pipeline every upload surface funnels through
 * before bytes hit Storage. Raw camera files are 12–48MP and 3–8MB; serving those to every
 * reader is slow and uploading them trips bucket size caps. So, in the browser, before
 * upload: decode (EXIF orientation auto-fixed) → downscale to the slot's max dimension →
 * re-encode as WebP ~85%. A 6MB phone photo typically becomes 200–400KB.
 *
 * Deliberately forgiving: anything that can't be processed (undecodable file, canvas
 * export unsupported, re-encode came out BIGGER) falls back to the original file — the
 * existing per-surface type/size guards and the bucket's server-side limits still apply,
 * so the pipeline can only ever help, never block. GIFs pass through untouched (re-encoding
 * would freeze the animation; only the chat bucket accepts them).
 */

/** Where the image is headed — sets the longest-edge ceiling it is downscaled to. */
export type ImageSlot =
  | "avatar"
  | "header"
  | "plan-header"
  | "wall"
  | "post"
  | "product"
  | "listing"
  | "venue-photo"
  | "chat";

const MAX_EDGE: Record<ImageSlot, number> = {
  avatar: 800, // rendered ≤160px; 800 leaves retina + future headroom
  header: 2000, // full-bleed banners
  "plan-header": 2000,
  wall: 1600, // in-feed photos render ≤760px columns
  post: 1600,
  product: 1600,
  listing: 1600,
  "venue-photo": 2000, // venue galleries go near-full-bleed
  chat: 1600,
};

const WEBP_QUALITY = 0.85;
/** Already small and needs no resize → not worth a lossy re-encode. */
const PASS_THROUGH_BYTES = 500 * 1024;

/** Decode with EXIF orientation applied; null when the browser can't decode this file. */
async function decode(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    try {
      return await createImageBitmap(file); // older engines without the options bag
    } catch {
      return null;
    }
  }
}

async function encode(bitmap: ImageBitmap, width: number, height: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    try {
      return await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
    } catch {
      return await canvas.convertToBlob({ type: "image/jpeg", quality: WEBP_QUALITY });
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", WEBP_QUALITY));
  if (blob && blob.type === "image/webp") return blob;
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", WEBP_QUALITY));
}

/**
 * Downscale + re-encode `file` for its destination slot. Returns the original file whenever
 * processing isn't possible or wouldn't help. Never throws.
 */
export async function prepareImage(file: File, slot: ImageSlot): Promise<File> {
  if (file.type === "image/gif" || file.type === "image/svg+xml") return file;

  const bitmap = await decode(file);
  if (!bitmap) return file;

  try {
    const maxEdge = MAX_EDGE[slot];
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= PASS_THROUGH_BYTES) return file;

    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const blob = await encode(bitmap, width, height);
    if (!blob || blob.size >= file.size) return file; // re-encode didn't help (e.g. tiny flat PNG)

    const ext = blob.type === "image/webp" ? "webp" : "jpg";
    const base = file.name.replace(/\.[a-z0-9]+$/i, "") || "image";
    return new File([blob], `${base}.${ext}`, { type: blob.type });
  } finally {
    bitmap.close();
  }
}
