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
 * FSA's online artwork pack, byte-for-byte as supplied (JPEG, 150 dpi); do not edit, recolour,
 * re-encode or rename them. Sizes below were read from the files, not assumed:
 * the six score stickers are 1152×804, the "Awaiting inspection" banner is 1152×591.
 */

export interface FsaBadgeAsset {
  /** Public URL (served from apps/web/public). */
  src: string;
  /** Intrinsic pixel size of the file — read from the asset, never assumed. */
  width: number;
  height: number;
}

const score = (n: 0 | 1 | 2 | 3 | 4 | 5): [string, FsaBadgeAsset] => [
  `fhrs_${n}_en-gb`,
  { src: `/fsa/fhrs_${n}_en-gb.jpg`, width: 1152, height: 804 },
];

/** One entry per file under public/fsa/. No "exempt" — the FSA pack ships no sticker for it. */
export const FSA_BADGE_ASSETS: Readonly<Record<string, FsaBadgeAsset>> = Object.fromEntries([
  score(0),
  score(1),
  score(2),
  score(3),
  score(4),
  score(5),
  ["fhrs_awaitinginspection_en-gb", { src: "/fsa/fhrs_awaitinginspection_en-gb.jpg", width: 1152, height: 591 }],
]);

/** The shipped asset for an FSA rating key, or null when we don't hold one. */
export function fsaBadgeAsset(assetId: string | null | undefined): FsaBadgeAsset | null {
  if (!assetId) return null;
  return FSA_BADGE_ASSETS[assetId] ?? null;
}
