import { describe, expect, it } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { DEMO_BASE, FORBIDDEN_MARK, generateRider } from "../src/demo/generator";
import { CSV_HEADER, csvCell, routesToCsv } from "../src/domain/csv";
import { loadAllRoutes } from "../src/service/loader";
import { rides } from "./helpers";

/** Byte order mark, by its code: the file must start with it for a spreadsheet to read the accents. */
const BOM = String.fromCharCode(0xfeff);

describe("csvCell", () => {
  it("defuses cells a spreadsheet would run as a formula", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+34600")).toBe("'+34600");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe("\"'\rx\"");
  });

  it("quotes separators, quotes and line breaks", () => {
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("=a;b")).toBe("\"'=a;b\"");
  });

  it("leaves ordinary cells alone", () => {
    for (const text of ["", "12,5", "2026-03-07", "07:05", "Km", "a-b", "a=b", "x@y"]) {
      expect(csvCell(text)).toBe(text);
    }
  });
});

describe("routesToCsv", () => {
  it("writes the list columns in local time, for a Spanish spreadsheet", () => {
    const csv = routesToCsv(
      rides([
        // 23:30 on Saturday 7 March in Los Angeles; 8 March in UTC.
        { start: "2026-03-07T23:30:00-08:00", km: 8.257, minutes: 25, speed: 31 },
        { start: "2026-03-09T07:05:00-07:00", km: 120, minutes: null, speed: null },
        { start: "2026-03-10T10:00:00-07:00", km: 0.3, minutes: 1.4, speed: 12.345 },
      ]),
    );
    expect(csv).toBe(
      BOM + "Fecha;Hora de salida;Duración (min);Km;Velocidad media (km/h)\r\n" +
        "2026-03-07;23:30;25;8,26;31,0\r\n" +
        "2026-03-09;07:05;;120,00;\r\n" +
        "2026-03-10;10:00;1;0,30;12,3\r\n",
    );
  });

  it("writes only the header when there is nothing to export", () => {
    expect(routesToCsv([])).toBe(BOM + CSV_HEADER.join(";") + "\r\n");
  });

  it("carries no identifiers, coordinates or vehicle data", async () => {
    const rider = generateRider({ seed: 21, nowMs: Date.parse("2026-11-09T12:00:00.000Z") });
    const { routes } = await loadAllRoutes(createDemoService(rider), Date.parse("2026-11-09T12:00:00.000Z"));
    const csv = routesToCsv(routes);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines.length).toBe(routes.length + 1);
    expect(routes.length).toBeGreaterThan(500);
    expect(csv).not.toContain("rt-");
    expect(csv).not.toContain("DEMO");
    expect(csv).not.toContain(FORBIDDEN_MARK);
    expect(csv).not.toContain(String(DEMO_BASE[0]).slice(0, 5));
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2};\d{2}:\d{2};\d*;\d+,\d{2};(\d+,\d)?$/);
    }
  });
});
