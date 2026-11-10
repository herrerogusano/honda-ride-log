import { describe, expect, it } from "vitest";
import { csvCell, routesToCsv, rowsToCsv } from "../src/domain/csv";
import { fold, formatDuration, formatNumber, formatPercent, matchesSearch, searchWords } from "../src/domain/format";
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
  // Monday 12 May 2025 and Sunday 1 March 2026, local time.
  const may = ride({ start: "2025-05-12T10:00:00-07:00", km: 10 });
  const march = ride({ start: "2026-03-01T10:00:00-08:00", km: 10 });
  // 19:00 on 31 December 2025 in Los Angeles; already 2026 in UTC.
  const newYearsEve = ride({ start: "2026-01-01T03:00:00Z", km: 10 });

  it("matches a day number as a day, not as part of the year", () => {
    expect(matchesSearch(may, "5 mayo")).toBe(false);
    expect(matchesSearch(may, "12 mayo")).toBe(true);
    expect(matchesSearch(may, "1 mayo")).toBe(true); // the beginning of "12", as when typing
    expect(matchesSearch(march, "6")).toBe(false);
    expect(matchesSearch(march, "26")).toBe(false);
    expect(matchesSearch(march, "2026")).toBe(true);
    expect(matchesSearch(march, "202")).toBe(true);
  });

  it("matches the beginning of a word, never its middle", () => {
    expect(matchesSearch(march, "dom")).toBe(true);
    expect(matchesSearch(march, "mingo")).toBe(false);
    expect(matchesSearch(march, "arzo")).toBe(false);
  });

  it("accepts the date with and without leading zeros", () => {
    for (const query of ["1/3/2026", "01/03/2026", "1/3", "2026-03-01", "2026-03"]) expect(matchesSearch(march, query), query).toBe(true);
    for (const query of ["3/1/2026", "1/3/2025", "1/4"]) expect(matchesSearch(march, query), query).toBe(false);
  });

  it("uses the local date on New Year's Eve", () => {
    expect(matchesSearch(newYearsEve, "31/12/2025")).toBe(true);
    expect(matchesSearch(newYearsEve, "miercoles diciembre 2025")).toBe(true);
    expect(matchesSearch(newYearsEve, "2026")).toBe(false);
    expect(matchesSearch(newYearsEve, "enero")).toBe(false);
  });

  it("splits the query at any white space and at commas", () => {
    expect(matchesSearch(may, "lunes,\t12\nmayo")).toBe(true);
    expect(matchesSearch(may, "lunes, 12 de mayo de 2025")).toBe(true);
    expect(searchWords(may)).toEqual(["lunes", "12", "de", "mayo", "de", "2025", "may", "12/05/2025", "12/5/2025", "2025-05-12"]);
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
