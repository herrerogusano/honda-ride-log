/**
 * CSV export of the routes on screen, with the same columns as the list:
 * date, start time, duration, km and average speed. It has no identifiers
 * and no coordinates: a `Route` carries neither in readable form.
 *
 * The format is the one a Spanish spreadsheet opens directly: semicolons,
 * decimal commas, CRLF line ends and a byte order mark.
 */
import { formatIsoDate, formatTime } from "./format";
import type { Route } from "./model";

/** Byte order mark: tells a spreadsheet the file is UTF-8. Built from its code so no invisible character sits in the source. */
const BOM = String.fromCharCode(0xfeff);

export const CSV_HEADER =["Fecha", "Hora de salida", "Duración (min)", "Km", "Velocidad media (km/h)"] as const;

/**
 * One cell, safe for a spreadsheet: a text starting with `=`, `+`, `-`, `@`,
 * tab or carriage return gets a leading apostrophe so it is not run as a
 * formula; separators, quotes and line breaks are quoted.
 */
export function csvCell(text: string): string {
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[;"\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

const decimal = (value: number, digits: number): string => value.toFixed(digits).replace(".", ",");

/** Rows of cells as one CSV text. Every cell goes through `csvCell`. */
export function rowsToCsv(rows: readonly (readonly string[])[]): string {
  return BOM + rows.map((row) => row.map(csvCell).join(";")).join("\r\n") + "\r\n";
}

export function routesToCsv(routes: readonly Route[]): string {
  const rows: string[][] = [[...CSV_HEADER]];
  for (const route of routes) {
    rows.push([
      formatIsoDate(route.startMs),
      formatTime(route.startMs),
      route.durationS === null ? "" : String(Math.round(route.durationS / 60)),
      decimal(route.distanceKm, 2),
      route.averageSpeed === null ? "" : decimal(route.averageSpeed, 1),
    ]);
  }
  return rowsToCsv(rows);
}
