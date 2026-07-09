/**
 * Hashtag rendering — turns #tags in user text into recognisable, tappable links (the
 * Instagram/LinkedIn convention), pointing at the tag feed /tags/{tag}. What counts as a
 * tag is defined ONCE in @roam/core/hashtags (shared with the API's tag-feed matching).
 *
 * Two modes because cards differ:
 *  - links (default): real <Link>s — for standalone bodies (topic pages, wall posts).
 *  - links: false — styled <span>s only, for teaser text that sits INSIDE a card-wide
 *    link (feed cards); a nested <a> is invalid HTML and breaks hydration, so there the
 *    tag is highlighted but the card keeps its single destination.
 *
 * Pure (no hooks) so it works in server components (e.g. the Town Hall hub) too.
 */
import type React from "react";
import Link from "next/link";

/* The tag definition — MUST stay in lockstep with packages/core/src/hashtags/index.ts
   (the API's matching). Duplicated rather than imported: pulling the @roam/core barrel
   into the web bundle drags in Node-only modules (push, geocode). */
function hashtagRe(): RegExp {
  return /(?<![\p{L}\p{N}_#])#([\p{L}\p{N}_]{2,50})(?![\p{L}\p{N}_])/gu;
}
function normalizeTag(raw: string): string {
  return raw.replace(/^#/, "").toLowerCase();
}

const tagStyle: React.CSSProperties = {
  color: "var(--crimson-700)",
  fontWeight: 600,
  textDecoration: "none",
};

export function linkifyHashtags(
  text: string | null | undefined,
  opts: { links?: boolean } = {},
): React.ReactNode {
  if (!text) return text ?? null;
  const links = opts.links !== false;
  const re = hashtagRe();
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const raw = m[0];
    const tag = normalizeTag(m[1] ?? "");
    out.push(
      links ? (
        <Link key={`${m.index}-${tag}`} href={`/tags/${encodeURIComponent(tag)}`} style={tagStyle}>
          {raw}
        </Link>
      ) : (
        <span key={`${m.index}-${tag}`} style={tagStyle}>
          {raw}
        </span>
      ),
    );
    last = m.index + raw.length;
  }
  if (out.length === 0) return text; // no tags — hand back the plain string untouched
  if (last < text.length) out.push(text.slice(last));
  return out;
}
