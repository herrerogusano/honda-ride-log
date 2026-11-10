import { describe, expect, it } from "vitest";
import { csvCell, routesToCsv, rowsToCsv } from "../src/domain/csv";
import { fold, formatDuration, formatNumber, formatPercent, matchesSearch } from "../src/domain/format";
import { monthVsLastYear, records, totals } from "../src/domain/stats";
import { ride, rides } from "./helpers";

/** Cases an independent review found without a test. The tests run in Los Angeles. */
const BOM = String.fromCharCode(0xfeff);

describe("statistics, edge cases", () => {
  it("finds the records whatever the order of the rides", () => {
    const list = rides([
      { start: "2025-02-01T09:00:00-08:00", km: 40 },
      { start: "2025-03-01T09:00:00-08:00", km: 40 },
      { start: "2025-03-02T09:00:00-08:00", km: 1 },
    ]).reverse();
    const result = records(list);
    // On a tie the earliest wins, also when the list arrives newest first.
    expect(result.longestRide?.startMs).toBe(Date.parse("2025-02-01T09:00:00-08:00"));
    expect(result.bestDay?.dayMs).toBe(Date.parse("2025-02-01T00:00:00-08:00"));
    expect(result.bestMonth).toEqual({ km: 41, year: 2025, month: 2 });
  });

  it("compares this month only with the same month one year earlier, not with later or older years", () => {
    const result = monthVsLastYear(
      rides([
        { start: "2026-11-02T08:00:00-08:00", km: 10 },
        { start: "2027-11-02T08:00:00-08:00", km: 500 },
        { start: "2025-11-02T08:00:00-08:00", km: 3 },
        { start: "2024-11-02T08:00:00-08:00", km: 70 },
      ]),
      Date.parse("2026-11-09T12:00:00-08:00"),
    );
    expect([result.km, result.previousKm, result.differenceKm]).toEqual([10, 3, 7]);
  });

  it("adds up durations of a day or more", () => {
    const result = totals(rides([{ start: "2026-05-01T08:00:00-07:00", km: 900, minutes: 36 * 60 }, { start: "2026-05-04T08:00:00-07:00", km: 1, minutes: 30 }]));
    expect(result.hours).toBeCloseTo(36.5, 9);
  });
});

describe("formatting, edge cases", () => {
  it("rounds shares to the nearest whole percentage", () => {
    expect(formatPercent(0.376)).toBe("38 %");
    expect(formatPercent(0.004)).toBe("0 %");
    expect(formatPercent(0.996)).toBe("100 %");
  });

  it("writes no negative zero with any number of decimals", () => {
    expect(formatNumber(-0.001, 2)).toBe("0,00");
    expect(formatNumber(-0.001, 3)).toBe("-0,001");
  });

  it("writes very long durations in hours", () => {
    expect(formatDuration(100 * 3600)).toBe("100 h 00 min");
    expect(formatDuration(36 * 3600 + 5 * 60)).toBe("36 h 05 min");
  });

  it("folds every accent and the tilde of the ñ", () => {
    expect(fold("Ñandú PINGÜINO miércoles")).toBe("nandu pinguino miercoles");
  });
});

describe("search by date, edge cases", () => {
  // Monday 12 May 2025, Monday 5 May 2025 and Sunday 1 March 2026, local time.
  const may12 = ride({ start: "2025-05-12T10:00:00-07:00", km: 10 });
  const may5 = ride({ start: "2025-05-05T10:00:00-07:00", km: 10 });
  const march = ride({ start: "2026-03-01T10:00:00-08:00", km: 10 });
  // 19:00 on 31 December 2025 in Los Angeles; already 2026 in UTC.
  const newYearsEve = ride({ start: "2026-01-01T03:00:00Z", km: 10 });
  const yes = (route: typeof may12, queries: string[]): void => {
    for (const query of queries) expect(matchesSearch(route, query), `"${query}" should match`).toBe(true);
  };
  const no = (route: typeof may12, queries: string[]): void => {
    for (const query of queries) expect(matchesSearch(route, query), `"${query}" should not match`).toBe(false);
  };

  it("reads a number alone as the whole day or the whole year, never as a part of either", () => {
    yes(may12, ["12 mayo", "12", "2025", "12 de mayo de 2025"]);
    // Three digits are neither a day nor a year.
    no(may12, ["012", "025"]);
    no(may12, ["5 mayo", "2 mayo", "20 mayo", "1 mayo", "1", "2", "20", "202", "25", "5", "2024", "20250"]);
    yes(may5, ["5 mayo", "05 mayo", "5", "05"]);
    no(may5, ["12 mayo", "50", "0"]);
    yes(march, ["1 marzo 2026", "2026", "1"]);
    no(march, ["6", "26", "202", "3"]);
  });

  it("matches the beginning of the weekday and of the month, never their middle", () => {
    yes(march, ["dom", "DOMINGO", "mar", "marzo", "m", "d"]);
    no(march, ["mingo", "arzo", "lunes", "abril", "domingos"]);
    // "mar" is both March and Tuesday (martes).
    yes(ride({ start: "2026-11-10T10:00:00-08:00", km: 1 }), ["mar", "martes", "nov"]);
    yes(ride({ start: "2026-09-02T10:00:00-07:00", km: 1 }), ["sep", "septiembre", "mie", "miércoles"]);
  });

  it("reads a date with slashes or dashes as numbers, with or without zeros and with or without the year", () => {
    yes(may5, ["5/5", "05/05", "05/5", "5/05", "5/5/2025", "05/05/2025", "5-5-2025", "5/5/25", "05-05-25", "2025-05-05", "2025-5-5", "2025-05", "2025-5"]);
    no(may5, ["5/6", "6/5", "5/5/2026", "5/5/24", "2025-06", "2026-05-05", "2025-05-06", "5/5/025"]);
    yes(march, ["1/3/2026", "01/03/2026", "1/3"]);
    // Day first: 3/1 is 3 January, not 1 March.
    no(march, ["3/1/2026", "1/3/2025", "1/4"]);
  });

  it("uses the local date on New Year's Eve", () => {
    yes(newYearsEve, ["31/12/2025", "miercoles diciembre 2025", "31", "2025-12-31"]);
    no(newYearsEve, ["2026", "enero", "1/1/2026", "jueves"]);
  });

  it("needs every word to match and splits the query at any white space and at commas", () => {
    yes(may12, ["lunes,\t12\nmayo", "lunes, 12 de mayo de 2025", "", "   ", ","]);
    no(may12, ["lunes 13 mayo", "martes 12 mayo", "12 mayo 2024"]);
  });
});

describe("CSV, edge cases", () => {
  it("guards and quotes every cell of every row", () => {
    expect(rowsToCsv([["Nombre", "Nota"], ["=1+1", "a;b"], ["-2", 'di "hola"']])).toBe(
      BOM + "Nombre;Nota\r\n'=1+1;\"a;b\"\r\n'-2;\"di \"\"hola\"\"\"\r\n",
    );
  });

  it("only guards the beginning of a cell, not what follows a line break", () => {
    expect(csvCell("a\n=1")).toBe('"a\n=1"');
  });

  it("rounds minutes to the nearest, like the list on screen", () => {
    const csv = routesToCsv(rides([{ start: "2026-03-07T10:00:00-08:00", km: 5, minutes: 1.6, speed: 30 }]));
    expect(csv.split("\r\n")[1]).toBe("2026-03-07;10:00;2;5,00;30,0");
  });
});
