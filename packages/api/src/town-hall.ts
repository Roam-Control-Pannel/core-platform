/**
 * Town Hall details — pure normalisation/validation for the forum, kept out of the router so
 * it is unit-testable in isolation (same split as profile-details / venue-details).
 *
 * The API is the single authority for the locality SLUG: the web sends the place NAME it is
 * browsing ("Darlington", "Stockton-on-Tees", a postcode) and the slug is derived here, so a
 * topic created from a saved place and one listed from a search result land on the same board.
 *
 * Validators THROW on invalid input (the router maps that to a BAD_REQUEST), mirroring
 * profile-details. They also enforce the same bounds the 0030 CHECK constraints do, so a bad
 * value is rejected with a friendly message before it ever reaches Postgres.
 */

/** Max lengths — kept in lockstep with the CHECK constraints in 0030_town_hall.sql. */
export const TOPIC_TITLE_MAX = 140;
export const TOPIC_BODY_MAX = 8000;
export const REPLY_BODY_MAX = 8000;

/**
 * Slugify a place name into a stable locality key: lower-case, ASCII-fold the obvious cases,
 * collapse any run of non-alphanumerics to a single hyphen, trim hyphens. "Stockton-on-Tees"
 * → "stockton-on-tees"; "DH1 1AA" → "dh1-1aa". Throws if nothing usable remains.
 */
export function localitySlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("That place can't be used for a Town Hall board.");
  return slug;
}

/** The display label stored alongside the slug — the name trimmed, never empty. */
export function localityLabel(name: string): string {
  const label = name.replace(/\s+/g, " ").trim();
  if (!label) throw new Error("That place name is empty.");
  return label.slice(0, 120);
}

/** A topic title: trimmed, single-spaced, 1..140 chars. */
export function normaliseTopicTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length === 0) throw new Error("Give your topic a title.");
  if (t.length > TOPIC_TITLE_MAX) throw new Error(`Keep the title under ${TOPIC_TITLE_MAX} characters.`);
  return t;
}

/** A topic body: trimmed (inner newlines kept), 1..8000 chars. */
export function normaliseTopicBody(body: string): string {
  const b = body.trim();
  if (b.length === 0) throw new Error("Add some detail to your topic.");
  if (b.length > TOPIC_BODY_MAX) throw new Error(`Keep your topic under ${TOPIC_BODY_MAX} characters.`);
  return b;
}

/** A reply body: trimmed, 1..8000 chars. */
export function normaliseReplyBody(body: string): string {
  const b = body.trim();
  if (b.length === 0) throw new Error("Write a reply first.");
  if (b.length > REPLY_BODY_MAX) throw new Error(`Keep your reply under ${REPLY_BODY_MAX} characters.`);
  return b;
}
