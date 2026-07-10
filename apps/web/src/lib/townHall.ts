/**
 * Town Hall web helpers — tiny pure presenters shared by the board and topic surfaces.
 * Author identity comes embedded from profiles; these render it safely (a deleted author
 * degrades to "Someone") and format timestamps as a calm relative label.
 */

import { getFormatLocale, runtimeStrings } from "./i18n/runtime";

export interface TownHallAuthor {
  id: string | null;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

/** A display name for an author: display name → @handle → "Someone" (author may be deleted). */
export function townHallAuthor(author: TownHallAuthor | null | undefined): string {
  if (!author) return runtimeStrings().someone;
  if (author.displayName && author.displayName.trim()) return author.displayName.trim();
  if (author.handle && author.handle.trim()) return `@${author.handle.trim()}`;
  return runtimeStrings().someone;
}

/** A 1–2 char initial for an avatar bubble, from the best available name. */
export function authorInitial(author: TownHallAuthor | null | undefined): string {
  const name = townHallAuthor(author);
  const ch = name.replace(/^@/, "").trim().charAt(0);
  return ch ? ch.toUpperCase() : "·";
}

/**
 * A calm relative time label from an ISO timestamp: "just now", "5m", "3h", "2d", else a date.
 * Tolerant: returns "" for an unparseable input rather than throwing into the UI.
 *
 * Locale-aware via lib/i18n/runtime: the words come from the active catalogue's compact
 * duration templates and the date fallback formats in the active locale. English output is
 * byte-identical to the original hardcoded version.
 */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const t = runtimeStrings();
  const unit = (template: string, n: number) => template.replace("{n}", String(n));
  const secs = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (secs < 45) return t.justNow;
  const mins = Math.round(secs / 60);
  if (mins < 60) return unit(t.minutes, mins);
  const hours = Math.round(mins / 60);
  if (hours < 24) return unit(t.hours, hours);
  const days = Math.round(hours / 24);
  if (days < 7) return unit(t.days, days);
  const d = new Date(then);
  return d.toLocaleDateString(getFormatLocale(), { day: "numeric", month: "short" });
}
