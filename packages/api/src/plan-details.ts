/**
 * Plan details — pure normalisation/validation for plans, kept out of the router so it's
 * unit-testable in isolation (same split as town-hall / profile-wall details).
 *
 * Validators THROW on invalid input (the router maps that to BAD_REQUEST).
 */

export const PLAN_TITLE_MAX = 120;
export const PLAN_NOTES_MAX = 2000;

/** A plan title: trimmed, single-spaced, 1..120 chars. */
export function normalisePlanTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length === 0) throw new Error("Give your plan a title.");
  if (t.length > PLAN_TITLE_MAX) throw new Error(`Keep the title under ${PLAN_TITLE_MAX} characters.`);
  return t;
}

/** Plan notes: trimmed (inner newlines kept). Empty → null. Throws only when over the bound. */
export function normalisePlanNotes(notes: string | null | undefined): string | null {
  if (notes == null) return null;
  const n = notes.trim();
  if (n.length === 0) return null;
  if (n.length > PLAN_NOTES_MAX) throw new Error(`Keep your notes under ${PLAN_NOTES_MAX} characters.`);
  return n;
}

/**
 * A planned-for timestamp: accept an ISO string or null. Returns the ISO string unchanged when
 * parseable, null when empty. Throws on an unparseable value.
 */
export function normalisePlannedFor(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error("That date couldn't be understood.");
  return value;
}
