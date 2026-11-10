import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fold,
  formatDate,
  formatDateLong,
  formatDuration,
  formatIsoDate,
  formatKm,
  formatMonth,
  formatNumber,
  formatPercent,
  formatSpeed,
  formatTime,
  formatWholeKm,
  matchesSearch,
  MONTHS_LONG,
  MONTHS_SHORT,
  NBSP,
  WEEKDAYS_LONG,
  WEEKDAYS_SHORT,
  withUnit,
} from "../src/domain/format";
import { ride } from "./helpers";

// 03:00 UTC on 1 January 2026 is Wednesday 31 December 2025, 19:00, in Los
// Angeles, where the tests run.
const TRAP = Date.parse("2026-01-01T03:00:00Z");
const MORNING = Date.parse("2026-11-09T07:05:00-08:00");

describe("dates and times", () => {
  it("writes dates in the local zone, in Spanish", () => {
    expect(formatDate(MORNING)).toBe("9 nov 2026");
    expect(formatDate(TRAP)).toBe("31 dic 2025");
    expect(formatDateLong(MORNING)).toBe("lunes, 9 de noviembre de 2026");
    expect(formatDateLong(TRAP)).toBe("miércoles, 31 de diciembre de 2025");
    expect(formatDateLong(Date.parse("2026-11-08T12:00:00-08:00"))).toBe("domingo, 8 de noviembre de 2026");
    expect(formatIsoDate(MORNING)).toBe("2026-11-09");
    expect(formatIsoDate(TRAP)).toBe("2025-12-31");
    expect(formatIsoDate(Date.parse("2026-03-05T12:00:00-08:00"))).toBe("2026-03-05");
  });

  it("writes times with 24 hours and two digits", () => {
    expect(formatTime(MORNING)).toBe("07:05");
    expect(formatTime(TRAP)).toBe("19:00");
    expect(formatTime(Date.parse("2026-06-01T00:00:00-07:00"))).toBe("00:00");
  });

  it("names months and weekdays in order", () => {
    expect(formatMonth(2026, 0)).toBe("enero de 2026");
    expect(formatMonth(2025, 11)).toBe("diciembre de 2025");
    expect(MONTHS_LONG.length).toBe(12);
    expect(MONTHS_SHORT.join(" ")).toBe("ene feb mar abr may jun jul ago sep oct nov dic");
    expect(WEEKDAYS_LONG.join(" ")).toBe("lunes martes miércoles jueves viernes sábado domingo");
    expect(WEEKDAYS_SHORT.join(" ")).toBe("lun mar mié jue vie sáb dom");
  });

  it("writes durations in hours and minutes", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(20)).toBe("menos de 1\u00A0min");
    expect(formatDuration(1500)).toBe("25\u00A0min");
    expect(formatDuration(3540)).toBe("59\u00A0min");
    expect(formatDuration(3599)).toBe("1\u00A0h 00\u00A0min");
    expect(formatDuration(3900)).toBe("1\u00A0h 05\u00A0min");
    expect(formatDuration(9000)).toBe("2\u00A0h 30\u00A0min");
  });
});

describe("numbers", () => {
  it("uses Spanish separators and a fixed number of decimals", () => {
    expect(formatNumber(12345.67, 1)).toBe("12.345,7");
    expect(formatNumber(12345.67)).toBe("12.346");
    expect(formatNumber(7)).toBe("7");
    expect(formatNumber(6125)).toBe("6.125");
    expect(formatNumber(999)).toBe("999");
    expect(formatNumber(7, 2)).toBe("7,00");
    expect(formatNumber(-3.21, 1)).toBe("-3,2");
  });

  it("never writes a negative zero", () => {
    expect(formatNumber(-0.04, 1)).toBe("0,0");
    expect(formatNumber(-0.4)).toBe("0");
  });

  it("writes km with one decimal and shares as whole percentages", () => {
    expect(formatKm(8.26)).toBe("8,3\u00A0km");
    expect(formatKm(120)).toBe("120,0\u00A0km");
    expect(formatPercent(0.374)).toBe("37\u00A0%");
    expect(formatPercent(1)).toBe("100\u00A0%");
    expect(formatPercent(0)).toBe("0\u00A0%");
  });
});

describe("number and unit on one line", () => {
  const NO_BREAK = String.fromCharCode(0xa0);

  it("joins every number to its unit with a no-break space, and only there", () => {
    expect(NBSP).toBe(NO_BREAK);
    expect(withUnit("−236", "km")).toBe(`−236${NO_BREAK}km`);
    expect(formatWholeKm(6125.4)).toBe(`6.125${NO_BREAK}km`);
    expect(formatSpeed(58)).toBe(`58${NO_BREAK}km/h`);
    expect(formatKm(8.26)).toBe(`8,3${NO_BREAK}km`);
    expect(formatPercent(0.37)).toBe(`37${NO_BREAK}%`);
    expect(formatDuration(3900)).toBe(`1${NO_BREAK}h 05${NO_BREAK}min`);
    // A line may still break between two figures, never inside one.
    expect(formatDuration(3900).split(" ")).toEqual([`1${NO_BREAK}h`, `05${NO_BREAK}min`]);
    expect(formatSpeed(null)).toBe("—");
  });

  it("is written in the source as an escape, never as the invisible character itself", () => {
    // docs/PLAN.md, section 8: an agent's tool once slipped an invisible character into the source.
    const roots = ["src", "tests"].map((folder) => new URL(`../${folder}/`, import.meta.url));
    const files = roots.flatMap((root) =>
      (readdirSync(root, { recursive: true }) as string[]).filter((name) => /\.(ts|css)$/.test(name)).map((name) => new URL(name.replaceAll("\\", "/"), root)),
    );
    expect(files.length).toBeGreaterThan(40);
    const withRaw = files.filter((file) => readFileSync(file, "utf8").includes(NO_BREAK)).map((file) => file.pathname);
    expect(withRaw).toEqual([]);
  });
});

describe("search by date", () => {
  // Saturday 7 March 2026, 23:30 local: already Sunday 8 March in UTC.
  const saturday = ride({ start: "2026-03-07T23:30:00-08:00", km: 10 });

  it("folds case and accents", () => {
    expect(fold("Sábado MIÉRCOLES")).toBe("sabado miercoles");
  });

  it("finds a route by weekday, day, month and year, however they are typed", () => {
    for (const query of ["", "  ", "sabado", "Sábado", "marzo", "mar", "2026", "7 de marzo", "marzo 2026", "07/03/2026", "2026-03-07", "sáb 2026"]) {
      expect(matchesSearch(saturday, query), query).toBe(true);
    }
  });

  it("rejects what does not match, and needs every word to match", () => {
    for (const query of ["domingo", "abril", "2025", "08/03/2026", "sabado abril", "marzo 2025"]) {
      expect(matchesSearch(saturday, query), query).toBe(false);
    }
  });
});
