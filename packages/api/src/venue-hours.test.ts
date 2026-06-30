import { describe, it, expect } from "vitest";
import {
  normaliseVenueHours,
  deriveWeekdayDescriptions,
  buildOwnerOpeningTimes,
  type OwnerHoursInput,
} from "./venue-hours.js";
import { type DayPeriods } from "@roam/core/hours";

function day(d: number, open: string, close: string): DayPeriods {
  return { day: d, closed: false, intervals: [{ open, close }] };
}
function closed(d: number): DayPeriods {
  return { day: d, closed: true, intervals: [] };
}

describe("normaliseVenueHours", () => {
  const tz = "Europe/London";

  it("returns a full 7-day Monday-to-Sunday array, absent days closed", () => {
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
    const out = normaliseVenueHours({ periods: [{ day: 2, closed: false, intervals: [] }], timezone: tz });
    expect(out.periods[2]).toEqual(closed(2));
  });

  it("accepts an overnight interval (close crosses midnight)", () => {
    const out = normaliseVenueHours({ periods: [day(0, "18:00", "02:00")], timezone: tz });
    expect(out.periods[0]).toEqual(day(0, "18:00", "02:00"));
  });

  it("accepts a daytime shift alongside an overnight evening shift", () => {
    const out = normaliseVenueHours({
      periods: [{ day: 0, closed: false, intervals: [{ open: "22:00", close: "02:00" }, { open: "09:00", close: "13:00" }] }],
      timezone: tz,
    });
    expect(out.periods[0]?.intervals).toEqual([
      { open: "09:00", close: "13:00" },
      { open: "22:00", close: "02:00" },
    ]);
  });

  it("rejects a zero-length interval (open === close)", () => {
    expect(() => normaliseVenueHours({ periods: [day(0, "12:00", "12:00")], timezone: tz })).toThrow(RangeError);
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

  it("rejects an overnight interval whose tail overlaps a morning interval", () => {
    // 22:00–02:00 wraps to 02:00, colliding with a 01:00–05:00 morning interval.
    expect(() =>
      normaliseVenueHours({
        periods: [
          { day: 0, closed: false, intervals: [{ open: "01:00", close: "05:00" }, { open: "22:00", close: "02:00" }] },
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
    expect(() => normaliseVenueHours({ periods: [day(0, "09:00", "17:00")], timezone: "Europe/Narnia" })).toThrow(RangeError);
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
    expect(desc[0]).toBe("Monday: 8:00 AM - 7:00 PM");
    expect(desc[1]).toBe("Tuesday: 9:00 AM - 1:00 PM, 2:00 PM - 5:00 PM");
    expect(desc[6]).toBe("Sunday: Closed");
    expect(desc).toHaveLength(7);
  });

  it("formats an overnight interval with AM/PM (next-day close stays unambiguous)", () => {
    const periods = normaliseVenueHours({ periods: [day(4, "18:00", "02:00")], timezone: "Europe/London" }).periods;
    expect(deriveWeekdayDescriptions(periods)[4]).toBe("Friday: 6:00 PM - 2:00 AM");
  });
});

describe("buildOwnerOpeningTimes", () => {
  it("produces the full persisted shape with source owner", () => {
    const built = buildOwnerOpeningTimes({ periods: [day(0, "09:00", "17:00")], timezone: "Europe/London" } as OwnerHoursInput);
    expect(built.source).toBe("owner");
    expect(built.timezone).toBe("Europe/London");
    expect(built.periods).toHaveLength(7);
    expect(built.weekdayDescriptions[0]).toBe("Monday: 9:00 AM - 5:00 PM");
    expect(built.weekdayDescriptions[6]).toBe("Sunday: Closed");
  });
});
