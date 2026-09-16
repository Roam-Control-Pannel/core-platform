/**
 * The official FHRS badge artwork we ship (decision #6: self-hosted, unaltered FSA artwork).
 *
 * Keyed by the FSA rating key the API hands back as `badge.assetId` (@roam/core/fsa.officialBadge —
 * the server has already checked the key is one we ship AND agrees with the displayed rating). This
 * manifest is the WEB-side gate: an entry exists only for a file that is actually in
 * apps/web/public/fsa/, with the file's own intrinsic size so the sticker reserves its box before it
 * loads (no layout shift) and scales without distortion. A key with no entry — or a file that fails
 * to load — falls back to the in-house mark, so a page can never show a broken image.
 *
 * Provenance + terms: docs/fsa-hygiene-ratings.md ("Official badge artwork"). The files are the
 * FSA's, unmodified; do not edit, recolour or rename them.
 */

export interface FsaBadgeAsset {
  /** Public URL (served from apps/web/public). */
  src: string;
  /** Intrinsic pixel size of the file — read from the asset, never assumed. */
  width: number;
  height: number;
}

/** Filled in when the official pack lands — one entry per file under public/fsa/. Empty = fallback mark. */
export const FSA_BADGE_ASSETS: Readonly<Record<string, FsaBadgeAsset>> = {};

/** The shipped asset for an FSA rating key, or null when we don't hold one. */
export function fsaBadgeAsset(assetId: string | null | undefined): FsaBadgeAsset | null {
  if (!assetId) return null;
  return FSA_BADGE_ASSETS[assetId] ?? null;
}
