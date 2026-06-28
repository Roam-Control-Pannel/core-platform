/**
 * Town Hall web helpers — tiny pure presenters shared by the board and topic surfaces.
 * Author identity comes embedded from profiles; these render it safely (a deleted author
 * degrades to "Someone") and format timestamps as a calm relative label.
 */

export interface TownHallAuthor {
  id: string | null;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

/** A display name for an author: display name → @handle → "Someone" (author may be deleted). */
export function townHallAuthor(author: TownHallAuthor | null | undefined): string {
  if (!author) return "Someone";
  if (author.displayName && author.displayName.trim()) return author.displayName.trim();
  if (author.handle && author.handle.trim()) return `@${author.handle.trim()}`;
  return "Someone";
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
 */
export function timeAgo(iso: string, now: Date = new Date()): string {
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
  const d = new Date(then);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
