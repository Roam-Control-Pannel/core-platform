/**
 * @roam/core/hours — venue opening-hours domain: the structured shape, the shared time
 * primitives, and the "open now" read evaluator.
 *
 * Platform-agnostic and source-agnostic: this is about a VENUE's hours, regardless of
 * whether they came from Google Places (free-text weekdayDescriptions) or an owner edit
 * (structured periods). It is a peer of `places` (which is specifically about Places
 * ingestion), not part of it. `places` imports `DayPeriods` from here to widen its
 * `OpeningTimes` type; nothing here imports `places` (no cycle).
 *
 * The WRITE side — validating + normalising + deriving an owner's raw hours input — lives
 * in packages/api/src/venue-hours.ts, because only the api mutation needs it. This module
 * is everything BOTH the api (write path) and the web/native (read path) share: the types,
 * the time helpers, and the evaluator the public OpeningHours reader calls for its
 * "Open now" pill.
 *
 * ── Deliberate scope (seam open, feature deferred) ────────────────────────────────────
 * Overnight intervals (close crossing midnight) are not accepted by the WRITE validator
 * yet (api/venue-hours.ts enforces open < close). The shape and isOpenNow here are written
 * so lifting that later is a validator-only change — no shape change, no reader rewrite.
 */

/** Minutes in a day; the module works in minutes-since-midnight to keep time math exact
 *  and Date-parsing-free. */
const MINUTES_IN_DAY = 24 * 60;

/** Hard caps — shared by the write validator (api) and any read consumer. */
export const VENUE_HOURS_LIMITS = {
  /** Mon..Sun — exactly 7 day slots, indexed 0=Monday. */
  days: 7,
  /** Split shifts: at most this many open intervals on one day. */
  maxIntervalsPerDay: 3,
} as const;

/** Day index convention: 0=Monday … 6=Sunday (British, Monday-first — matches the order
 *  Places emits weekdayDescriptions in for this region, so derivation aligns). */
export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/** A single open interval within a day. open/close are "HH:MM" 24h, open < close. */
export interface HoursInterval {
  open: string; // "HH:MM"
  close: string; // "HH:MM"
}

/** One day's hours. closed:true => intervals empty. day is 0=Mon … 6=Sun. */
export interface DayPeriods {
  day: number;
  closed: boolean;
  intervals: HoursInterval[];
}

/** Either opening-hours shape, as read back from the venue's opening_times column. The
 *  legacy Places shape has only weekdayDescriptions + source; the owner shape adds
 *  periods + timezone. (The canonical type is `places.OpeningTimes`, widened to carry
 *  these; this read-tolerant interface is what the evaluator accepts.) */
export interface OpeningTimesRead {
  weekdayDescriptions?: string[];
  periods?: DayPeriods[];
  timezone?: string;
  source?: string;
}

/* ─────────────────────────────────────────────────────────────────────────────────────
 * Time primitives (pure, minutes-based) — shared by the write validator and the reader
 * ──────────────────────────────────────────────────────────────────────────────────── */

/** Parse "HH:MM" → minutes since midnight. Throws RangeError on malformed input. Accepts
 *  only zero-padded 24h "HH:MM", HH 00..23, MM 00..59. "24:00" is rejected (a day-end of
 *  midnight is expressed by the next day) so the overnight seam stays a single future
 *  change site. */
export function parseHhmm(value: string): number {
  if (typeof value !== "string") {
    throw new RangeError("Time must be a string in HH:MM form.");
  }
  const m = /^([0-9]{2}):([0-9]{2})$/.exec(value);
  if (!m) {
    throw new RangeError(`Time "${value}" must be in HH:MM (24-hour) form.`);
  }
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) {
    throw new RangeError(`Time "${value}" is out of range.`);
  }
  return hh * 60 + mm;
}

/** minutes since midnight → "HH:MM" (zero-padded). */
export function formatHhmm(minutes: number): string {
  const safe = ((minutes % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const hh = Math.floor(safe / 60);
  const mm = safe % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** minutes since midnight → 12h display "8:00 AM" / "10:30 PM" — matches the Places
 *  weekdayDescriptions style so derived strings render identically to Google's. */
export function formatHhmm12(minutes: number): string {
  const safe = ((minutes % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const hh24 = Math.floor(safe / 60);
  const mm = safe % 60;
  const period = hh24 < 12 ? "AM" : "PM";
  let hh12 = hh24 % 12;
  if (hh12 === 0) hh12 = 12;
  return `${hh12}:${String(mm).padStart(2, "0")} ${period}`;
}

/** Is `tz` a valid IANA timezone the runtime understands? Uses Intl — no external dep,
 *  correct across DST. Validated rather than trusted so isOpenNow can never be handed a
 *  tz it would silently mis-evaluate. */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────────────
 * "Open now" evaluator (the READ contract) — used by web/native OpeningHours
 * ──────────────────────────────────────────────────────────────────────────────────── */

export interface OpenState {
  /** "unknown" when the venue has no structured periods (legacy Places string-only) —
   *  the UI shows no pill in that case. */
  status: "open" | "closed" | "unknown";
  /** For status "open": when it next closes. For "closed": when it next opens. */
  nextChange?: {
    /** "HH:MM" local time of the change. */
    at: string;
    /** 0=Monday … 6=Sunday of the change (may be a later day for "opens"). */
    day: number;
    /** minutes from `now` until the change — handy for "closes in 30 min". */
    inMinutes: number;
  };
}

/** Extract {weekday 0..6 Monday-first, minutes-since-midnight} for an instant in a tz.
 *  Uses Intl parts so DST is handled by the platform, not by us. */
export function localDayAndMinutes(nowUtc: Date, timezone: string): { day: number; minutes: number } {
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

/**
 * Is the venue open at `nowUtc`? Reads periods + timezone. Returns "unknown" for any
 * venue without structured periods (the legacy Places shape), so the caller renders no
 * pill there. Boundaries: open inclusive, close exclusive (a 17:00 close means 16:59
 * open, 17:00 closed).
 *
 * NOTE (overnight seam): scans only the current local day's intervals. When overnight is
 * lifted, the evaluator also checks the PREVIOUS day's intervals whose close < open.
 * Until then, validated data can't contain those, so today-only is exact.
 */
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
  const today = opening.periods.find((p) => p.day === day);

  if (today && !today.closed) {
    for (const iv of today.intervals) {
      const openMin = parseHhmm(iv.open);
      const closeMin = parseHhmm(iv.close);
      if (minutes >= openMin && minutes < closeMin) {
        return {
          status: "open",
          nextChange: { at: iv.close, day, inMinutes: closeMin - minutes },
        };
      }
    }
  }

  // Closed now — find the next opening, scanning forward up to 7 days.
  for (let ahead = 0; ahead < 7; ahead++) {
    const d = (day + ahead) % 7;
    const p = opening.periods.find((x) => x.day === d);
    if (!p || p.closed) continue;
    for (const iv of p.intervals) {
      const openMin = parseHhmm(iv.open);
      if (ahead === 0 && openMin <= minutes) continue; // only future opens today
      const inMinutes = ahead * MINUTES_IN_DAY + openMin - minutes;
      return { status: "closed", nextChange: { at: iv.open, day: d, inMinutes } };
    }
  }

  return { status: "closed" };
}
