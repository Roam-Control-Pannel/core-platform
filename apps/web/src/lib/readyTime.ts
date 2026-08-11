/**
 * Formatting for an order's collection ready-at (Food to Go, Phase 3).
 *
 * A static "ready by <clock>" reads clearly and needs no live ticking (unlike a countdown). Uses
 * the app's formatting locale so the clock matches everything else (en-GB by default; see
 * lib/i18n/runtime).
 */
import { getFormatLocale } from "./i18n/runtime";

/** "7:45 pm" / "19:45" — the ready-at as a wall-clock time in the active formatting locale. */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(getFormatLocale(), { hour: "2-digit", minute: "2-digit" });
}
