/**
 * Awin affiliate links (web).
 *
 * An Awin tracking link is a pure URL template — no API call, no secret. The publisher id
 * (`awinaffid`) is PUBLIC (it appears in every affiliate link), so it ships in the client bundle
 * via NEXT_PUBLIC_AWIN_PUBLISHER_ID. We wrap a deal's destination URL at render time so the id
 * lives in exactly one place and the API never has to store per-surface links.
 *
 *   https://www.awin1.com/cread.php?awinmid={advertiserId}&awinaffid={publisherId}
 *          &clickref={ref}&ued={encodedDestinationUrl}
 *
 * Degrades gracefully: with no publisher id configured (e.g. local dev) we return the plain
 * destination URL, so a deal is still clickable — just untracked.
 */

const AWIN_BASE = "https://www.awin1.com/cread.php";

/** The public publisher id, or null when unconfigured (feature stays untracked, links still work). */
export function awinPublisherId(): string | null {
  const id = process.env.NEXT_PUBLIC_AWIN_PUBLISHER_ID;
  return id && id.trim() ? id.trim() : null;
}

/** True when affiliate tracking is configured (a publisher id is present). */
export function awinEnabled(): boolean {
  return awinPublisherId() !== null;
}

/**
 * Build an Awin-tracked click-through for a deal. `clickRef` is an optional sub-id for attribution
 * (e.g. the surface: "home" | "deals"). Returns the plain destination URL when no publisher id is
 * set, or when the destination isn't a valid http(s) URL, so the CTA is always safe to render.
 */
export function buildAwinLink(opts: {
  advertiserId: string;
  destinationUrl: string;
  clickRef?: string;
}): string {
  const { advertiserId, destinationUrl, clickRef } = opts;
  const publisherId = awinPublisherId();
  // Already an Awin tracking link (e.g. an offer stored its pre-tracked url) — never double-wrap.
  if (/awin1\.com\/(cread|awclick)/i.test(destinationUrl)) return destinationUrl;
  if (!publisherId || !advertiserId || !/^https?:\/\//i.test(destinationUrl)) return destinationUrl;
  const params = new URLSearchParams({
    awinmid: advertiserId,
    awinaffid: publisherId,
    ued: destinationUrl,
  });
  if (clickRef) params.set("clickref", clickRef.slice(0, 100));
  return `${AWIN_BASE}?${params.toString()}`;
}
