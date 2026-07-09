/**
 * Hashtags — the single definition of what counts as a #tag on Roam, shared by the API (the web app keeps a lockstep copy in apps/web/src/lib/hashtags.tsx — the core barrel cannot be bundled client-side)
 * (finding tagged content for /tags/{tag}) and the web app (linkifying tags in rendered
 * text). Pure, no I/O.
 *
 * A tag is `#` followed by 2–50 word characters (unicode letters, digits, underscore),
 * not glued to a preceding word ("price#deal" is not a tag, "#deal" and "(#deal)" are).
 * Tags are case-insensitive; the canonical form is lowercase.
 */

/** Matcher for tags in running text. Fresh instance per call — the `g` flag is stateful. */
export function hashtagRe(): RegExp {
  return /(?<![\p{L}\p{N}_#])#([\p{L}\p{N}_]{2,50})(?![\p{L}\p{N}_])/gu;
}

/** Canonical (lowercase) form of a raw tag, without the leading #. */
export function normalizeTag(raw: string): string {
  return raw.replace(/^#/, "").toLowerCase();
}

/** Every distinct tag in a text, canonical form, in order of first appearance. */
export function extractHashtags(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(hashtagRe())) {
    const tag = normalizeTag(m[1] ?? "");
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/**
 * Whether the text carries EXACTLY this tag (word-boundary correct: "#newcastle" does not
 * match "#newcastleupon"). Used to verify candidates found by a broad ILIKE '%#tag%'.
 */
export function hasHashtag(text: string | null | undefined, tag: string): boolean {
  if (!text) return false;
  const want = normalizeTag(tag);
  return extractHashtags(text).includes(want);
}
