/**
 * Profile-wall details — pure normalisation/validation for wall posts and comments, kept out
 * of the router so it is unit-testable in isolation (same split as town-hall / profile-details).
 *
 * Validators THROW on invalid input (the router maps that to BAD_REQUEST) and enforce the same
 * bounds the 0031 CHECK constraints do, so a bad value is rejected with a friendly message
 * before it reaches Postgres.
 */

export const WALL_BODY_MAX = 5000;
export const COMMENT_BODY_MAX = 3000;
export const MAX_WALL_MEDIA = 4;
/** @deprecated alias kept for callers; media is images + short video, capped together. */
export const MAX_WALL_IMAGES = MAX_WALL_MEDIA;

/** A media item on a wall post: an image or a short video, by public URL. */
export interface WallMediaItem {
  type: "image" | "video";
  url: string;
}

/** An http(s) URL — the public bucket URL an uploaded image resolves to. */
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A wall post body: trimmed (inner newlines kept). Empty → null (a media-only post is valid).
 * Throws only when it exceeds the length bound.
 */
export function normaliseWallBody(body: string | null | undefined): string | null {
  if (body == null) return null;
  const b = body.trim();
  if (b.length === 0) return null;
  if (b.length > WALL_BODY_MAX) throw new Error(`Keep your post under ${WALL_BODY_MAX} characters.`);
  return b;
}

/**
 * Validate the media array: each item must be an image with an http(s) url, capped at
 * MAX_WALL_IMAGES. Tolerant of an absent/empty value (returns []). Throws on a malformed item
 * or too many. The returned items are clean structural copies (no extra keys pass through).
 */
export function normaliseWallMedia(media: unknown): WallMediaItem[] {
  if (media == null) return [];
  if (!Array.isArray(media)) throw new Error("Invalid media.");
  if (media.length > MAX_WALL_MEDIA) throw new Error(`You can add up to ${MAX_WALL_MEDIA} items.`);
  return media.map((raw) => {
    const item = raw as { type?: unknown; url?: unknown };
    if ((item?.type !== "image" && item?.type !== "video") || !isHttpUrl(item.url)) {
      throw new Error("Each photo or video must have a valid URL.");
    }
    return { type: item.type, url: item.url };
  });
}

/** Ensure a post carries something: non-empty body OR at least one media item. */
export function assertPostNotEmpty(body: string | null, media: WallMediaItem[]): void {
  if ((body == null || body.length === 0) && media.length === 0) {
    throw new Error("Write something or add an image.");
  }
}

/** A comment body: trimmed, 1..3000 chars. */
export function normaliseCommentBody(body: string): string {
  const b = body.trim();
  if (b.length === 0) throw new Error("Write a comment first.");
  if (b.length > COMMENT_BODY_MAX) throw new Error(`Keep your comment under ${COMMENT_BODY_MAX} characters.`);
  return b;
}
