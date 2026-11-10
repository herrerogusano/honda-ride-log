/**
 * The sentence under the weekday and hour charts (docs/PLAN.md, section
 * 3, «Hábitos»): the busiest hour or weekday, read from the very counts the
 * chart draws. On a tie every leader is named; with no rides there is no
 * leader.
 *
 * Each sentence comes in three parts so the page can set the key words in
 * bold: `[before, key, after]`; joined, they are the plain sentence.
 */
import { formatNumber, WEEKDAYS_LONG } from "../domain/format";
import { peaks } from "../domain/stats";

export type Insight = readonly [string, string, string];

const rides = (count: number): string => `${formatNumber(count)} ${count === 1 ? "salida" : "salidas"}`;

/** «a, b y c». */
function list(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

/** `8:00–8:59`: the whole hour of the start. */
export function hourSpan(hour: number): string {
  return `${hour}:00–${hour}:59`;
}

/** «Tu hora favorita: 8:00–8:59 · 79 salidas.» */
export function hourInsight(counts: readonly number[]): Insight {
  const top = peaks(counts);
  const first = top[0];
  if (first === undefined) return ["", "", "Sin salidas en este periodo."];
  const count = counts[first] as number;
  if (top.length === 1) return ["Tu hora favorita: ", hourSpan(first), ` · ${rides(count)}.`];
  return ["Tus horas favoritas: ", list(top.map(hourSpan)), ` · ${rides(count)} cada una.`];
}

/** «El jueves lidera con 78 salidas.» */
export function weekdayInsight(counts: readonly number[]): Insight {
  const top = peaks(counts);
  const first = top[0];
  if (first === undefined) return ["", "", "Sin salidas en este periodo."];
  const count = counts[first] as number;
  const names = top.map((index) => WEEKDAYS_LONG[index] as string);
  if (top.length === 1) return ["El ", names[0] as string, ` lidera con ${rides(count)}.`];
  return ["Empatan ", list(names), ` con ${rides(count)} cada uno.`];
}

export const insightText = (insight: Insight): string => insight.join("");
