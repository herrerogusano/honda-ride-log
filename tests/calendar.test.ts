// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { formatWholeKm, MONTHS_LONG } from "../src/domain/format";
import { activityCalendar, averageRideKm, localDay, peaks, weekdayOfDay } from "../src/domain/stats";
import { calendarCaption, calendarView, dayLabel, CALENDAR_HINT } from "../src/ui/calendar";
import { hourInsight, insightText, weekdayInsight } from "../src/ui/insights";
import type { RiderData } from "../src/ui/data";
import { renderRiderPage } from "../src/ui/summary";
import { rides } from "./helpers";

/**
 * The activity calendar of «03 Hábitos» and the sentences under the habit
 * charts (docs/PLAN.md, section 3). The tests run in Los Angeles, where
 * 8 March 2026 has 23 hours and 1 November 2026 has 25. "Now" is Monday
 * 9 November 2026 at noon there.
 */
const NOW = Date.parse("2026-11-09T12:00:00-08:00");
const NB = String.fromCharCode(0xa0);

describe("activityCalendar", () => {
  it("puts each ride on the local day of its start, across midnight, the DST changes and the turn of the year", () => {
    const list = rides([
      { start: "2026-01-01T03:00:00Z", km: 12 }, // 31 December 2025, 19:00 local
      { start: "2026-03-07T23:30:00-08:00", km: 4 }, // Saturday, just before midnight
      { start: "2026-03-08T00:10:00-08:00", km: 6 }, // Sunday, the 23-hour day, just after midnight
      { start: "2026-03-08T23:50:00-07:00", km: 1 }, // same Sunday, late
      { start: "2026-11-01T01:30:00-08:00", km: 3 }, // the 25-hour day, second 01:30
    ]);
    const year2026 = activityCalendar(list, 2026, NOW).years[0];
    const km = (iso: string): number | undefined => year2026?.days.find((day) => day.day === localDay(Date.parse(iso)))?.km;
    expect(km("2026-03-07T12:00:00-08:00")).toBe(4);
    expect(km("2026-03-08T12:00:00-07:00")).toBe(7);
    expect(km("2026-11-01T12:00:00-08:00")).toBe(3);
    // The ride of New Year's Eve, local time, is in 2025, not in 2026.
    expect(year2026?.days.some((day) => day.km === 12)).toBe(false);
    const year2025 = activityCalendar(list, 2025, NOW).years[0];
    expect(year2025?.days.at(-1)?.km).toBe(12);
    expect(new Date(year2025?.days.at(-1)?.dayMs ?? 0).getDate()).toBe(31);
  });

  it("draws every day of a past year, leap years included, and the current year up to today, each at local midnight", () => {
    const list = rides([{ start: "2024-05-05T10:00:00-07:00", km: 9 }]);
    const all = activityCalendar(list, "all", NOW);
    expect(all.years.map((year) => [year.year, year.days.length])).toEqual([
      [2024, 366],
      [2025, 365],
      [2026, 313],
    ]);
    for (const year of all.years) {
      year.days.forEach((day, index) => {
        if (index > 0) expect(day.day).toBe((year.days[index - 1]?.day ?? 0) + 1);
        const date = new Date(day.dayMs);
        expect([date.getHours(), date.getMinutes()]).toEqual([0, 0]);
      });
    }
    // 1 January 2026 is a Thursday: Monday-first weekday 3.
    expect(weekdayOfDay(all.years[2]?.days[0]?.day ?? 0)).toBe(3);
    expect(new Date(all.years[2]?.days.at(-1)?.dayMs ?? 0).getDate()).toBe(9);
  });

  it("splits the days with km into four levels by quartile; a day without rides is level 0", () => {
    const list = rides([1, 2, 3, 4, 5, 6, 7, 8].map((km, index) => ({ start: `2026-02-${String(index + 2).padStart(2, "0")}T10:00:00-08:00`, km })));
    const calendar = activityCalendar(list, 2026, NOW);
    expect(calendar.thresholds).toEqual([2, 4, 6]);
    const levels = calendar.years[0]?.days.filter((day) => day.rides > 0).map((day) => day.level);
    expect(levels).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(calendar.years[0]?.days.filter((day) => day.rides === 0).every((day) => day.level === 0)).toBe(true);
    // Two rides the same day add up before the levels are set.
    const two = activityCalendar(rides([{ start: "2026-02-02T08:00:00-08:00", km: 1 }, { start: "2026-02-02T18:00:00-08:00", km: 1 }]), 2026, NOW);
    expect(two.years[0]?.days.find((day) => day.rides > 0)).toMatchObject({ km: 2, rides: 2, level: 1 });
  });

  it("follows the period: one year, or every year from the first ride to now, with an empty year in between", () => {
    const list = rides([
      { start: "2024-06-01T10:00:00-07:00", km: 10 },
      { start: "2026-06-01T10:00:00-07:00", km: 20 },
    ]);
    const year = activityCalendar(list, 2026, NOW);
    expect(year.years.map((one) => one.year)).toEqual([2026]);
    expect(year.activeDays).toBe(1);
    expect(year.years[0]?.km).toBe(20);
    // The levels come from the days of the period only: the 2024 ride does not move them.
    expect(year.thresholds).toEqual([20, 20, 20]);
    const all = activityCalendar(list, "all", NOW);
    expect(all.years.map((one) => [one.year, one.activeDays, one.km])).toEqual([
      [2024, 1, 10],
      [2025, 0, 0],
      [2026, 1, 20],
    ]);
    const empty = activityCalendar(list, 2025, NOW);
    expect([empty.activeDays, empty.years[0]?.days.length, empty.years[0]?.days.every((day) => day.level === 0)]).toEqual([0, 365, true]);
    expect(calendarCaption(empty)).toBe("0 días con al menos una salida");
    expect(calendarCaption(all)).toBe("2 días con al menos una salida");
  });

  it("sums each month from the same days as the grid", () => {
    const list = rides([
      { start: "2026-03-01T10:00:00-08:00", km: 10 },
      { start: "2026-03-01T18:00:00-08:00", km: 5 },
      { start: "2026-03-31T10:00:00-07:00", km: 2.5 },
      { start: "2026-04-01T10:00:00-07:00", km: 7 },
    ]);
    const year = activityCalendar(list, 2026, NOW).years[0];
    expect(year?.months.find((month) => month.month === 2)).toEqual({ month: 2, activeDays: 2, km: 17.5 });
    expect(year?.months.find((month) => month.month === 3)).toEqual({ month: 3, activeDays: 1, km: 7 });
    expect(year?.months).toHaveLength(11);
  });
});

describe("the calendar on the page", () => {
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  });

  const list = rides([
    { start: "2026-01-05T10:00:00-08:00", km: 30 },
    { start: "2026-01-05T19:00:00-08:00", km: 2 },
    { start: "2026-02-10T10:00:00-08:00", km: 12.4 },
    { start: "2026-10-31T10:00:00-07:00", km: 80 },
  ]);

  it("names every cell with its date and km, and its table holds the same days and km per month", () => {
    const calendar = activityCalendar(list, 2026, NOW);
    const view = calendarView(calendar);
    const cells = [...view.querySelectorAll(".cal-grid .cal-cell")];
    const days = calendar.years[0]?.days ?? [];
    expect(cells.map((cell) => cell.getAttribute("aria-label"))).toEqual(days.map(dayLabel));
    expect(cells[4]?.getAttribute("aria-label")).toBe(`lunes, 5 de enero de 2026: 32,0${NB}km, 2 salidas`);
    expect(cells[5]?.getAttribute("aria-label")).toBe("martes, 6 de enero de 2026: sin salidas");
    expect(cells.every((cell) => cell.getAttribute("role") === "img")).toBe(true);
    // The table, month by month, equals the cells.
    const rows = [...view.querySelectorAll(".cal-table tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent));
    const fromCells = MONTHS_LONG.slice(0, 11).map((name, month) => {
      const mine = days.filter((day) => new Date(day.dayMs).getMonth() === month);
      const active = cells.filter((cell) => cell.getAttribute("data-month") === String(month) && !cell.classList.contains("l0"));
      return [name, String(active.length), formatWholeKm(mine.reduce((sum, day) => sum + day.km, 0))];
    });
    expect(rows).toEqual(fromCells);
    expect(rows[0]).toEqual(["enero", "1", `32${NB}km`]);
    // Level classes come from the data, and the legend shows the five levels.
    expect(cells.filter((cell) => !cell.classList.contains("l0"))).toHaveLength(3);
    expect(view.querySelectorAll(".cal-legend .cal-cell")).toHaveLength(5);
  });

  it("places each day in its week column and weekday row, with month labels over the weeks", () => {
    const view = calendarView(activityCalendar(list, 2026, NOW));
    const first = view.querySelector(".cal-grid .cal-cell") as HTMLElement;
    // Thursday 1 January: the first column, the fourth row.
    expect([first.style.getPropertyValue("--w"), first.style.getPropertyValue("--r")]).toEqual(["0", "3"]);
    const fifth = view.querySelectorAll<HTMLElement>(".cal-grid .cal-cell")[4] as HTMLElement;
    expect([fifth.style.getPropertyValue("--w"), fifth.style.getPropertyValue("--r")]).toEqual(["1", "0"]);
    expect([...view.querySelectorAll(".cal-month")].map((label) => label.textContent)).toEqual(["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov"]);
  });

  it("answers the pointer and the keyboard: the readout says the day, arrows move by day and week", () => {
    const view = calendarView(activityCalendar(list, 2026, NOW));
    document.body.replaceChildren(view);
    const readout = view.querySelector(".cal-readout") as HTMLElement;
    expect(readout.textContent).toBe(CALENDAR_HINT);
    const cells = [...view.querySelectorAll<HTMLElement>(".cal-grid .cal-cell")];
    // One tab stop per year: the last day with a ride.
    expect(cells.filter((cell) => cell.tabIndex === 0)).toEqual([cells[303]]);
    cells[4]?.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(readout.textContent).toBe(`lunes, 5 de enero de 2026 · 32,0${NB}km · 2 salidas`);
    expect(cells[4]?.classList.contains("on")).toBe(true);
    cells[4]?.focus();
    cells[4]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(cells[11]);
    cells[11]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(cells[10]);
    expect(readout.textContent).toBe("domingo, 11 de enero de 2026 · sin salidas");
    expect(cells.filter((cell) => cell.tabIndex === 0)).toEqual([cells[10]]);
    cells[10]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement).toBe(cells[3]);
    cells[3]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(cells.at(-1));
  });

  it("counts only the rides of the figures, so short routes left out of them are left out of the calendar", () => {
    const short = rides([{ start: "2026-03-03T10:00:00-08:00", km: 0.2 }]);
    const data: RiderData = {
      vehicle: { status: null, batteryPercent: null, lastCommunicationMs: null, odometer: null },
      info: null,
      routes: list,
      figures: list,
      hiddenShort: short.length,
      shortCounted: false,
      skipped: 0,
      demo: true,
      nowMs: NOW,
    };
    const page = renderRiderPage(data, "demo");
    const habits = page.sections.find((one) => one.id === "habitos")?.element as HTMLElement;
    expect(habits.querySelector(".cal-caption")?.textContent).toBe("3 días con al menos una salida");
    const withShort = renderRiderPage({ ...data, figures: [...list, ...short], shortCounted: true }, "demo");
    const counted = withShort.sections.find((one) => one.id === "habitos")?.element as HTMLElement;
    expect(counted.querySelector(".cal-caption")?.textContent).toBe("4 días con al menos una salida");
  });
});

describe("the sentences under the habit charts", () => {
  it("names the favourite hour and the leading weekday from the very counts of the charts", () => {
    const hours = new Array<number>(24).fill(0);
    hours[8] = 79;
    hours[18] = 61;
    expect(insightText(hourInsight(hours))).toBe("Tu hora favorita: 8:00–8:59 · 79 salidas.");
    expect(hourInsight(hours)[1]).toBe("8:00–8:59");
    const days = [10, 20, 30, 78, 5, 1, 0];
    expect(insightText(weekdayInsight(days))).toBe("El jueves lidera con 78 salidas.");
    expect(weekdayInsight(days)[1]).toBe("jueves");
  });

  it("names every leader on a tie, uses the singular, and says so when there are no rides", () => {
    expect(insightText(weekdayInsight([3, 0, 3, 0, 3, 0, 0]))).toBe("Empatan lunes, miércoles y viernes con 3 salidas cada uno.");
    const hours = new Array<number>(24).fill(0);
    hours[7] = 1;
    hours[19] = 1;
    expect(insightText(hourInsight(hours))).toBe("Tus horas favoritas: 7:00–7:59 y 19:00–19:59 · 1 salida cada una.");
    expect(insightText(hourInsight(new Array<number>(24).fill(0)))).toBe("Sin salidas en este periodo.");
    expect(insightText(weekdayInsight([0, 0, 0, 0, 0, 0, 0]))).toBe("Sin salidas en este periodo.");
    expect(peaks([0, 2, 2, 1])).toEqual([1, 2]);
  });

  it("works out the average ride from the same total km and rides", () => {
    expect(averageRideKm(rides([{ start: "2026-01-05T10:00:00-08:00", km: 10 }, { start: "2026-01-06T10:00:00-08:00", km: 5 }]))).toBe(7.5);
    expect(averageRideKm([])).toBe(0);
  });
});
