/**
 * Events — client/server display helpers for the what's-on surfaces. Pure formatting only; the
 * data comes from the events tRPC router (0099). The category vocabulary mirrors the API/DB set.
 */

/** The event category ids (wire values) → i18n label keys under the `events.categories.*` namespace. */
export const EVENT_CATEGORIES: { id: string; labelKey: string }[] = [
  { id: "music", labelKey: "music" },
  { id: "nightlife", labelKey: "nightlife" },
  { id: "food_drink", labelKey: "foodDrink" },
  { id: "arts_culture", labelKey: "artsCulture" },
  { id: "sports_fitness", labelKey: "sportsFitness" },
  { id: "community", labelKey: "community" },
  { id: "market_fair", labelKey: "marketFair" },
  { id: "family", labelKey: "family" },
  { id: "learning", labelKey: "learning" },
  { id: "other", labelKey: "other" },
];

const CATEGORY_KEY = new Map(EVENT_CATEGORIES.map((c) => [c.id, c.labelKey]));

/** The label key for a category id, or null if it isn't one we know. */
export function eventCategoryKey(id: string | null): string | null {
  return id ? CATEGORY_KEY.get(id) ?? null : null;
}

/** True while the event hasn't ended yet (or, with no end, hasn't started), relative to `now`. */
export function isUpcoming(startsAt: string, endsAt: string | null, now: number = Date.now()): boolean {
  const end = endsAt ? new Date(endsAt).getTime() : new Date(startsAt).getTime();
  return !Number.isNaN(end) && end >= now;
}

/**
 * Human "when" line for an event: "Sat 1 Aug, 7:00–10:00 PM" (same day) or a start-only
 * "Sat 1 Aug, 7:00 PM" when there's no end / it spans days. Locale-aware via Intl.
 */
export function formatEventWhen(startsAt: string, endsAt: string | null, locale = "en-GB"): string {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return "";
  const dateFmt = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" });
  const timeFmt = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
  const datePart = dateFmt.format(start);
  const startTime = timeFmt.format(start);
  if (!endsAt) return `${datePart}, ${startTime}`;
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) return `${datePart}, ${startTime}`;
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) return `${datePart}, ${startTime}–${timeFmt.format(end)}`;
  return `${datePart}, ${startTime} — ${dateFmt.format(end)}, ${timeFmt.format(end)}`;
}

/** Short date badge parts for a card corner: { day: "1", month: "AUG" }. */
export function eventDateBadge(startsAt: string, locale = "en-GB"): { day: string; month: string } {
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return { day: "", month: "" };
  return {
    day: new Intl.DateTimeFormat(locale, { day: "numeric" }).format(d),
    month: new Intl.DateTimeFormat(locale, { month: "short" }).format(d).toUpperCase(),
  };
}
