import { describe, it, expect } from "vitest";
import {
  parseHhmm,
  formatHhmm,
  formatHhmm12,
  isValidTimezone,
  isOpenNow,
  localDayAndMinutes,
  WEEKDAY_NAMES,
  type DayPeriods,
  type OpeningTimesRead,
} from "./index.js";

/** Build an OpeningTimesRead with structured periods + tz (owner shape). */
function ownerHours(periods: DayPeriods[], timezone = "Europe/London"): OpeningTimesRead {
  return { periods, timezone, source: "owner", weekdayDescriptions: [] };
}
function day(d: number, open: string, close: string): DayPeriods {
  return { day: d, closed: false, intervals: [{ open, close }] };
}
function closed(d: number): DayPeriods {
  return { day: d, closed: true, intervals: [] };
}
function week(open = "09:00", close = "17:00"): DayPeriods[] {
  return [day(0, open, close), day(1, open, close), day(2, open, close), day(3, open, close), day(4, open, close), closed(5), closed(6)];
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
    expect(() => parseHhmm("8:30")).toThrow(RangeError);
    expect(() => parseHhmm("24:00")).toThrow(RangeError);
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

describe("localDayAndMinutes (tz + DST)", () => {
  it("reads London local time correctly in BST (summer)", () => {
    const { day: d, minutes } = localDayAndMinutes(new Date("2026-06-26T10:30:00Z"), "Europe/London");
    expect(d).toBe(4);
    expect(minutes).toBe(11 * 60 + 30);
  });
  it("reads London local time correctly in GMT (winter)", () => {
    const { day: d, minutes } = localDayAndMinutes(new Date("2026-01-09T10:30:00Z"), "Europe/London");
    expect(d).toBe(4);
    expect(minutes).toBe(10 * 60 + 30);
  });
});

describe("isOpenNow", () => {
  const built = ownerHours(week());

  it("returns unknown for legacy string-only hours", () => {
    expect(isOpenNow({ weekdayDescriptions: ["Monday: 9 AM - 5 PM"], source: "google_places" }, new Date()).status).toBe("unknown");
    expect(isOpenNow(null, new Date()).status).toBe("unknown");
  });
  it("is open mid-interval and reports next close", () => {
    const s = isOpenNow(built, new Date("2026-06-26T10:30:00Z"));
    expect(s.status).toBe("open");
    expect(s.nextChange?.at).toBe("17:00");
    expect(s.nextChange?.inMinutes).toBe(5 * 60 + 30);
  });
  it("is closed before opening and reports today's open", () => {
    const s = isOpenNow(built, new Date("2026-06-26T06:30:00Z"));
    expect(s.status).toBe("closed");
    expect(s.nextChange?.at).toBe("09:00");
    expect(s.nextChange?.day).toBe(4);
    expect(s.nextChange?.inMinutes).toBe(90);
  });
  it("is closed at exactly the close minute (close exclusive)", () => {
    const s = isOpenNow(built, new Date("2026-06-26T16:00:00Z"));
    expect(s.status).toBe("closed");
  });
  it("is open at exactly the open minute (open inclusive)", () => {
    const s = isOpenNow(built, new Date("2026-06-26T08:00:00Z"));
    expect(s.status).toBe("open");
  });
  it("rolls to the next open day across a closed weekend", () => {
    const s = isOpenNow(built, new Date("2026-06-27T11:00:00Z"));
    expect(s.status).toBe("closed");
    expect(s.nextChange?.day).toBe(0);
    expect(s.nextChange?.at).toBe("09:00");
  });
  it("handles a permanently-closed week", () => {
    const allClosed = ownerHours([closed(0), closed(1), closed(2), closed(3), closed(4), closed(5), closed(6)]);
    const s = isOpenNow(allClosed, new Date("2026-06-26T10:30:00Z"));
    expect(s.status).toBe("closed");
    expect(s.nextChange).toBeUndefined();
  });
  it("respects split shifts (closed during lunch)", () => {
    const lunch = ownerHours([{ day: 4, closed: false, intervals: [{ open: "09:00", close: "13:00" }, { open: "14:00", close: "17:00" }] }]);
    const s = isOpenNow(lunch, new Date("2026-06-26T12:30:00Z"));
    expect(s.status).toBe("closed");
    expect(s.nextChange?.at).toBe("14:00");
  });

  describe("overnight intervals (close crosses midnight)", () => {
    // Friday (day 4) 18:00–02:00, in GMT (winter) so local == UTC for clean assertions.
    const overnight = ownerHours([day(4, "18:00", "02:00")]);

    it("is open in the evening part and reports the next-day close", () => {
      const s = isOpenNow(overnight, new Date("2026-01-09T23:00:00Z")); // Fri 23:00
      expect(s.status).toBe("open");
      expect(s.nextChange?.at).toBe("02:00");
      expect(s.nextChange?.day).toBe(5); // closes Saturday
      expect(s.nextChange?.inMinutes).toBe(3 * 60); // 23:00 → 02:00
    });

    it("is open in the after-midnight tail (yesterday's interval)", () => {
      const s = isOpenNow(overnight, new Date("2026-01-10T01:00:00Z")); // Sat 01:00
      expect(s.status).toBe("open");
      expect(s.nextChange?.at).toBe("02:00");
      expect(s.nextChange?.day).toBe(5); // still Saturday
      expect(s.nextChange?.inMinutes).toBe(60);
    });

    it("is closed after the tail ends and before the evening open", () => {
      const s = isOpenNow(overnight, new Date("2026-01-09T15:00:00Z")); // Fri 15:00
      expect(s.status).toBe("closed");
      expect(s.nextChange?.at).toBe("18:00");
      expect(s.nextChange?.day).toBe(4);
    });

    it("is closed just after close (02:00 exclusive)", () => {
      const s = isOpenNow(overnight, new Date("2026-01-10T02:00:00Z")); // Sat 02:00
      expect(s.status).toBe("closed");
    });
  });
});

describe("WEEKDAY_NAMES sanity", () => {
  it("is Monday-first", () => {
    expect(WEEKDAY_NAMES[0]).toBe("Monday");
    expect(WEEKDAY_NAMES[6]).toBe("Sunday");
  });
});
