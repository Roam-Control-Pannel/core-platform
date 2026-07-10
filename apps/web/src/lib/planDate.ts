import { getFormatLocale } from "./i18n/runtime";

/** A friendly plan date label from an ISO instant — "Sat 12 Jul". Empty for unparseable. */
export function planDateLabel(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString(getFormatLocale(), { weekday: "short", day: "numeric", month: "short" });
}

/** An ISO instant → the YYYY-MM-DD value an <input type="date"> expects (local date). */
export function planDateInput(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
