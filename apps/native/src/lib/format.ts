/**
 * Presentation helpers for the native surface — the RN counterparts of web's
 * lib/townHall.ts and lib/planDate.ts.
 *
 * Deliberately pure and dependency-free: same output shapes as web ("just now", "5m",
 * "3h", "Sat 12 Jul"), so the two surfaces read identically. Web routes its wording
 * through next-intl catalogues; native has no i18n stack yet, so the strings are the
 * English catalogue's values inline. When native gets a catalogue these become lookups.
 *
 * Every function is tolerant of bad input — an unparseable timestamp returns "" rather
 * than throwing into a list row.
 */

export interface Author {
  id: string | null;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

/** A display name for an author: display name → @handle → "Someone" (author may be deleted). */
export function authorName(author: Author | null | undefined): string {
  if (!author) return "Someone";
  if (author.displayName && author.displayName.trim()) return author.displayName.trim();
  if (author.handle && author.handle.trim()) return `@${author.handle.trim()}`;
  return "Someone";
}

/** A 1-char initial for an avatar bubble, from the best available name. */
export function initial(name: string | null | undefined): string {
  return (name ?? "").trim().replace(/^@/, "").charAt(0).toUpperCase() || "·";
}

/** A calm relative time label: "just now", "5m", "3h", "2d", else a short date. */
export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** A plan's date as the compact label the plan cards show ("Sat 12 Jul"). */
export function planDateLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * The header's date kicker — "MONDAY · 6 JULY · 14:31", uppercased for the mono eyebrow,
 * exactly as web's Home builds it. Takes `now` so the caller (a ticking effect) owns the clock.
 */
export function dateKicker(now: Date = new Date()): string {
  const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
  const dayMonth = now.toLocaleDateString(undefined, { day: "numeric", month: "long" });
  const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${weekday} · ${dayMonth} · ${time}`.toUpperCase();
}

/** Time-aware greeting — the warmer header web's Home uses instead of a flat "Home". */
export function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** "1 reply" / "3 replies" — the plural forms web gets from its ICU catalogue. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Compact rating count for a venue card: 1240 → "1.2k", 980 → "980". */
export function formatRatingCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/**
 * Google price-level enum → a currency-glyph run. Null/unspecified is filtered upstream by
 * core's normalizePriceLevel, so this only ever sees a meaningful level; anything it doesn't
 * recognise returns null rather than a guess. "Free" is the one worded label.
 */
const PRICE_LEVELS: Record<string, string> = {
  PRICE_LEVEL_FREE: "Free",
  PRICE_LEVEL_INEXPENSIVE: "£",
  PRICE_LEVEL_MODERATE: "££",
  PRICE_LEVEL_EXPENSIVE: "£££",
  PRICE_LEVEL_VERY_EXPENSIVE: "££££",
};

export function priceLevelLabel(level: string | null | undefined): string | null {
  if (!level) return null;
  return PRICE_LEVELS[level] ?? null;
}
