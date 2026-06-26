/**
 * Local mirror of @roam/core/hours `isOpenNow` (+ the two pure helpers it needs).
 *
 * This file deliberately does NOT import @roam/core: core is a Node-ESM package whose
 * .js-suffix import resolution breaks under Turbopack's browser bundling, which is why
 * @roam/core is not a dependency of @roam/web (see lib/venuePhotos.ts, lib/categories.ts,
 * and the VenueCard formatDistance mirror for the same boundary). The canonical, unit-
 * tested implementation lives in packages/core/src/hours/index.ts; this is a faithful
 * browser-side copy of ONLY the read evaluator the "Open now" pill needs — not the write
 * validators (those run server-side in the api and never reach the browser).
 *
 * Keep in lockstep with the core source: if the core evaluator changes, change here too.
 * The logic is pure (no state, no I/O beyond Intl for timezone), so the copy is small and
 * stable. Boundaries: open inclusive, close exclusive (a 17:00 close means 16:59 open,
 * 17:00 closed). Returns status 'unknown' for venues without structured periods (legacy
 * Places string-only hours), so the caller renders no pill in that case.
 */

const MINUTES_IN_DAY = 24 * 60;

/** One day's structured hours (0=Mon … 6=Sun). Mirrors @roam/core/hours DayPeriods. */
export interface DayPeriods {
  day: number;
  closed: boolean;
  intervals: { open: string; close: string }[];
}

/** Either opening-hours shape as read from the venue's opening_times. */
export interface OpeningTimesRead {
  weekdayDescriptions?: string[];
  periods?: DayPeriods[];
  timezone?: string;
  source?: string;
}

export interface OpenState {
  status: "open" | "closed" | "unknown";
  nextChange?: { at: string; day: number; inMinutes: number };
}

/** Parse "HH:MM" → minutes since midnight. Throws RangeError on malformed input. */
function parseHhmm(value: string): number {
  if (typeof value !== "string") throw new RangeError("Time must be a string in HH:MM form.");
  const m = /^([0-9]{2}):([0-9]{2})$/.exec(value);
  if (!m) throw new RangeError(`Time "${value}" must be in HH:MM (24-hour) form.`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new RangeError(`Time "${value}" is out of range.`);
  return hh * 60 + mm;
}

/** Is `tz` a valid IANA timezone the runtime understands? Uses Intl (DST-correct). */
function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** {weekday 0..6 Monday-first, minutes-since-midnight} for an instant in a timezone. */
function localDayAndMinutes(nowUtc: Date, timezone: string): { day: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(nowUtc);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  let hourStr = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minStr = parts.find((p) => p.type === "minute")?.value ?? "00";
  if (hourStr === "24") hourStr = "00";
  const shortToIdx: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  const day = shortToIdx[wd] ?? 0;
  const minutes = Number(hourStr) * 60 + Number(minStr);
  return { day, minutes };
}

/** Is the venue open at `nowUtc`? 'unknown' for legacy string-only hours (no pill). */
export function isOpenNow(opening: OpeningTimesRead | null | undefined, nowUtc: Date): OpenState {
  if (
    opening == null ||
    !Array.isArray(opening.periods) ||
    typeof opening.timezone !== "string" ||
    !isValidTimezone(opening.timezone)
  ) {
    return { status: "unknown" };
  }

  const { day, minutes } = localDayAndMinutes(nowUtc, opening.timezone);

  // Defensive boundary unique to this browser copy: core validates interval strings on
  // WRITE, but this evaluator runs inside render and reads whatever is stored — including
  // legacy / imported rows that never passed the write validator. A malformed "HH:MM"
  // (the only thing parseHhmm throws on) must degrade to "unknown" (no pill), never throw
  // and take down the venue page render. Core has no try/catch here because core never
  // sees unvalidated data; we do, so we harden here and stay in lockstep on everything else.
  try {
    const today = opening.periods.find((p) => p.day === day);

    if (today && !today.closed) {
      for (const iv of today.intervals) {
        const openMin = parseHhmm(iv.open);
        const closeMin = parseHhmm(iv.close);
        if (minutes >= openMin && minutes < closeMin) {
          return { status: "open", nextChange: { at: iv.close, day, inMinutes: closeMin - minutes } };
        }
      }
    }

    for (let ahead = 0; ahead < 7; ahead++) {
      const d = (day + ahead) % 7;
      const p = opening.periods.find((x) => x.day === d);
      if (!p || p.closed) continue;
      for (const iv of p.intervals) {
        const openMin = parseHhmm(iv.open);
        if (ahead === 0 && openMin <= minutes) continue;
        const inMinutes = ahead * MINUTES_IN_DAY + openMin - minutes;
        return { status: "closed", nextChange: { at: iv.open, day: d, inMinutes } };
      }
    }

    return { status: "closed" };
  } catch {
    return { status: "unknown" };
  }
}
