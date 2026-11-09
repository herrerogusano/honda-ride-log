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

export interface MonthComparison {
  readonly year: number;
  /** 0 (January) to 11. */
  readonly month: number;
  readonly km: number;
  readonly previousKm: number;
  readonly differenceKm: number;
}

/** Km of the current month against the same month a year earlier. */
export function monthVsLastYear(routes: readonly Route[], nowMs: number): MonthComparison {
  const now = new Date(nowMs);
  const year = now.getFullYear();
  const month = now.getMonth();
  let km = 0;
  let previousKm = 0;
  for (const route of routes) {
    const start = new Date(route.startMs);
    if (start.getMonth() !== month) continue;
    if (start.getFullYear() === year) km += route.distanceKm;
    else if (start.getFullYear() === year - 1) previousKm += route.distanceKm;
  }
  return { year, month, km, previousKm, differenceKm: km - previousKm };
}

export interface MonthlySeries {
  readonly year: number;
  /** Twelve values, January first. A month without routes is 0. */
  readonly km: readonly number[];
}

/** Km per month for the last `maxYears` years that have routes, oldest year first. */
export function kmByMonth(routes: readonly Route[], maxYears = 3): MonthlySeries[] {
  const years = yearsWithRoutes(routes).slice(0, maxYears).reverse();
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

  // `previous` is now the last riding day and `runStart` the start of its run.
  const gap = Math.max(0, localDay(nowMs) - previous);
  return {
    longestRiding,
    longestParked,
    currentRiding: gap <= 1 ? previous - runStart + 1 : 0,
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
