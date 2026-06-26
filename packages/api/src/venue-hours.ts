/**
 * Pure venue-hours logic — Slice 8 (Owner Editable Hours + "Open Now").
 *
 * The owner twin of venue-details.ts: no network, no key, no tRPC — pure functions the
 * API mutation depends on and CI unit-tests in isolation. They define the WRITE contract
 * for owner-authored opening hours and the READ contract for "open now", so the value the
 * owner writes is exactly the value VenueDetail's OpeningHours reader expects.
 *
 * ── The dual shape of `opening_times` (jsonb) ────────────────────────────────────────
 * Places-sourced venues carry the LEGACY shape (unchanged since 0018):
 *     { weekdayDescriptions: string[], source: "google_places" }
 * Owner-edited venues carry the STRUCTURED shape (new here, additive):
 *     { weekdayDescriptions: string[],   // DERIVED from periods — keeps the existing
 *                                         //   reader working with zero changes
 *       periods: DayPeriods[],           // the canonical machine-readable hours
 *       timezone: string,                // IANA tz; required for a correct "open now"
 *       source: "owner" }
 *
 * `weekdayDescriptions` stays the single DISPLAY truth for both shapes. `periods` is the
 * single STRUCTURED truth, present only when owner-authored. The existing OpeningHours
 * reader ignores `periods`/`timezone`; it only needs `weekdayDescriptions`. "Open now"
 * reads `periods` and is therefore available only on owner-edited venues — exactly the
 * venues whose owners care to keep hours current.
 *
 * ── Deliberate Slice 8 scope (seam left open, feature deferred) ───────────────────────
 * Overnight intervals (close crossing midnight, e.g. 22:00–02:00) are NOT accepted by the
 * validator yet: every interval must satisfy open < close. BUT the shape and the
 * isOpenNow evaluator are written so that lifting this later is a validator-only change —
 * no migration, no shape change, no reader rewrite. We defer the feature, not the seam.
 */

/** Minutes-since-midnight, 00:00 = 0 … 23:59 = 1439. The whole module works in minutes
 *  to keep time math exact and Date-parsing-free. */
const MINUTES_IN_DAY = 24 * 60;

/** Hard caps — generous for real businesses, bounded against abuse. */
export const VENUE_HOURS_LIMITS = {
  /** Mon..Sun — exactly 7 day slots, indexed 0=Monday. */
  days: 7,
  /** Split shifts: a day can have at most this many open intervals (e.g. morning +
   *  afternoon around a lunch close). 3 covers any realistic real-world day. */
  maxIntervalsPerDay: 3,
} as const;

/** Day index convention: 0=Monday … 6=Sunday (British, Monday-first — matches the order
 *  Places already emits in weekdayDescriptions for this region, so derivation aligns). */
export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/** A single open interval within a day. open/close are "HH:MM" 24h. open < close
 *  (no overnight yet — see scope note). */
export interface HoursInterval {
  open: string; // "HH:MM"
  close: string; // "HH:MM"
}

/** One day's hours. closed:true => intervals must be empty. */
export interface DayPeriods {
  /** 0=Monday … 6=Sunday */
  day: number;
  closed: boolean;
  intervals: HoursInterval[];
}

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

/** Either shape, as read back from the column. */
export interface OpeningTimesRead {
  weekdayDescriptions?: string[];
  periods?: DayPeriods[];
  timezone?: string;
  source?: string;
}

/* ─────────────────────────────────────────────────────────────────────────────────────
 * Time helpers (pure, minutes-based)
 * ──────────────────────────────────────────────────────────────────────────────────── */

/** Parse "HH:MM" → minutes since midnight. Throws RangeError on malformed input. Accepts
 *  only zero-padded 24h "HH:MM" with HH in 00..23 and MM in 00..59. "24:00" is rejected —
 *  a day-end of midnight is expressed by the NEXT day, not 24:00 (kept strict so the
 *  overnight seam stays the single future change site). */
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
 *  correct across DST. We validate rather than trust the client so isOpenNow can never be
 *  handed a tz it will silently mis-evaluate. */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    // Throws RangeError for an unknown zone.
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────────────
 * Validation / normalisation (the WRITE contract)
 * ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * Normalise + validate an owner's raw hours input to the canonical {periods, timezone}.
 * Throws RangeError (caller maps to BAD_REQUEST) on any contract breach. On success the
 * returned periods are a clean, sorted, 7-element Monday→Sunday array.
 *
 * Rules enforced:
 *  - timezone must be a valid IANA zone
 *  - exactly the 7 days 0..6 may appear; missing days default to closed; duplicates throw
 *  - a closed day carries no intervals
 *  - each interval: valid HH:MM, open < close (NO overnight yet — deferred)
 *  - at most maxIntervalsPerDay intervals on a day
 *  - intervals within a day must not overlap (and are returned sorted by open)
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

  // Build a 0..6 slot map; every day defaults to closed unless the input provides it.
  const byDay = new Map<number, DayPeriods>();

  for (const raw of periods) {
    if (raw == null || typeof raw !== "object") {
      throw new RangeError("Each day entry must be an object.");
    }
    const day = (raw as DayPeriods).day;
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new RangeError(`Day index ${String(day)} is out of range (0=Mon … 6=Sun).`);
    }
    if (byDay.has(day)) {
      throw new RangeError(`Day ${WEEKDAY_NAMES[day]} appears more than once.`);
    }

    const closed = Boolean((raw as DayPeriods).closed);
    const rawIntervals = (raw as DayPeriods).intervals;

    if (closed) {
      // A closed day must not smuggle intervals — keep the cleared state unambiguous.
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
      // Open with no intervals is meaningless — treat as closed rather than guess.
      byDay.set(day, { day, closed: true, intervals: [] });
      continue;
    }
    if (rawIntervals.length > VENUE_HOURS_LIMITS.maxIntervalsPerDay) {
      throw new RangeError(
        `${WEEKDAY_NAMES[day]} has more than ${VENUE_HOURS_LIMITS.maxIntervalsPerDay} intervals.`,
      );
    }

    // Validate each interval into minutes, then sort + overlap-check.
    const parsed = rawIntervals.map((iv) => {
      if (iv == null || typeof iv !== "object") {
        throw new RangeError(`${WEEKDAY_NAMES[day]} has a malformed interval.`);
      }
      const openMin = parseHhmm((iv as HoursInterval).open);
      const closeMin = parseHhmm((iv as HoursInterval).close);
      if (openMin >= closeMin) {
        // open < close required. Overnight (close < open) is the deferred seam: when we
        // lift it, THIS is the single check that changes.
        throw new RangeError(
          `${WEEKDAY_NAMES[day]}: ${formatHhmm(openMin)}–${formatHhmm(closeMin)} must open before it closes.`,
        );
      }
      return { openMin, closeMin };
    });

    parsed.sort((a, b) => a.openMin - b.openMin);
    for (let i = 1; i < parsed.length; i++) {
      const cur = parsed[i];
      const prev = parsed[i - 1];
      if (cur && prev && cur.openMin < prev.closeMin) {
        throw new RangeError(`${WEEKDAY_NAMES[day]} has overlapping intervals.`);
      }
    }

    byDay.set(day, {
      day,
      closed: false,
      intervals: parsed.map((p) => ({ open: formatHhmm(p.openMin), close: formatHhmm(p.closeMin) })),
    });
  }

  // Emit a full, ordered 7-day array; days absent from input are closed.
  const full: DayPeriods[] = [];
  for (let day = 0; day < VENUE_HOURS_LIMITS.days; day++) {
    full.push(byDay.get(day) ?? { day, closed: true, intervals: [] });
  }

  return { periods: full, timezone };
}

/* ─────────────────────────────────────────────────────────────────────────────────────
 * Derivation (structured → display) — keeps the existing reader working
 * ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * Derive the weekdayDescriptions display array from validated periods, in the Places
 * style so the existing OpeningHours reader renders owner hours identically to Google's:
 *   "Monday: 8:00 AM – 7:00 PM"
 *   "Tuesday: 9:00 AM – 1:00 PM, 2:00 PM – 5:00 PM"   (split shift)
 *   "Sunday: Closed"
 * Uses the en-dash "–" separator Places uses, and ", " between split intervals.
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
      .map((iv) => `${formatHhmm12(parseHhmm(iv.open))} – ${formatHhmm12(parseHhmm(iv.close))}`)
      .join(", ");
    out.push(`${name}: ${spans}`);
  }
  return out;
}

/** Build the full jsonb object to persist for an owner-edited venue. The single
 *  construction site — the API column-gate's payload comes from exactly here, so it is
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

/* ─────────────────────────────────────────────────────────────────────────────────────
 * "Open now" evaluator (the READ contract)
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
  // Intl can emit "24" for midnight in some engines; normalise to 00.
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
 * pill there. Closed-interval boundaries: open is inclusive, close is exclusive
 * (a 17:00 close means 16:59 open, 17:00 closed).
 *
 * NOTE (overnight seam): this scans only the current local day's intervals. When overnight
 * is lifted, the evaluator also checks the PREVIOUS day's intervals whose close < open.
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

  // Check whether we're inside an interval right now.
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

  // Closed right now — find the next opening, scanning forward up to 7 days.
  for (let ahead = 0; ahead < 7; ahead++) {
    const d = (day + ahead) % 7;
    const p = opening.periods.find((x) => x.day === d);
    if (!p || p.closed) continue;
    for (const iv of p.intervals) {
      const openMin = parseHhmm(iv.open);
      // On day 0 of the scan, only future opens count.
      if (ahead === 0 && openMin <= minutes) continue;
      const inMinutes = ahead * MINUTES_IN_DAY + openMin - minutes;
      return { status: "closed", nextChange: { at: iv.open, day: d, inMinutes } };
    }
  }

  // No open interval anywhere in the week — permanently closed by its own hours.
  return { status: "closed" };
}
