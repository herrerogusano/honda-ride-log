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

/** A number with Spanish separators (`12.345,6`) and a fixed number of decimals. */
export function formatNumber(value: number, decimals = 0): string {
  let format = numberFormats.get(decimals);
  if (format === undefined) {
    format = new Intl.NumberFormat("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
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

/**
 * Text a route can be searched by: its date written in the ways a person
 * would type it (weekday, day, month by name and by number, year).
 */
export function searchText(route: Route): string {
  const date = new Date(route.startMs);
  const numeric = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
  return fold(`${formatDateLong(route.startMs)} ${MONTHS_SHORT[date.getMonth()]} ${numeric} ${formatIsoDate(route.startMs)}`);
}

/** True when every word of the query appears in the route's date text. */
export function matchesSearch(route: Route, query: string): boolean {
  const words = fold(query).split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return true;
  const text = searchText(route);
  return words.every((word) => text.includes(word));
}
