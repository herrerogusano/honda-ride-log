import { describe, expect, it } from "vitest";
import {
  dayStartMs,
  inPeriod,
  kmByMonth,
  lastUseMs,
  localDay,
  monthVsLastYear,
  records,
  ridesByHour,
  ridesByWeekday,
  shortTrips,
  SHORT_TRIP_KM,
  streaks,
  totals,
  yearOf,
  yearsWithRoutes,
} from "../src/domain/stats";
import { ride, rides } from "./helpers";

// The tests run in Los Angeles (UTC-8 in winter, UTC-7 in summer). This ride
// starts on 1 January 2026 in UTC but on Wednesday 31 December 2025 at 19:00
// for the rider: code that slips into UTC puts it in the wrong year, month,
// weekday and hour.
const NEW_YEAR_TRAP = "2026-01-01T03:00:00Z";
const at = (iso: string): number => Date.parse(iso);

describe("local calendar", () => {
  it("runs where the tests expect it to", () => {
    expect(new Date(at("2026-01-15T12:00:00Z")).getTimezoneOffset()).toBe(480);
    expect(new Date(at("2026-07-15T12:00:00Z")).getTimezoneOffset()).toBe(420);
  });

  it("numbers consecutive local days consecutively across the clock change", () => {
    // Clocks go forward in Los Angeles on Sunday 8 March 2026.
    const saturday = localDay(at("2026-03-07T12:00:00-08:00"));
    expect(localDay(at("2026-03-08T12:00:00-07:00"))).toBe(saturday + 1);
    expect(localDay(at("2026-03-09T00:30:00-07:00"))).toBe(saturday + 2);
    expect(localDay(at("2026-03-07T23:59:00-08:00"))).toBe(saturday);
    expect(localDay(at("2026-03-07T00:00:00-08:00"))).toBe(saturday);
  });

  it("gives back the local midnight of a day number", () => {
    expect(dayStartMs(localDay(at("2026-03-08T15:00:00-07:00")))).toBe(at("2026-03-08T00:00:00-08:00"));
    expect(dayStartMs(localDay(at(NEW_YEAR_TRAP)))).toBe(at("2025-12-31T00:00:00-08:00"));
  });

  it("puts a ride in the year of its local start", () => {
    const list = rides([
      { start: NEW_YEAR_TRAP, km: 10 },
      { start: "2026-06-01T10:00:00-07:00", km: 20 },
      { start: "2024-02-01T10:00:00-08:00", km: 30 },
    ]);
    expect(yearOf(ride({ start: NEW_YEAR_TRAP, km: 1 }))).toBe(2025);
    expect(yearsWithRoutes(list)).toEqual([2026, 2025, 2024]);
    expect(inPeriod(list, 2025).map((r) => r.distanceKm)).toEqual([10]);
    expect(inPeriod(list, 2026).map((r) => r.distanceKm)).toEqual([20]);
    expect(inPeriod(list, 2023)).toEqual([]);
    expect(inPeriod(list, "all").length).toBe(3);
    expect(yearsWithRoutes([])).toEqual([]);
  });
});

describe("totals", () => {
  it("adds km, rides and the known durations", () => {
    const result = totals(
      rides([
        { start: "2026-05-01T08:00:00-07:00", km: 12.5, minutes: 30 },
        { start: "2026-05-02T08:00:00-07:00", km: 7.25, minutes: 45 },
        { start: "2026-05-03T08:00:00-07:00", km: 100, minutes: null },
      ]),
    );
    expect(result.km).toBeCloseTo(119.75, 9);
    expect(result.rides).toBe(3);
    expect(result.hours).toBeCloseTo(1.25, 9);
    expect(result.ridesWithoutDuration).toBe(1);
  });

  it("is all zeros without rides", () => {
    expect(totals([])).toEqual({ km: 0, rides: 0, hours: 0, ridesWithoutDuration: 0 });
  });
});

describe("monthVsLastYear", () => {
  it("compares this month with the same month a year earlier, in local time", () => {
    const list = rides([
      { start: "2026-11-02T08:00:00-08:00", km: 10 },
      { start: "2026-11-09T07:00:00-08:00", km: 5.5 },
      // 02:00 UTC on 1 December is still 30 November for the rider.
      { start: "2026-12-01T02:00:00Z", km: 7 },
      { start: "2026-10-31T09:00:00-07:00", km: 99 },
      { start: "2025-11-20T08:00:00-08:00", km: 20 },
      { start: "2024-11-20T08:00:00-08:00", km: 50 },
      { start: "2025-12-01T08:00:00-08:00", km: 70 },
    ]);
    const result = monthVsLastYear(list, at("2026-11-09T12:00:00-08:00"));
    expect(result.year).toBe(2026);
    expect(result.month).toBe(10);
    expect(result.km).toBeCloseTo(22.5, 9);
    expect(result.previousKm).toBeCloseTo(20, 9);
    expect(result.differenceKm).toBeCloseTo(2.5, 9);
  });

  it("takes the month from the local clock, not from UTC", () => {
    // 05:00 UTC on 1 December is 21:00 on 30 November in Los Angeles.
    const result = monthVsLastYear([], at("2026-12-01T05:00:00Z"));
    expect([result.year, result.month, result.km, result.previousKm, result.differenceKm]).toEqual([2026, 10, 0, 0, 0]);
  });
});

describe("kmByMonth", () => {
  const list = rides([
    { start: "2023-05-05T10:00:00-07:00", km: 1 },
    { start: "2024-01-10T10:00:00-08:00", km: 2 },
    { start: "2024-12-31T23:30:00-08:00", km: 3 },
    { start: NEW_YEAR_TRAP, km: 4 },
    { start: "2026-03-01T10:00:00-08:00", km: 5 },
    { start: "2026-03-20T10:00:00-07:00", km: 6.5 },
    { start: "2026-11-09T10:00:00-08:00", km: 8 },
  ]);

  it("gives twelve months for each of the last three years with rides, oldest first", () => {
    const series = kmByMonth(list);
    expect(series.map((s) => s.year)).toEqual([2024, 2025, 2026]);
    expect(series[0]?.km).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    expect(series[1]?.km).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]);
    expect(series[2]?.km).toEqual([0, 0, 11.5, 0, 0, 0, 0, 0, 0, 0, 8, 0]);
  });

  it("skips years without rides and accepts another number of years", () => {
    const sparse = rides([
      { start: "2020-02-02T10:00:00-08:00", km: 1 },
      { start: "2026-02-02T10:00:00-08:00", km: 2 },
    ]);
    expect(kmByMonth(sparse).map((s) => s.year)).toEqual([2020, 2026]);
    expect(kmByMonth(list, 1).map((s) => s.year)).toEqual([2026]);
    expect(kmByMonth([])).toEqual([]);
  });
});

describe("habits", () => {
  const list = rides([
    { start: "2026-11-09T07:15:00-08:00", km: 1 }, // Monday 07:15
    { start: "2026-11-09T18:59:00-08:00", km: 1 }, // Monday 18:59
    { start: "2026-11-10T05:00:00Z", km: 1 }, // Monday 21:00 local, Tuesday in UTC
    { start: "2026-11-08T00:05:00-08:00", km: 1 }, // Sunday 00:05
    { start: "2026-11-14T23:10:00-08:00", km: 1 }, // Saturday 23:10
  ]);

  it("counts rides per weekday with Monday first", () => {
    expect(ridesByWeekday(list)).toEqual([3, 0, 0, 0, 0, 1, 1]);
    expect(ridesByWeekday([])).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("counts rides per local hour of the start", () => {
    const hours = ridesByHour(list);
    expect(hours.length).toBe(24);
    expect(hours[7]).toBe(1);
    expect(hours[18]).toBe(1);
    expect(hours[21]).toBe(1);
    expect(hours[0]).toBe(1);
    expect(hours[23]).toBe(1);
    expect(hours.reduce((a, b) => a + b, 0)).toBe(5);
  });
});

describe("records", () => {
  it("finds the longest ride and the day and month with most km", () => {
    const result = records(
      rides([
        { start: "2026-04-10T09:00:00-07:00", km: 80 },
        // Two rides the same local evening and one just after midnight:
        // in UTC all three fall on 21 June.
        { start: "2026-06-20T18:00:00-07:00", km: 50 },
        { start: "2026-06-20T22:00:00-07:00", km: 45 },
        { start: "2026-06-21T00:30:00-07:00", km: 60 },
        { start: "2026-07-04T09:00:00-07:00", km: 70 },
        { start: "2026-07-05T09:00:00-07:00", km: 70 },
        { start: "2026-07-25T09:00:00-07:00", km: 30 },
      ]),
    );
    expect(result.longestRide).toEqual({ km: 80, startMs: at("2026-04-10T09:00:00-07:00") });
    expect(result.bestDay).toEqual({ km: 95, dayMs: at("2026-06-20T00:00:00-07:00") });
    expect(result.bestMonth).toEqual({ km: 170, year: 2026, month: 6 });
  });

  it("keeps the earliest when two are equal", () => {
    const result = records(
      rides([
        { start: "2025-02-01T09:00:00-08:00", km: 40 },
        { start: "2025-03-01T09:00:00-08:00", km: 40 },
      ]),
    );
    expect(result.longestRide?.startMs).toBe(at("2025-02-01T09:00:00-08:00"));
    expect(result.bestDay?.dayMs).toBe(at("2025-02-01T00:00:00-08:00"));
    expect(result.bestMonth).toEqual({ km: 40, year: 2025, month: 1 });
  });

  it("puts a ride late on New Year's Eve in December of the old year", () => {
    expect(records([ride({ start: NEW_YEAR_TRAP, km: 9 })]).bestMonth).toEqual({ km: 9, year: 2025, month: 11 });
  });

  it("has no records without rides", () => {
    expect(records([])).toEqual({ longestRide: null, bestDay: null, bestMonth: null });
  });
});

describe("streaks", () => {
  // Rides on 6, 7, 8 and 9 March (the clock changes on the 8th), nothing from
  // the 10th to the 19th, rides on the 20th and 21st.
  const list = rides([
    { start: "2026-03-06T08:00:00-08:00", km: 5 },
    { start: "2026-03-07T23:50:00-08:00", km: 5 },
    { start: "2026-03-08T12:00:00-07:00", km: 5 },
    { start: "2026-03-08T19:00:00-07:00", km: 5 },
    { start: "2026-03-09T00:10:00-07:00", km: 5 },
    { start: "2026-03-20T08:00:00-07:00", km: 5 },
    { start: "2026-03-21T08:00:00-07:00", km: 5 },
  ]);
  const midnight = (day: string): number => new Date(`${day}T00:00:00`).getTime();

  it("finds the longest run of riding days and the longest run of parked days", () => {
    const result = streaks(list, at("2026-03-21T20:00:00-07:00"));
    expect(result.longestRiding).toEqual({ days: 4, fromMs: midnight("2026-03-06"), toMs: midnight("2026-03-09") });
    expect(result.longestParked).toEqual({ days: 10, fromMs: midnight("2026-03-10"), toMs: midnight("2026-03-19") });
  });

  it("counts the riding run in progress, which survives until a whole day passes without a ride", () => {
    expect(streaks(list, at("2026-03-21T20:00:00-07:00")).currentRiding).toBe(2);
    expect(streaks(list, at("2026-03-22T09:00:00-07:00")).currentRiding).toBe(2);
    expect(streaks(list, at("2026-03-23T00:01:00-07:00")).currentRiding).toBe(0);
  });

  it("counts whole parked days since the last ride, without today", () => {
    expect(streaks(list, at("2026-03-21T20:00:00-07:00")).currentParked).toBe(0);
    expect(streaks(list, at("2026-03-22T23:00:00-07:00")).currentParked).toBe(0);
    expect(streaks(list, at("2026-03-23T00:01:00-07:00")).currentParked).toBe(1);
    expect(streaks(list, at("2026-03-30T12:00:00-07:00")).currentParked).toBe(8);
  });

  it("handles one ride, no rides and a clock behind the last ride", () => {
    const one = rides([{ start: "2026-05-05T08:00:00-07:00", km: 5 }]);
    const single = streaks(one, at("2026-05-05T09:00:00-07:00"));
    expect(single.longestRiding).toEqual({ days: 1, fromMs: midnight("2026-05-05"), toMs: midnight("2026-05-05") });
    expect(single.longestParked).toBeNull();
    expect([single.currentRiding, single.currentParked]).toEqual([1, 0]);
    expect(streaks([], at("2026-05-05T09:00:00-07:00"))).toEqual({
      longestRiding: null,
      longestParked: null,
      currentRiding: 0,
      currentParked: 0,
    });
    const early = streaks(one, at("2026-05-01T09:00:00-07:00"));
    expect([early.currentRiding, early.currentParked]).toEqual([1, 0]);
  });

  it("keeps the earliest of two equal runs", () => {
    const equal = rides([
      { start: "2026-01-01T12:00:00-08:00", km: 5 },
      { start: "2026-01-02T12:00:00-08:00", km: 5 },
      { start: "2026-01-05T12:00:00-08:00", km: 5 },
      { start: "2026-01-06T12:00:00-08:00", km: 5 },
      { start: "2026-01-09T12:00:00-08:00", km: 5 },
    ]);
    const result = streaks(equal, at("2026-01-20T12:00:00-08:00"));
    expect(result.longestRiding).toEqual({ days: 2, fromMs: midnight("2026-01-01"), toMs: midnight("2026-01-02") });
    expect(result.longestParked).toEqual({ days: 2, fromMs: midnight("2026-01-03"), toMs: midnight("2026-01-04") });
    expect([result.currentRiding, result.currentParked]).toEqual([0, 10]);
  });
});

describe("shortTrips", () => {
  it("measures the share of rides and of km under 5 km", () => {
    expect(SHORT_TRIP_KM).toBe(5);
    const result = shortTrips(
      rides([
        { start: "2026-05-01T08:00:00-07:00", km: 2 },
        { start: "2026-05-02T08:00:00-07:00", km: 4.999 },
        { start: "2026-05-03T08:00:00-07:00", km: 5 },
        { start: "2026-05-04T08:00:00-07:00", km: 20 },
      ]),
    );
    expect([result.rides, result.shortRides]).toEqual([4, 2]);
    expect(result.rideShare).toBe(0.5);
    expect(result.km).toBeCloseTo(31.999, 9);
    expect(result.shortKm).toBeCloseTo(6.999, 9);
    expect(result.kmShare).toBeCloseTo(6.999 / 31.999, 9);
  });

  it("is zero without rides instead of dividing by zero", () => {
    expect(shortTrips([])).toEqual({ rides: 0, shortRides: 0, km: 0, shortKm: 0, rideShare: 0, kmShare: 0 });
  });
});

describe("lastUseMs", () => {
  const vehicle = { status: null, batteryPercent: 80, lastCommunicationMs: 123_456, odometer: 1 };

  it("is the end of the last ride, or its start when the end is unknown", () => {
    const list = rides([
      { start: "2026-05-01T08:00:00-07:00", km: 2, minutes: 600 },
      { start: "2026-05-01T09:00:00-07:00", km: 2, minutes: 20 },
    ]);
    expect(lastUseMs(list, vehicle)).toBe(at("2026-05-01T18:00:00-07:00"));
    const open = rides([{ start: "2026-05-02T08:00:00-07:00", km: 2, minutes: null }]);
    expect(lastUseMs(open, vehicle)).toBe(at("2026-05-02T08:00:00-07:00"));
  });

  it("falls back to the vehicle's last communication without rides", () => {
    expect(lastUseMs([], vehicle)).toBe(123_456);
    expect(lastUseMs([], { ...vehicle, lastCommunicationMs: null })).toBeNull();
    expect(lastUseMs([], null)).toBeNull();
  });
});
