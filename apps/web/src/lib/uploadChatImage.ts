/**
 * Upload a chat photo to the PRIVATE `chat-media` bucket, and sign URLs to render one.
 *
 * The object path is `{threadId}/{uuid}.ext`: migration 0058's storage RLS authorises the write
 * (and later the signed-url read) only when the caller is a participant of the thread named by the
 * first path segment. The bucket is private, so there is no public URL — the image message's
 * payload stores the PATH, and each render mints a short-lived signed URL via chatMediaSignedUrl().
 *
 * Client-side type/size guards give fast feedback; Storage re-enforces them at the edge (the
 * bucket's allowed_mime_types + file_size_limit), so these are UX, not the security gate.
 */
import { getSupabaseBrowser } from "./supabase";

const CHAT_MEDIA_BUCKET = "chat-media";
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — matches the bucket file_size_limit.

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export interface ChatImageUpload {
  path: string;
  width: number | null;
  height: number | null;
  mime: string;
}

/** Read an image's natural dimensions client-side (best-effort; nulls if it can't decode). */
async function readDimensions(file: File): Promise<{ width: number | null; height: number | null }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth || null, height: img.naturalHeight || null });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: null, height: null });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

/**
 * Validate + upload one chat photo for a thread. Throws an Error with a human message on a bad
 * type/size or failed upload. Returns the payload fields for an `image` message (path + dims + mime).
 */
export async function uploadChatImage(threadId: string, file: File): Promise<ChatImageUpload> {
  if (!(ALLOWED_MIME as readonly string[]).includes(file.type)) {
    throw new Error("Please pick a JPEG, PNG, WebP or GIF image.");
  }
  if (file.size > MAX_BYTES) {
    throw new Error("That image is over 10 MB. Please pick a smaller one.");
  }

  const ext = EXT_BY_MIME[file.type] ?? "jpg";
  // First path segment MUST be the thread id (0058 storage RLS reads it from the path).
  const path = `${threadId}/${crypto.randomUUID()}.${ext}`;
  const { width, height } = await readDimensions(file);

  const supabase = getSupabaseBrowser();
  const { error } = await supabase.storage
    .from(CHAT_MEDIA_BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
  if (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }

  return { path, width, height, mime: file.type };
}

/** Mint a short-lived signed URL for a chat photo (the bucket is private). Null on failure. */
export async function chatMediaSignedUrl(path: string, expiresIn = 3600): Promise<string | null> {
  const supabase = getSupabaseBrowser();
  const { data, error } = await supabase.storage.from(CHAT_MEDIA_BUCKET).createSignedUrl(path, expiresIn);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
