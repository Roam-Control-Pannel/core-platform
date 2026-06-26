import { describe, it, expect } from "vitest";
import {
  parseHhmm,
  formatHhmm,
  formatHhmm12,
  isValidTimezone,
  normaliseVenueHours,
  deriveWeekdayDescriptions,
  buildOwnerOpeningTimes,
  isOpenNow,
  localDayAndMinutes,
  WEEKDAY_NAMES,
  type DayPeriods,
} from "./venue-hours";

/** Helper: a full open day Mon-style with one interval. */
function day(d: number, open: string, close: string): DayPeriods {
  return { day: d, closed: false, intervals: [{ open, close }] };
}
function closed(d: number): DayPeriods {
  return { day: d, closed: true, intervals: [] };
}

describe("parseHhmm / formatHhmm", () => {
  it("parses valid times to minutes", () => {
    expect(parseHhmm("00:00")).toBe(0);
    expect(parseHhmm("08:30")).toBe(510);
    expect(parseHhmm("23:59")).toBe(1439);
  });
  it("round-trips through formatHhmm", () => {
    for (const t of ["00:00", "09:05", "12:00", "17:45", "23:59"]) {
      expect(formatHhmm(parseHhmm(t))).toBe(t);
    }
  });
  it("rejects malformed or out-of-range times", () => {
    expect(() => parseHhmm("8:30")).toThrow(RangeError); // not zero-padded
    expect(() => parseHhmm("24:00")).toThrow(RangeError); // 24 rejected by design
    expect(() => parseHhmm("12:60")).toThrow(RangeError);
    expect(() => parseHhmm("99:99")).toThrow(RangeError);
    expect(() => parseHhmm("noon")).toThrow(RangeError);
    // @ts-expect-error testing non-string guard
    expect(() => parseHhmm(830)).toThrow(RangeError);
  });
});

describe("formatHhmm12 (Places-style display)", () => {
  it("formats 12-hour with AM/PM", () => {
    expect(formatHhmm12(0)).toBe("12:00 AM");
    expect(formatHhmm12(8 * 60)).toBe("8:00 AM");
    expect(formatHhmm12(12 * 60)).toBe("12:00 PM");
    expect(formatHhmm12(13 * 60 + 30)).toBe("1:30 PM");
    expect(formatHhmm12(19 * 60)).toBe("7:00 PM");
    expect(formatHhmm12(23 * 60 + 59)).toBe("11:59 PM");
  });
});

describe("isValidTimezone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });
  it("rejects junk", () => {
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("Europe/Narnia")).toBe(false);
    // @ts-expect-error non-string
    expect(isValidTimezone(123)).toBe(false);
  });
});

describe("normaliseVenueHours", () => {
  const tz = "Europe/London";

  it("returns a full 7-day Monday→Sunday array, absent days closed", () => {
    const out = normaliseVenueHours({ periods: [day(0, "09:00", "17:00")], timezone: tz });
    expect(out.periods).toHaveLength(7);
    expect(out.periods[0]).toEqual(day(0, "09:00", "17:00"));
    for (let d = 1; d < 7; d++) expect(out.periods[d]).toEqual(closed(d));
  });

  it("sorts intervals and accepts split shifts", () => {
    const out = normaliseVenueHours({
      periods: [
        { day: 1, closed: false, intervals: [{ open: "14:00", close: "17:00" }, { open: "09:00", close: "13:00" }] },
      ],
      timezone: tz,
    });
    expect(out.periods[1]?.intervals).toEqual([
      { open: "09:00", close: "13:00" },
      { open: "14:00", close: "17:00" },
    ]);
  });

  it("treats an open day with no intervals as closed", () => {
    const out = normaliseVenueHours({
      periods: [{ day: 2, closed: false, intervals: [] }],
      timezone: tz,
    });
    expect(out.periods[2]).toEqual(closed(2));
  });

  it("rejects open >= close (overnight deferred)", () => {
    expect(() =>
      normaliseVenueHours({ periods: [day(0, "22:00", "02:00")], timezone: tz }),
    ).toThrow(RangeError);
    expect(() =>
      normaliseVenueHours({ periods: [day(0, "12:00", "12:00")], timezone: tz }),
    ).toThrow(RangeError);
  });

  it("rejects overlapping intervals", () => {
    expect(() =>
      normaliseVenueHours({
        periods: [
          { day: 0, closed: false, intervals: [{ open: "09:00", close: "13:00" }, { open: "12:00", close: "17:00" }] },
        ],
        timezone: tz,
      }),
    ).toThrow(RangeError);
  });

  it("rejects a closed day carrying intervals", () => {
    expect(() =>
      normaliseVenueHours({
        periods: [{ day: 0, closed: true, intervals: [{ open: "09:00", close: "17:00" }] }],
        timezone: tz,
      }),
    ).toThrow(RangeError);
  });

  it("rejects duplicate days, bad indices, too many intervals, bad tz", () => {
    expect(() =>
      normaliseVenueHours({ periods: [day(0, "09:00", "17:00"), day(0, "10:00", "12:00")], timezone: tz }),
    ).toThrow(RangeError);
    expect(() => normaliseVenueHours({ periods: [day(7, "09:00", "17:00")], timezone: tz })).toThrow(RangeError);
    expect(() =>
      normaliseVenueHours({
        periods: [
          {
            day: 0,
            closed: false,
            intervals: [
              { open: "01:00", close: "02:00" },
              { open: "03:00", close: "04:00" },
              { open: "05:00", close: "06:00" },
              { open: "07:00", close: "08:00" },
            ],
          },
        ],
        timezone: tz,
      }),
    ).toThrow(RangeError);
    expect(() => normaliseVenueHours({ periods: [day(0, "09:00", "17:00")], timezone: "Europe/Narnia" })).toThrow(
      RangeError,
    );
  });
});

describe("deriveWeekdayDescriptions (Places-format parity)", () => {
  it("formats open, closed, and split-shift days", () => {
    const periods = normaliseVenueHours({
      periods: [
        day(0, "08:00", "19:00"),
        { day: 1, closed: false, intervals: [{ open: "09:00", close: "13:00" }, { open: "14:00", close: "17:00" }] },
        closed(6),
      ],
      timezone: "Europe/London",
    }).periods;
    const desc = deriveWeekdayDescriptions(periods);
    expect(desc[0]).toBe("Monday: 8:00 AM – 7:00 PM");
    expect(desc[1]).toBe("Tuesday: 9:00 AM – 1:00 PM, 2:00 PM – 5:00 PM");
    expect(desc[6]).toBe("Sunday: Closed");
    expect(desc).toHaveLength(7);
  });
});

describe("buildOwnerOpeningTimes", () => {
  it("produces the full persisted shape with source owner", () => {
    const built = buildOwnerOpeningTimes({
      periods: [day(0, "09:00", "17:00")],
      timezone: "Europe/London",
    });
    expect(built.source).toBe("owner");
    expect(built.timezone).toBe("Europe/London");
    expect(built.periods).toHaveLength(7);
    expect(built.weekdayDescriptions[0]).toBe("Monday: 9:00 AM – 5:00 PM");
    expect(built.weekdayDescriptions[6]).toBe("Sunday: Closed");
  });
});

describe("localDayAndMinutes (tz + DST)", () => {
  it("reads London local time correctly in BST (summer)", () => {
    // 2026-06-26 10:30 UTC → 11:30 BST (UTC+1), a Friday (day index 4).
    const { day: d, minutes } = localDayAndMinutes(new Date("2026-06-26T10:30:00Z"), "Europe/London");
    expect(d).toBe(4);
    expect(minutes).toBe(11 * 60 + 30);
  });
  it("reads London local time correctly in GMT (winter)", () => {
    // 2026-01-09 10:30 UTC → 10:30 GMT (UTC+0), a Friday.
    const { day: d, minutes } = localDayAndMinutes(new Date("2026-01-09T10:30:00Z"), "Europe/London");
    expect(d).toBe(4);
    expect(minutes).toBe(10 * 60 + 30);
  });
});

describe("isOpenNow", () => {
  const tz = "Europe/London";
  const built = buildOwnerOpeningTimes({
    periods: [
      day(0, "09:00", "17:00"), // Mon
      day(1, "09:00", "17:00"), // Tue
      day(2, "09:00", "17:00"), // Wed
      day(3, "09:00", "17:00"), // Thu
      day(4, "09:00", "17:00"), // Fri
      closed(5), // Sat
      closed(6), // Sun
    ],
    timezone: tz,
  });

  it("returns unknown for legacy string-only hours", () => {
    expect(isOpenNow({ weekdayDescriptions: ["Monday: 9 AM – 5 PM"], source: "google_places" }, new Date()).status).toBe(
      "unknown",
    );
    expect(isOpenNow(null, new Date()).status).toBe("unknown");
  });

  it("is open mid-interval and reports next close", () => {
    // Fri 2026-06-26, 11:30 BST → inside 09:00–17:00.
    const s = isOpenNow(built, new Date("2026-06-26T10:30:00Z"));
    expect(s.status).toBe("open");
    expect(s.nextChange?.at).toBe("17:00");
    expect(s.nextChange?.inMinutes).toBe(5 * 60 + 30); // 11:30 → 17:00
  });

  it("is closed before opening and reports today's open", () => {
    // Fri 07:30 BST (06:30 UTC) → before 09:00.
    const s = isOpenNow(built, new Date("2026-06-26T06:30:00Z"));
    expect(s.status).toBe("closed");
    expect(s.nextChange?.at).toBe("09:00");
    expect(s.nextChange?.day).toBe(4);
    expect(s.nextChange?.inMinutes).toBe(90);
  });

  it("is closed at exactly the close minute (close exclusive)", () => {
    // Fri 17:00 BST (16:00 UTC).
    const s = isOpenNow(built, new Date("2026-06-26T16:00:00Z"));
    expect(s.status).toBe("closed");
  });

  it("is open at exactly the open minute (open inclusive)", () => {
    // Fri 09:00 BST (08:00 UTC).
    const s = isOpenNow(built, new Date("2026-06-26T08:00:00Z"));
    expect(s.status).toBe("open");
  });

  it("rolls to the next open day across a closed weekend", () => {
    // Sat 2026-06-27 12:00 BST → closed; next open Monday 09:00.
    const s = isOpenNow(built, new Date("2026-06-27T11:00:00Z"));
    expect(s.status).toBe("closed");
    expect(s.nextChange?.day).toBe(0); // Monday
    expect(s.nextChange?.at).toBe("09:00");
  });

  it("handles a permanently-closed week", () => {
    const allClosed = buildOwnerOpeningTimes({
      periods: [closed(0), closed(1), closed(2), closed(3), closed(4), closed(5), closed(6)],
      timezone: tz,
    });
    const s = isOpenNow(allClosed, new Date("2026-06-26T10:30:00Z"));
    expect(s.status).toBe("closed");
    expect(s.nextChange).toBeUndefined();
  });

  it("respects split shifts (closed during lunch)", () => {
    const lunch = buildOwnerOpeningTimes({
      periods: [{ day: 4, closed: false, intervals: [{ open: "09:00", close: "13:00" }, { open: "14:00", close: "17:00" }] }],
      timezone: tz,
    });
    // Fri 13:30 BST (12:30 UTC) → in the lunch gap.
    const s = isOpenNow(lunch, new Date("2026-06-26T12:30:00Z"));
    expect(s.status).toBe("closed");
    expect(s.nextChange?.at).toBe("14:00");
  });
});

describe("WEEKDAY_NAMES sanity", () => {
  it("is Monday-first", () => {
    expect(WEEKDAY_NAMES[0]).toBe("Monday");
    expect(WEEKDAY_NAMES[6]).toBe("Sunday");
  });
});
