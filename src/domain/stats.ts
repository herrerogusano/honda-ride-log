/**
 * Every figure of the Resumen tab, computed in the browser from sanitized
 * routes (docs/PLAN.md, "Diseño de las tres pestañas").
 *
 * The day, month, weekday and hour of a route are those of its start instant
 * in the browser's time zone: this module reads dates only through the local
 * getters of `Date`. Weeks start on Monday.
 *
 * Callers decide which routes count (see `src/config.ts`); nothing here
 * filters short routes.
 */
import type { Route, VehicleState } from "./model";

const DAY_MS = 86_400_000;

/** Rides shorter than this are "trayectos cortos". */
export const SHORT_TRIP_KM = 5;

/** A calendar year, or the whole history. */
export type Period = number | "all";

/**
 * Number of the local calendar day of an instant. Consecutive calendar days
 * have consecutive numbers, whatever the daylight saving changes.
 */
export function localDay(ms: number): number {
  const date = new Date(ms);
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/** Local midnight (epoch milliseconds) at the start of a day number. */
export function dayStartMs(day: number): number {
  const utc = new Date(day * DAY_MS);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate()).getTime();
}

export function yearOf(route: Route): number {
  return new Date(route.startMs).getFullYear();
}

/** Years with at least one route, newest first. */
export function yearsWithRoutes(routes: readonly Route[]): number[] {
  return [...new Set(routes.map(yearOf))].sort((a, b) => b - a);
}

export function inPeriod(routes: readonly Route[], period: Period): readonly Route[] {
  return period === "all" ? routes : routes.filter((route) => yearOf(route) === period);
}

export interface Totals {
  readonly km: number;
  readonly rides: number;
  /** Sum of the known durations, in hours. */
  readonly hours: number;
  /** Rides whose duration the service did not give; they add nothing to `hours`. */
  readonly ridesWithoutDuration: number;
}

export function totals(routes: readonly Route[]): Totals {
  let km = 0;
  let seconds = 0;
  let ridesWithoutDuration = 0;
  for (const route of routes) {
    km += route.distanceKm;
    if (route.durationS === null) ridesWithoutDuration += 1;
    else seconds += route.durationS;
  }
  return { km, rides: routes.length, hours: seconds / 3600, ridesWithoutDuration };
}

/** What the month is compared with: the same month of the year before, or the mean of the same month of earlier years. */
export type MonthBaseline =
  | { readonly kind: "year"; readonly year: number; readonly km: number }
  | { readonly kind: "average"; readonly years: readonly number[]; readonly km: number };

export interface MonthComparison {
  /** The year of the month shown: the chosen one, or the current one with the whole history. */
  readonly year: number;
  /** 0 (January) to 11: always the current month of the local clock. */
  readonly month: number;
  /** "year" with a chosen year, "average" with the whole history (even when `baseline` is null). */
  readonly against: "year" | "average";
  /**
   * The last day of the month that is compared, 1 to 31. While the month is
   * in progress it is today: days 1 to today in every year. Once it is over,
   * the whole month (in a shorter month of another year, its last day).
   */
  readonly throughDay: number;
  readonly km: number;
  /** What `km` is compared with, or null when the history does not reach back to any such days. */
  readonly baseline: MonthBaseline | null;
  /** `km` minus the baseline, or null without one. */
  readonly differenceKm: number | null;
  /** True when the month shown is the current one, not yet over: only its first `throughDay` days count. */
  readonly inProgress: boolean;
  /** Local midnight of the day of the first route of the history, or null without routes. */
  readonly historyStartMs: number | null;
}

/**
 * The fourth figure of section 01. The month is always the current month of
 * the local clock. With a year Y it is that month of Y against the same month
 * of Y − 1. With the whole history it is that month of the current year
 * against the mean of the same month in every earlier year that the history
 * covers (a covered month without rides counts as 0 km).
 *
 * The comparison is fair: while the month is in progress, every year counts
 * only days 1 to today of it (in a shorter month, up to its last day); once
 * it is over, the whole month against the whole month. The days of a year
 * are covered when the first route of the history starts before their end:
 * days that all come before the first route are not in the history, they are
 * never compared as 0, they are left out (no baseline when nothing is left).
 */
export function monthComparison(routes: readonly Route[], nowMs: number, period: Period): MonthComparison {
  const now = new Date(nowMs);
  const month = now.getMonth();
  const year = period === "all" ? now.getFullYear() : period;
  const inProgress = year === now.getFullYear();
  const throughDay = inProgress ? now.getDate() : 31;
  const lastDay = (y: number): number => Math.min(throughDay, new Date(y, month + 1, 0).getDate());
  const kmOf = new Map<number, number>();
  let firstMs = Infinity;
  for (const route of routes) {
    firstMs = Math.min(firstMs, route.startMs);
    const start = new Date(route.startMs);
    if (start.getMonth() !== month || start.getDate() > lastDay(start.getFullYear())) continue;
    kmOf.set(start.getFullYear(), (kmOf.get(start.getFullYear()) ?? 0) + route.distanceKm);
  }
  // The end of the compared days of a year: local midnight after its last one.
  const covered = (y: number): boolean => firstMs < new Date(y, month, lastDay(y) + 1).getTime();
  const km = kmOf.get(year) ?? 0;
  let baseline: MonthBaseline | null = null;
  if (period !== "all") {
    if (covered(year - 1)) baseline = { kind: "year", year: year - 1, km: kmOf.get(year - 1) ?? 0 };
  } else if (Number.isFinite(firstMs)) {
    const years: number[] = [];
    for (let y = new Date(firstMs).getFullYear(); y < year; y += 1) if (covered(y)) years.push(y);
    if (years.length > 0) {
      const sum = years.reduce((total, y) => total + (kmOf.get(y) ?? 0), 0);
      baseline = { kind: "average", years, km: sum / years.length };
    }
  }
  return {
    year,
    month,
    against: period === "all" ? "average" : "year",
    throughDay: lastDay(year),
    km,
    baseline,
    differenceKm: baseline === null ? null : km - baseline.km,
    inProgress,
    historyStartMs: Number.isFinite(firstMs) ? dayStartMs(localDay(firstMs)) : null,
  };
}

export interface MonthlySeries {
  readonly year: number;
  /** Twelve values, January first. A month without routes is 0. */
  readonly km: readonly number[];
}

/**
 * Km per month for the chart of section «Ritmo», oldest year first: the
 * `maxYears` latest years with routes, whatever `year` is, and `year`
 * always (even without routes). When `year` is not among them it takes the
 * place of the oldest of them, so there are never more than `maxYears`.
 */
export function kmByMonth(routes: readonly Route[], year: number, maxYears = 3): MonthlySeries[] {
  const count = Math.max(1, maxYears);
  const latest = yearsWithRoutes(routes).slice(0, count);
  const years = (latest.includes(year) ? latest : [...latest.slice(0, count - 1), year]).sort((a, b) => a - b);
  const series = new Map(years.map((year) => [year, new Array<number>(12).fill(0)]));
  for (const route of routes) {
    const start = new Date(route.startMs);
    const months = series.get(start.getFullYear());
    if (months !== undefined) months[start.getMonth()] = (months[start.getMonth()] as number) + route.distanceKm;
  }
  return years.map((year) => ({ year, km: series.get(year) as number[] }));
}

/** Rides per weekday of the start; index 0 is Monday, 6 is Sunday. */
export function ridesByWeekday(routes: readonly Route[]): number[] {
  const counts = new Array<number>(7).fill(0);
  for (const route of routes) {
    const index = (new Date(route.startMs).getDay() + 6) % 7;
    counts[index] = (counts[index] as number) + 1;
  }
  return counts;
}

/** Rides per hour of the start, 0 to 23. */
export function ridesByHour(routes: readonly Route[]): number[] {
  const counts = new Array<number>(24).fill(0);
  for (const route of routes) {
    const hour = new Date(route.startMs).getHours();
    counts[hour] = (counts[hour] as number) + 1;
  }
  return counts;
}

export interface Records {
  readonly longestRide: { readonly km: number; readonly startMs: number } | null;
  /** The day with most km; `dayMs` is the local midnight of that day. */
  readonly bestDay: { readonly km: number; readonly dayMs: number } | null;
  readonly bestMonth: { readonly km: number; readonly year: number; readonly month: number } | null;
}

/** The longest ride and the day and month with most km. On a tie, the earliest wins. */
export function records(routes: readonly Route[]): Records {
  const ordered = [...routes].sort((a, b) => a.startMs - b.startMs);
  let longestRide: Records["longestRide"] = null;
  const byDay = new Map<number, number>();
  const byMonth = new Map<number, number>();
  for (const route of ordered) {
    if (longestRide === null || route.distanceKm > longestRide.km) {
      longestRide = { km: route.distanceKm, startMs: route.startMs };
    }
    const start = new Date(route.startMs);
    const day = localDay(route.startMs);
    const month = start.getFullYear() * 12 + start.getMonth();
    byDay.set(day, (byDay.get(day) ?? 0) + route.distanceKm);
    byMonth.set(month, (byMonth.get(month) ?? 0) + route.distanceKm);
  }
  // Maps keep insertion order and routes were visited oldest first, so the
  // first maximum found is the earliest.
  const top = (sums: Map<number, number>): [number, number] | null => {
    let best: [number, number] | null = null;
    for (const entry of sums) if (best === null || entry[1] > best[1]) best = entry;
    return best;
  };
  const day = top(byDay);
  const month = top(byMonth);
  return {
    longestRide,
    bestDay: day === null ? null : { km: day[1], dayMs: dayStartMs(day[0]) },
    bestMonth: month === null ? null : { km: month[1], year: Math.floor(month[0] / 12), month: month[0] % 12 },
  };
}

export interface Streak {
  readonly days: number;
  /** Local midnight of the first and of the last day of the streak. */
  readonly fromMs: number;
  readonly toMs: number;
}

export interface Streaks {
  /** Longest run of consecutive days with at least one ride. */
  readonly longestRiding: Streak | null;
  /** Longest run of whole days without a ride, between the first and the last ride. */
  readonly longestParked: Streak | null;
  /**
   * Consecutive riding days up to today. Today is not over, so a run that
   * reached yesterday is still alive; it is 0 only if neither today nor
   * yesterday has a ride.
   */
  readonly currentRiding: number;
  /** Whole days without a ride since the last one; today does not count until it ends. */
  readonly currentParked: number;
}

export function streaks(routes: readonly Route[], nowMs: number): Streaks {
  const days = [...new Set(routes.map((route) => localDay(route.startMs)))].sort((a, b) => a - b);
  const none: Streaks = { longestRiding: null, longestParked: null, currentRiding: 0, currentParked: 0 };
  const first = days[0];
  if (first === undefined) return none;

  const streak = (from: number, to: number): Streak => ({
    days: to - from + 1,
    fromMs: dayStartMs(from),
    toMs: dayStartMs(to),
  });
  let longestRiding = streak(first, first);
  let longestParked: Streak | null = null;
  let runStart = first;
  let previous = first;
  for (const day of days.slice(1)) {
    if (day === previous + 1) {
      if (day - runStart + 1 > longestRiding.days) longestRiding = streak(runStart, day);
    } else {
      runStart = day;
      const parked = day - previous - 1;
      if (longestParked === null || parked > longestParked.days) longestParked = streak(previous + 1, day - 1);
    }
    previous = day;
  }

  // The runs in progress look only at days up to today: a ride dated in the
  // future (a wrong clock, here or in the service) is not part of them.
  const today = localDay(nowMs);
  const past = days.filter((day) => day <= today);
  const last = past[past.length - 1];
  if (last === undefined) return { longestRiding, longestParked, currentRiding: 0, currentParked: 0 };
  let currentStart = last;
  for (let index = past.length - 2; index >= 0 && past[index] === currentStart - 1; index -= 1) currentStart -= 1;
  const gap = today - last;
  return {
    longestRiding,
    longestParked,
    currentRiding: gap <= 1 ? last - currentStart + 1 : 0,
    currentParked: Math.max(0, gap - 1),
  };
}

export interface ShortTrips {
  readonly rides: number;
  readonly shortRides: number;
  readonly km: number;
  readonly shortKm: number;
  /** 0 to 1; 0 when there are no rides. */
  readonly rideShare: number;
  readonly kmShare: number;
}

/** Which part of the rides and of the km comes from rides under `SHORT_TRIP_KM`. */
export function shortTrips(routes: readonly Route[]): ShortTrips {
  let km = 0;
  let shortKm = 0;
  let shortRides = 0;
  for (const route of routes) {
    km += route.distanceKm;
    if (route.distanceKm < SHORT_TRIP_KM) {
      shortRides += 1;
      shortKm += route.distanceKm;
    }
  }
  return {
    rides: routes.length,
    shortRides,
    km,
    shortKm,
    rideShare: routes.length === 0 ? 0 : shortRides / routes.length,
    kmShare: km === 0 ? 0 : shortKm / km,
  };
}

/** Monday-first weekday (0 Monday … 6 Sunday) of a local day number from `localDay`. */
export function weekdayOfDay(day: number): number {
  // Day 0 is Thursday 1 January 1970.
  return (((day + 3) % 7) + 7) % 7;
}

/** Intensity of a calendar day: 0 without km, 1 to 4 by quartile of the days with km. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface CalendarDay {
  /** Local day number (`localDay`). */
  readonly day: number;
  /** Local midnight of the day. */
  readonly dayMs: number;
  readonly km: number;
  readonly rides: number;
  readonly level: HeatLevel;
}

export interface CalendarMonth {
  /** 0 (January) to 11. */
  readonly month: number;
  readonly activeDays: number;
  readonly km: number;
}

export interface CalendarYear {
  readonly year: number;
  /** Every day from 1 January to 31 December, or to today in the current year; oldest first. */
  readonly days: readonly CalendarDay[];
  /** Twelve months (or up to the current one), with the same days and km as `days`. */
  readonly months: readonly CalendarMonth[];
  readonly activeDays: number;
  readonly km: number;
}

export interface ActivityCalendar {
  /** One grid per year of the period, oldest first. */
  readonly years: readonly CalendarYear[];
  /** Days with at least one ride in the whole period. */
  readonly activeDays: number;
  /**
   * Upper bounds (inclusive) of levels 1, 2 and 3: the quartiles of the km of
   * the days with km in the whole period. A day above the third is level 4.
   */
  readonly thresholds: readonly [number, number, number];
}

/**
 * Km per local day for the activity calendar (docs/PLAN.md, section 3): a
 * view of the same rides as the figures, the day being the local day of the
 * start. The years are those of the period: the chosen one, or for "all"
 * every year from the first ride to the current year. Days after today are
 * left out of the current year.
 */
export function activityCalendar(routes: readonly Route[], period: Period, nowMs: number): ActivityCalendar {
  const chosen = inPeriod(routes, period);
  const byDay = new Map<number, { km: number; rides: number }>();
  for (const route of chosen) {
    const day = localDay(route.startMs);
    const sum = byDay.get(day) ?? { km: 0, rides: 0 };
    sum.km += route.distanceKm;
    sum.rides += 1;
    byDay.set(day, sum);
  }
  const currentYear = new Date(nowMs).getFullYear();
  let years: number[];
  if (period !== "all") years = [period];
  else {
    const withRides = yearsWithRoutes(chosen);
    const first = withRides.length === 0 ? currentYear : Math.min(...withRides);
    const last = Math.max(currentYear, ...withRides);
    years = Array.from({ length: last - first + 1 }, (_, index) => first + index);
  }

  // Quartiles of the days that have km (nearest rank), so each level holds about a quarter of them.
  const active = [...byDay.values()].map((sum) => sum.km).filter((km) => km > 0).sort((a, b) => a - b);
  const rank = (share: number): number => active[Math.max(0, Math.ceil(share * active.length) - 1)] ?? 0;
  const thresholds: [number, number, number] = [rank(0.25), rank(0.5), rank(0.75)];
  const level = (km: number): HeatLevel => {
    if (!(km > 0)) return 0;
    if (km <= thresholds[0]) return 1;
    if (km <= thresholds[1]) return 2;
    return km <= thresholds[2] ? 3 : 4;
  };

  const today = localDay(nowMs);
  const calendarYears = years.map((year): CalendarYear => {
    const first = localDay(new Date(year, 0, 1, 12).getTime());
    const last = Math.min(localDay(new Date(year, 11, 31, 12).getTime()), year === currentYear ? today : Infinity);
    const days: CalendarDay[] = [];
    const months = new Map<number, { activeDays: number; km: number }>();
    for (let day = first; day <= last; day += 1) {
      const sum = byDay.get(day);
      const km = sum?.km ?? 0;
      const dayMs = dayStartMs(day);
      // A day with a ride of 0 km still has a ride: the lowest level, never "no ride".
      days.push({ day, dayMs, km, rides: sum?.rides ?? 0, level: sum === undefined ? 0 : (Math.max(1, level(km)) as HeatLevel) });
      const month = new Date(dayMs).getMonth();
      const total = months.get(month) ?? { activeDays: 0, km: 0 };
      if (sum !== undefined) {
        total.activeDays += 1;
        total.km += km;
      }
      months.set(month, total);
    }
    const monthList = [...months].map(([month, total]) => ({ month, ...total }));
    return {
      year,
      days,
      months: monthList,
      activeDays: monthList.reduce((sum, one) => sum + one.activeDays, 0),
      km: monthList.reduce((sum, one) => sum + one.km, 0),
    };
  });
  return { years: calendarYears, activeDays: calendarYears.reduce((sum, one) => sum + one.activeDays, 0), thresholds };
}

/**
 * Indexes of the largest count (several on a tie), or none when every count
 * is 0. Used for the sentence under the weekday and hour charts.
 */
export function peaks(counts: readonly number[]): number[] {
  const top = Math.max(0, ...counts);
  if (top === 0) return [];
  return counts.flatMap((count, index) => (count === top ? [index] : []));
}

/** Average km per ride of a set of rides: total km over rides; 0 without rides. */
export function averageRideKm(routes: readonly Route[]): number {
  const sum = totals(routes);
  return sum.rides === 0 ? 0 : sum.km / sum.rides;
}

/**
 * Last use of the bike: the end of the last ride (its start if the end is
 * unknown); without rides, the vehicle's last communication.
 */
export function lastUseMs(routes: readonly Route[], vehicle: VehicleState | null): number | null {
  let last: number | null = null;
  for (const route of routes) {
    const moment = route.endMs ?? route.startMs;
    if (last === null || moment > last) last = moment;
  }
  return last ?? vehicle?.lastCommunicationMs ?? null;
}
