/**
 * Spanish text for dates, times and numbers. Dates and times use the
 * browser's time zone (the local getters of `Date`), the only zone the web
 * knows. Month and weekday names are written here instead of asking `Intl`,
 * so every browser and the tests give the same text.
 */
import type { Route } from "./model";

export const MONTHS_LONG = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
] as const;
export const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;
/** Monday first, like the weekday chart. */
export const WEEKDAYS_LONG = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"] as const;
export const WEEKDAYS_SHORT = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"] as const;

const pad = (value: number): string => String(value).padStart(2, "0");

/** `9 nov 2026`. */
export function formatDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

/** `lunes, 9 de noviembre de 2026`. */
export function formatDateLong(ms: number): string {
  const date = new Date(ms);
  const weekday = WEEKDAYS_LONG[(date.getDay() + 6) % 7];
  return `${weekday}, ${date.getDate()} de ${MONTHS_LONG[date.getMonth()]} de ${date.getFullYear()}`;
}

/** `2026-11-09`, for files and exports. */
export function formatIsoDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `07:05`, 24 hours. */
export function formatTime(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `noviembre de 2026`. */
export function formatMonth(year: number, month: number): string {
  return `${MONTHS_LONG[month]} de ${year}`;
}

/** `1 h 05 min`, `25 min`, `menos de 1 min`; a dash when unknown. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
}

const numberFormats = new Map<number, Intl.NumberFormat>();

/**
 * A number with Spanish separators (`12.345,6`) and a fixed number of decimals.
 * Thousands are always separated, also in four-digit numbers, so `6.125 km`
 * and `25.608 km` look alike side by side.
 */
export function formatNumber(value: number, decimals = 0): string {
  let format = numberFormats.get(decimals);
  if (format === undefined) {
    format = new Intl.NumberFormat("es-ES", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: "always",
    });
    numberFormats.set(decimals, format);
  }
  // Avoid "-0": a tiny negative rounds to zero and should read as zero.
  const text = format.format(value);
  return /^-0(,0+)?$/.test(text) ? text.slice(1) : text;
}

/** Kilometres of one ride: one decimal. */
export function formatKm(km: number): string {
  return `${formatNumber(km, 1)} km`;
}

/** A share between 0 and 1 as a whole percentage: `37 %`. */
export function formatPercent(share: number): string {
  return `${formatNumber(share * 100)} %`;
}

/** Lower case without accents, so "sabado" finds "sábado". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Folded words of a text, split at spaces and commas. */
function words(text: string): string[] {
  return fold(text).split(/[\s,]+/).filter((word) => word !== "");
}

/** Two-digit years are read as 20xx: `25` is 2025. */
const fullYear = (text: string): number => (text.length <= 2 ? 2000 + Number(text) : Number(text));

/**
 * Does one word of a query describe the date of the route?
 *
 * - A date with slashes or dashes, the day first, with or without the year
 *   and with or without leading zeros: `7/3`, `07/03/2026`, `7-3-26`.
 * - A date the other way round, the year first: `2026-03-07`, `2026-03`.
 * - A number alone: the day of the month or the year, the whole number. A
 *   `2` is the 2nd, never the beginning of 2025 or of the 20th.
 * - Anything else: the beginning of the weekday or of the month, without
 *   accents: `sab` finds Saturdays and `mar` finds March and Tuesdays.
 */
function wordMatches(route: Route, word: string): boolean {
  const date = new Date(route.startMs);
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();

  const dayFirst = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/.exec(word);
  if (dayFirst !== null) {
    const [, d, m, y] = dayFirst;
    return Number(d) === day && Number(m) === month && (y === undefined || fullYear(y) === year);
  }
  const yearFirst = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(word);
  if (yearFirst !== null) {
    const [, y, m, d] = yearFirst;
    return Number(y) === year && Number(m) === month && (d === undefined || Number(d) === day);
  }
  if (/^\d+$/.test(word)) return word.length <= 2 ? Number(word) === day : Number(word) === year;

  const names = [WEEKDAYS_LONG[(date.getDay() + 6) % 7] as string, MONTHS_LONG[date.getMonth()] as string, "de"];
  return names.some((name) => fold(name).startsWith(word));
}

/** True when every word of the query describes the date of the route. An empty query matches everything. */
export function matchesSearch(route: Route, query: string): boolean {
  return words(query).every((word) => wordMatches(route, word));
}
