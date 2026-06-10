/**
 * Canonical app route paths. One definition per route, so a path can never drift
 * between the surfaces that link to it and the server-side push dispatch that deep-links
 * into it. (This replaces the hand-typed `/venues/${id}` literal in posts.create that
 * pointed at a non-existent plural route — the singular `/venue/[id]` is the real page.)
 *
 * Pure string builders, no I/O — framework-agnostic route knowledge, which is exactly
 * what core is for. The web Link call sites can migrate onto these in a follow-up; the
 * push dispatch (Node, already imports core) uses venuePath now.
 */

/** The web deep-link path for a venue's detail page. Matches apps/web/src/app/venue/[id]. */
export function venuePath(venueId: string): string {
  return `/venue/${venueId}`;
}
