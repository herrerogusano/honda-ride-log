/**
 * The activity calendar of «03 Hábitos» (docs/PLAN.md, section 3): one grid
 * per year of the period, a column per week (Monday on top), a cell per day
 * coloured by its km in five levels. The aggregation is
 * `activityCalendar` in src/domain/stats.ts; this module only draws it.
 *
 * - Every cell has an accessible name (date, km and rides) and is reached
 *   with the keyboard: one tab stop per year, arrows move a day (↑ ↓) or a
 *   week (← →), Home and End go to the first and last day.
 * - Hovering, tapping or focusing a cell writes its day in the readout line.
 * - A table with the same figures per month sits under the grid, so nothing
 *   depends on seeing the colours.
 * - Cells appear column by column when their year is revealed (stylesheet,
 *   `.cal-year.in`); with reduced motion they are simply there.
 */
import { formatDateLong, formatKm, formatNumber, formatWholeKm, MONTHS_LONG, MONTHS_SHORT } from "../domain/format";
import { weekdayOfDay, type ActivityCalendar, type CalendarDay, type CalendarYear } from "../domain/stats";
import { el } from "./dom";

const rides = (count: number): string => `${formatNumber(count)} ${count === 1 ? "salida" : "salidas"}`;
const activeDays = (count: number): string => `${formatNumber(count)} ${count === 1 ? "día" : "días"} con al menos una salida`;

/** «lunes, 9 de marzo de 2026: 12,4 km, 2 salidas» or «…: sin salidas». */
export function dayLabel(day: CalendarDay): string {
  return `${formatDateLong(day.dayMs)}: ${day.rides === 0 ? "sin salidas" : `${formatKm(day.km)}, ${rides(day.rides)}`}`;
}

export const CALENDAR_HINT = "Pasa el cursor, toca o enfoca un día para ver sus km.";

/** The caption of the calendar: «N días con al menos una salida». */
export function calendarCaption(calendar: ActivityCalendar): string {
  return activeDays(calendar.activeDays);
}

function yearGrid(year: CalendarYear, onActive: (cell: HTMLElement, day: CalendarDay) => void): HTMLElement {
  const firstDay = year.days[0];
  // Week columns start on the Monday on or before 1 January.
  const origin = firstDay === undefined ? 0 : firstDay.day - weekdayOfDay(firstDay.day);
  const cells: HTMLElement[] = [];
  const months = el("div", { class: "cal-months", attrs: { "aria-hidden": "true" } });
  const grid = el("div", { class: "cal-grid" });
  let weeks = 0;
  for (const day of year.days) {
    const week = Math.floor((day.day - origin) / 7);
    weeks = week + 1;
    const date = new Date(day.dayMs);
    if (date.getDate() === 1) {
      const label = el("span", { class: "cal-month" }, MONTHS_SHORT[date.getMonth()] as string);
      label.style.setProperty("--w", String(week));
      months.append(label);
    }
    const cell = el("span", {
      class: `cal-cell l${day.level}`,
      attrs: { role: "img", tabindex: -1, "aria-label": dayLabel(day), "data-month": date.getMonth() },
    });
    cell.style.setProperty("--w", String(week));
    cell.style.setProperty("--r", String(weekdayOfDay(day.day)));
    cells.push(cell);
    grid.append(cell);
  }
  // One tab stop per year: the last day with a ride, or the last day shown.
  let current = cells.length - 1;
  for (let index = year.days.length - 1; index >= 0; index -= 1) {
    if ((year.days[index] as CalendarDay).rides > 0) {
      current = index;
      break;
    }
  }
  cells[current]?.setAttribute("tabindex", "0");

  const move = (to: number): void => {
    const target = cells[Math.min(cells.length - 1, Math.max(0, to))];
    if (target === undefined) return;
    cells[current]?.setAttribute("tabindex", "-1");
    current = cells.indexOf(target);
    target.setAttribute("tabindex", "0");
    target.focus();
  };
  grid.addEventListener("keydown", (event) => {
    const steps: Readonly<Record<string, number>> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };
    if (event.key in steps) move(current + (steps[event.key] as number));
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(cells.length - 1);
    else return;
    event.preventDefault();
  });
  const activate = (event: Event): void => {
    const cell = (event.target as Element | null)?.closest?.(".cal-cell");
    if (!(cell instanceof HTMLElement)) return;
    const index = cells.indexOf(cell);
    const day = year.days[index];
    if (day === undefined) return;
    if (event.type === "focusin") {
      cells[current]?.setAttribute("tabindex", "-1");
      current = index;
      cell.setAttribute("tabindex", "0");
    }
    onActive(cell, day);
  };
  for (const type of ["pointerover", "focusin", "click"]) grid.addEventListener(type, activate);

  const body = el("div", { class: "cal-body" }, months, grid);
  body.style.setProperty("--weeks", String(weeks));
  return el(
    "div",
    { class: "cal-year rv", attrs: { role: "group", "aria-label": `${year.year}: ${activeDays(year.activeDays)}` } },
    el("p", { class: "cal-year-title", attrs: { "aria-hidden": "true" } }, String(year.year), el("small", {}, activeDays(year.activeDays))),
    body,
  );
}

/** The same figures as the grid, month by month: days with a ride and km. */
function calendarTable(calendar: ActivityCalendar): HTMLElement {
  const tables = calendar.years.map((year) =>
    el(
      "table",
      { class: "data-table cal-table" },
      el("caption", {}, `${year.year}: ${activeDays(year.activeDays)}`),
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { attrs: { scope: "col" } }, "Mes"),
          el("th", { class: "num", attrs: { scope: "col" } }, "Días con salida"),
          el("th", { class: "num", attrs: { scope: "col" } }, "Km"),
        ),
      ),
      el(
        "tbody",
        {},
        ...year.months.map((month) =>
          el(
            "tr",
            {},
            el("th", { attrs: { scope: "row" } }, MONTHS_LONG[month.month] as string),
            el("td", { class: "num" }, formatNumber(month.activeDays)),
            el("td", { class: "num" }, formatWholeKm(month.km)),
          ),
        ),
      ),
    ),
  );
  return el("details", { class: "chart-data" }, el("summary", {}, "Ver los datos en tabla"), el("div", { class: "table-scroll" }, ...tables));
}

export function calendarView(calendar: ActivityCalendar): HTMLElement {
  const readout = el("p", { class: "chart-readout cal-readout" }, CALENDAR_HINT);
  let lit: HTMLElement | null = null;
  const onActive = (cell: HTMLElement, day: CalendarDay): void => {
    lit?.classList.remove("on");
    lit = cell;
    cell.classList.add("on");
    readout.replaceChildren(
      el("b", {}, formatDateLong(day.dayMs)),
      day.rides === 0 ? " · sin salidas" : ` · ${formatKm(day.km)} · ${rides(day.rides)}`,
    );
  };
  const scroll = el(
    "div",
    { class: "cal-scroll" },
    el("div", { class: "cal-years" }, ...calendar.years.map((year) => yearGrid(year, onActive))),
  );
  const legend = el(
    "div",
    { class: "cal-legend" },
    el("span", {}, "Menos"),
    el("span", { class: "cal-keys", attrs: { "aria-hidden": "true" } }, ...[0, 1, 2, 3, 4].map((level) => el("span", { class: `cal-cell l${level}` }))),
    el("span", {}, "Más"),
    el("span", { class: "cal-legend-note" }, "km por día · niveles por cuartiles de los días con salida"),
  );
  return el(
    "figure",
    { class: "cal" },
    readout,
    el("p", { class: "cal-swipe", attrs: { "aria-hidden": "true" } }, "Desliza para ver el año entero"),
    scroll,
    legend,
    calendarTable(calendar),
  );
}
