/**
 * Owner-hours WRITE logic — Slice 8 (Owner Editable Hours).
 *
 * The write-side companion to @roam/core/hours. The SHARED pieces — the structured types
 * (DayPeriods, HoursInterval), the time primitives (parseHhmm, formatHhmm, formatHhmm12,
 * isValidTimezone), the caps (VENUE_HOURS_LIMITS), the weekday names, and the read
 * evaluator (isOpenNow) — live in @roam/core/hours, because both the api (this write path)
 * and the web/native reader need them. THIS file holds only what is unique to the WRITE
 * path, which only the updateVenueHours mutation uses: validating an owner's raw input,
 * deriving the display strings, and building the persisted object.
 *
 * The owner twin of venue-details.ts. Single source of truth for the WRITE contract:
 * what a valid owner hours payload is, and exactly what we persist.
 *
 * Overnight (close crossing midnight, e.g. 18:00–02:00) is supported: an interval with
 * close < open opens that day and closes the next. Only open === close is rejected (a
 * zero-length / ambiguous 24h interval). Overlap detection is overnight-aware (see below).
 */

import {
  VENUE_HOURS_LIMITS,
  WEEKDAY_NAMES,
  parseHhmm,
  formatHhmm,
  formatHhmm12,
  isValidTimezone,
  type DayPeriods,
} from "@roam/core/hours";

/** Minutes in a day — for projecting overnight intervals (close < open) past midnight. */
const MINUTES_IN_DAY = 24 * 60;

/** The structured payload an owner authors (pre-derivation). */
export interface OwnerHoursInput {
  periods: DayPeriods[];
  timezone: string;
}

/** The full jsonb object we persist for an owner-edited venue. */
export interface OwnerOpeningTimes {
  weekdayDescriptions: string[];
  periods: DayPeriods[];
  timezone: string;
  source: "owner";
}

/**
 * Normalise + validate an owner's raw hours input to the canonical {periods, timezone}.
 * Throws RangeError (caller maps to BAD_REQUEST) on any contract breach. On success the
 * returned periods are a clean, sorted, 7-element Monday-to-Sunday array.
 *
 * Rules:
 *  - timezone must be a valid IANA zone
 *  - exactly the 7 days 0..6 may appear; missing days default closed; duplicates throw
 *  - a closed day carries no intervals
 *  - each interval: valid HH:MM, open !== close (close < open means it crosses midnight)
 *  - at most maxIntervalsPerDay intervals on a day
 *  - intervals within a day must not overlap, overnight-aware (returned sorted by open)
 */
export function normaliseVenueHours(input: OwnerHoursInput | null | undefined): OwnerHoursInput {
  if (input == null || typeof input !== "object") {
    throw new RangeError("Hours input is required.");
  }
  const { periods, timezone } = input;

  if (!isValidTimezone(timezone)) {
    throw new RangeError(`"${String(timezone)}" is not a recognised timezone.`);
  }
  if (!Array.isArray(periods)) {
    throw new RangeError("Hours must include a periods array.");
  }

  const byDay = new Map<number, DayPeriods>();

  for (const raw of periods) {
    if (raw == null || typeof raw !== "object") {
      throw new RangeError("Each day entry must be an object.");
    }
    const day = (raw as DayPeriods).day;
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new RangeError(`Day index ${String(day)} is out of range (0=Mon ... 6=Sun).`);
    }
    if (byDay.has(day)) {
      throw new RangeError(`Day ${WEEKDAY_NAMES[day]} appears more than once.`);
    }

    const closed = Boolean((raw as DayPeriods).closed);
    const rawIntervals = (raw as DayPeriods).intervals;

    if (closed) {
      if (Array.isArray(rawIntervals) && rawIntervals.length > 0) {
        throw new RangeError(`${WEEKDAY_NAMES[day]} is marked closed but has intervals.`);
      }
      byDay.set(day, { day, closed: true, intervals: [] });
      continue;
    }

    if (!Array.isArray(rawIntervals)) {
      throw new RangeError(`${WEEKDAY_NAMES[day]} must list its open intervals.`);
    }
    if (rawIntervals.length === 0) {
      byDay.set(day, { day, closed: true, intervals: [] });
      continue;
    }
    if (rawIntervals.length > VENUE_HOURS_LIMITS.maxIntervalsPerDay) {
      throw new RangeError(
        `${WEEKDAY_NAMES[day]} has more than ${VENUE_HOURS_LIMITS.maxIntervalsPerDay} intervals.`,
      );
    }

    const parsed = rawIntervals.map((iv) => {
      if (iv == null || typeof iv !== "object") {
        throw new RangeError(`${WEEKDAY_NAMES[day]} has a malformed interval.`);
      }
      const openMin = parseHhmm((iv as { open: string }).open);
      const closeMin = parseHhmm((iv as { close: string }).close);
      // close < open is a legal overnight interval (crosses midnight); only a zero-length
      // open === close is rejected (no duration, and the ambiguous 24h case).
      if (openMin === closeMin) {
        throw new RangeError(
          `${WEEKDAY_NAMES[day]}: ${formatHhmm(openMin)}-${formatHhmm(closeMin)} has no duration.`,
        );
      }
      return { openMin, closeMin };
    });

    parsed.sort((a, b) => a.openMin - b.openMin);
    // Overnight-aware overlap: project each interval onto an absolute minute line where an
    // overnight one (close < open) runs past midnight to close + 1440. Adjacent intervals
    // (sorted by open) must not overlap, AND the last interval's wrap past midnight must not
    // collide with the first interval the next day (last.end <= first.start + a full day).
    // That last guard is what catches e.g. 01:00–05:00 alongside 22:00–02:00.
    const ranges = parsed.map((p) => ({
      start: p.openMin,
      end: p.closeMin < p.openMin ? p.closeMin + MINUTES_IN_DAY : p.closeMin,
    }));
    for (let i = 1; i < ranges.length; i++) {
      const cur = ranges[i];
      const prev = ranges[i - 1];
      if (cur && prev && cur.start < prev.end) {
        throw new RangeError(`${WEEKDAY_NAMES[day]} has overlapping intervals.`);
      }
    }
    const first = ranges[0];
    const last = ranges[ranges.length - 1];
    if (first && last && last.end > first.start + MINUTES_IN_DAY) {
      throw new RangeError(`${WEEKDAY_NAMES[day]} has overlapping intervals.`);
    }

    byDay.set(day, {
      day,
      closed: false,
      intervals: parsed.map((p) => ({ open: formatHhmm(p.openMin), close: formatHhmm(p.closeMin) })),
    });
  }

  const full: DayPeriods[] = [];
  for (let day = 0; day < VENUE_HOURS_LIMITS.days; day++) {
    full.push(byDay.get(day) ?? { day, closed: true, intervals: [] });
  }

  return { periods: full, timezone };
}

/**
 * Derive the weekdayDescriptions display array from validated periods, in the Places
 * style so the existing OpeningHours reader renders owner hours identically to Google's:
 *   "Monday: 8:00 AM - 7:00 PM"
 *   "Tuesday: 9:00 AM - 1:00 PM, 2:00 PM - 5:00 PM"   (split shift)
 *   "Sunday: Closed"
 */
export function deriveWeekdayDescriptions(periods: DayPeriods[]): string[] {
  const out: string[] = [];
  for (let day = 0; day < VENUE_HOURS_LIMITS.days; day++) {
    const name = WEEKDAY_NAMES[day];
    const p = periods.find((x) => x.day === day);
    if (!p || p.closed || p.intervals.length === 0) {
      out.push(`${name}: Closed`);
      continue;
    }
    const spans = p.intervals
      .map((iv) => `${formatHhmm12(parseHhmm(iv.open))} - ${formatHhmm12(parseHhmm(iv.close))}`)
      .join(", ");
    out.push(`${name}: ${spans}`);
  }
  return out;
}

/** Build the full jsonb object to persist for an owner-edited venue. The single
 *  construction site - the API column-gate's payload comes from exactly here, so it is
 *  structurally impossible to write any field other than these four. */
export function buildOwnerOpeningTimes(input: OwnerHoursInput): OwnerOpeningTimes {
  const { periods, timezone } = normaliseVenueHours(input);
  return {
    weekdayDescriptions: deriveWeekdayDescriptions(periods),
    periods,
    timezone,
    source: "owner",
  };
}
