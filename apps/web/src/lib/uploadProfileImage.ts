/**
 * Upload a profile image (avatar / header) to the public `profile-media` bucket and return
 * its stable public URL — the profile twin of OwnerMediaManager's venue-photo upload.
 *
 * The object path is `{userId}/{uuid}.ext`: migration 0027's storage RLS authorises the write
 * only when the first path segment equals auth.uid(), so a signed-in user can only write under
 * their own folder. The bucket is public, so the returned URL is stable + CDN-cacheable and is
 * what we persist in profiles.avatar_url / header_url (validated http(s) by the API).
 *
 * Client-side type/size guards give fast feedback; Storage re-enforces them at the edge
 * (the bucket's allowed_mime_types + file_size_limit), so this is UX, not the security gate.
 */
import { getSupabaseBrowser } from "./supabase";

const PROFILE_MEDIA_BUCKET = "profile-media";
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — matches the bucket file_size_limit.

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface UploadResult {
  /** The public URL to store in profiles.avatar_url / header_url. */
  url: string;
  /** The storage object path (kept in case a later cleanup wants to remove the old object). */
  path: string;
}

/**
 * Validate + upload one image for the given user. Throws an Error with a human message on a
 * bad type/size or a failed upload (the caller shows it inline). `kind` only scopes the path
 * ("avatar" / "header") so the two don't collide and are easy to spot in the bucket.
 */
export async function uploadProfileImage(
  userId: string,
  file: File,
  kind: "avatar" | "header" | "wall" | "plan-header",
): Promise<UploadResult> {
  if (!(ALLOWED_MIME as readonly string[]).includes(file.type)) {
    throw new Error("Please pick a JPEG, PNG or WebP image.");
  }
  if (file.size > MAX_BYTES) {
    throw new Error("That image is over 5 MB. Please pick a smaller one.");
  }

  const ext = EXT_BY_MIME[file.type] ?? "jpg";
  // First path segment MUST be the user id (0027 storage RLS reads it from the path).
  const path = `${userId}/${kind}-${crypto.randomUUID()}.${ext}`;

  const supabase = getSupabaseBrowser();
  const { error } = await supabase.storage
    .from(PROFILE_MEDIA_BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
  if (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(PROFILE_MEDIA_BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) {
    throw new Error("Upload succeeded but no public URL was returned.");
  }
  return { url: data.publicUrl, path };
}

const ALLOWED_VIDEO_MIME = ["video/mp4", "video/webm", "video/quicktime"] as const;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB — matches the bucket ceiling (0034).
const VIDEO_EXT_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

/**
 * Upload one short wall VIDEO to the profile-media bucket (under the caller's folder, per the
 * 0027 RLS). Validates type/size client-side for fast feedback; Storage re-enforces at the edge
 * (0034 allowed_mime_types + file_size_limit). Returns the stable public URL.
 */
export async function uploadWallVideo(userId: string, file: File): Promise<UploadResult> {
  if (!(ALLOWED_VIDEO_MIME as readonly string[]).includes(file.type)) {
    throw new Error("Please pick an MP4, WebM or MOV video.");
  }
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error("That video is over 50 MB. Please pick a shorter one.");
  }
  const ext = VIDEO_EXT_BY_MIME[file.type] ?? "mp4";
  const path = `${userId}/wall-video-${crypto.randomUUID()}.${ext}`;

  const supabase = getSupabaseBrowser();
  const { error } = await supabase.storage
    .from(PROFILE_MEDIA_BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
  if (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }
  const { data } = supabase.storage.from(PROFILE_MEDIA_BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) {
    throw new Error("Upload succeeded but no public URL was returned.");
  }
  return { url: data.publicUrl, path };
}
