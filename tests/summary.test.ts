// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Route } from "../src/domain/model";
import type { RiderData } from "../src/ui/data";
import { renderSummary } from "../src/ui/summary";
import { rides } from "./helpers";

/**
 * The Resumen tab drawn from seven rides whose figures are worked out by
 * hand below. The tests run in Los Angeles; "now" is Monday 9 November 2026
 * at noon there.
 */
const NOW = Date.parse("2026-11-09T12:00:00-08:00");
const LIST = rides([
  { start: "2025-11-10T08:00:00-08:00", km: 30, minutes: 60 }, // Monday
  { start: "2026-01-01T03:00:00Z", km: 12, minutes: 30 }, // Wednesday 31 December 2025, 19:00 local
  { start: "2026-03-07T23:30:00-08:00", km: 4, minutes: 10 }, // Saturday
  { start: "2026-03-08T12:00:00-07:00", km: 50, minutes: 90 }, // Sunday
  { start: "2026-03-08T18:00:00-07:00", km: 20.2, minutes: null }, // Sunday, duration unknown
  { start: "2026-11-08T09:00:00-08:00", km: 7, minutes: 20 }, // Sunday
  { start: "2026-11-09T07:15:00-08:00", km: 3, minutes: 15 }, // Monday, today
]);

function data(overrides: Partial<RiderData> = {}): RiderData {
  return {
    vehicle: { status: "AT_REST", batteryPercent: 77, lastCommunicationMs: Date.parse("2026-11-09T10:00:00-08:00"), odometer: 15500.4 },
    info: { model: "Demo 125", mileage: 15000 },
    routes: LIST,
    figures: LIST,
    hiddenShort: 0,
    shortCounted: false,
    skipped: 0,
    demo: true,
    nowMs: NOW,
    ...overrides,
  };
}

let view: HTMLElement;
function show(overrides: Partial<RiderData> = {}): void {
  view = renderSummary(data(overrides), "demo");
  document.body.replaceChildren(view);
}

/** The four figures: section 01, whose title follows the period («Tu año en cifras»). */
const FIGURES = "Cifras";
const figuresTitle = (): string => block(FIGURES).querySelector("h2")?.textContent ?? "";
const block = (title: string): HTMLElement => {
  const found =
    title === FIGURES
      ? (view.querySelector<HTMLElement>("section.readout-sec") ?? undefined)
      : [...view.querySelectorAll("section")].find((one) => one.querySelector("h2")?.textContent === title);
  if (found === undefined) throw new Error(`no block ${title}`);
  return found;
};
/** Label, value and note of every tile of a block. */
const tiles = (title: string): string[][] =>
  [...block(title).querySelectorAll(".tile")].map((tile) => [
    tile.querySelector("dt")?.textContent ?? "",
    tile.querySelector(".tile-value")?.textContent ?? "",
    tile.querySelector(".tile-note")?.textContent ?? "",
  ]);
const scope = (title: string): string => block(title).querySelector(".scope")?.textContent ?? "";
/** Rows of the data table of a chart, without the rows that are all zeros. */
const chartRows = (figure: Element): string[][] =>
  [...figure.querySelectorAll("tbody tr")]
    .map((row) => [...row.children].map((cell) => cell.textContent ?? ""))
    .filter((cells) => cells.slice(1).some((cell) => !/^0( km)?$/.test(cell)));
function choose(value: string): void {
  const select = view.querySelector<HTMLSelectElement>(".period select") as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
});

describe("Resumen, block by block", () => {
  it("shows the state of the bike", () => {
    show();
    expect(tiles("Estado")).toEqual([
      ["Batería", "77 %", ""],
      ["Último uso", "9 nov 2026", "a las 07:30"],
      ["Odómetro", "15.500 km", ""],
    ]);
    expect(scope("Estado")).toBe("Demo 125");
  });

  it("falls back to the vehicle mileage, to the last communication and to dashes", () => {
    show({ vehicle: { status: null, batteryPercent: null, lastCommunicationMs: Date.parse("2026-11-09T10:00:00-08:00"), odometer: null }, routes: [], figures: [] });
    expect(tiles("Estado")).toEqual([
      ["Batería", "—", ""],
      ["Último uso", "9 nov 2026", "a las 10:00"],
      ["Odómetro", "15.000 km", ""],
    ]);
    show({ vehicle: { status: null, batteryPercent: 5, lastCommunicationMs: null, odometer: null }, info: null, routes: [], figures: [] });
    expect(tiles("Estado")).toEqual([
      ["Batería", "5 %", ""],
      ["Último uso", "—", "Sin rutas ni comunicación registrada"],
      ["Odómetro", "—", ""],
    ]);
    expect(block("Estado").querySelector(".scope")).toBeNull();
  });

  it("shows the four figures of the current year", () => {
    show();
    expect(figuresTitle()).toBe("Tu año en cifras");
    expect(block(FIGURES).querySelector(".sec-tag")?.textContent).toBe("01 Resumen");
    expect(scope("Cifras")).toBe("Año 2026");
    expect(tiles("Cifras")).toEqual([
      ["Kilómetros", "84 km", ""],
      ["Salidas", "5", ""],
      ["Horas en marcha", "2 h", "1 salida sin duración conocida no suman"],
      ["noviembre frente a noviembre de 2025", "10 km", "30 km hace un año · −20 km. No depende del periodo elegido."],
    ]);
  });

  it("follows the period selector, except for the month comparison", () => {
    show();
    const options = [...view.querySelectorAll(".period option")].map((option) => option.textContent);
    expect(options).toEqual(["2026", "2025", "Todo"]);
    choose("2025");
    expect(figuresTitle()).toBe("Tu 2025 en cifras");
    expect(scope("Cifras")).toBe("Año 2025");
    expect(tiles("Cifras").map((tile) => tile.slice(0, 2))).toEqual([
      ["Kilómetros", "42 km"],
      ["Salidas", "2"],
      ["Horas en marcha", "2 h"],
      ["noviembre frente a noviembre de 2025", "10 km"],
    ]);
    expect(tiles("Cifras")[2]?.[2]).toBe("");
    choose("all");
    expect(figuresTitle()).toBe("Todo en cifras");
    expect(scope("Cifras")).toBe("Todo el historial");
    expect(tiles("Cifras").map((tile) => tile[1])).toEqual(["126 km", "7", "4 h", "10 km"]);
  });

  it("writes the month difference with its sign, or says it is the same", () => {
    const more = rides([
      { start: "2026-11-02T08:00:00-08:00", km: 40 },
      { start: "2025-11-02T08:00:00-08:00", km: 15 },
    ]);
    show({ routes: more, figures: more });
    expect(tiles("Cifras")[3]?.[2]).toBe("15 km hace un año · +25 km. No depende del periodo elegido.");
    const same = rides([
      { start: "2026-11-02T08:00:00-08:00", km: 15.2 },
      { start: "2025-11-02T08:00:00-08:00", km: 15 },
    ]);
    show({ routes: same, figures: same });
    expect(tiles("Cifras")[3]?.[2]).toBe("15 km hace un año · igual. No depende del periodo elegido.");
  });

  it("draws km per month for every year with rides, whatever the period", () => {
    show();
    const figure = block("Km por mes").querySelector("figure") as HTMLElement;
    expect([...figure.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(["Mes", "2025", "2026"]);
    expect(chartRows(figure)).toEqual([
      ["marzo", "0 km", "74 km"],
      ["noviembre", "30 km", "10 km"],
      ["diciembre", "12 km", "0 km"],
    ]);
    choose("2025");
    expect(chartRows(block("Km por mes").querySelector("figure") as HTMLElement).length).toBe(3);
  });

  it("counts rides per weekday and per hour of the chosen period", () => {
    show();
    const [weekdays, hours] = [...block("Hábitos").querySelectorAll("figure")] as [HTMLElement, HTMLElement];
    expect(scope("Hábitos")).toBe("Año 2026");
    expect(chartRows(weekdays)).toEqual([["lunes", "1"], ["sábado", "1"], ["domingo", "3"]]);
    expect(chartRows(hours)).toEqual([["7 h", "1"], ["9 h", "1"], ["12 h", "1"], ["18 h", "1"], ["23 h", "1"]]);
    expect([...block("Hábitos").querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
      "Salidas por día de la semana",
      "Salidas por hora de salida",
    ]);
    choose("2025");
    const [weekdays2025, hours2025] = [...block("Hábitos").querySelectorAll("figure")] as [HTMLElement, HTMLElement];
    expect(chartRows(weekdays2025)).toEqual([["lunes", "1"], ["miércoles", "1"]]);
    expect(chartRows(hours2025)).toEqual([["8 h", "1"], ["19 h", "1"]]);
  });

  it("names the three records of the chosen period with their dates", () => {
    show();
    const rows = (): string[][] => [...block("Récords").querySelectorAll("li")].map((row) => [...row.children].map((cell) => cell.textContent ?? ""));
    expect(rows()).toEqual([
      ["Ruta más larga", "50,0 km", "8 mar 2026"],
      ["Día con más km", "70,2 km", "8 mar 2026"],
      ["Mes con más km", "74 km", "marzo de 2026"],
    ]);
    choose("2025");
    expect(scope("Récords")).toBe("Año 2025");
    expect(rows()).toEqual([
      ["Ruta más larga", "30,0 km", "10 nov 2025"],
      ["Día con más km", "30,0 km", "10 nov 2025"],
      ["Mes con más km", "30 km", "noviembre de 2025"],
    ]);
  });

  it("shows the streaks of the whole history, whatever the period", () => {
    show();
    const expected = [
      ["Más días seguidos saliendo", "2 días", "del 7 mar 2026 al 8 mar 2026"],
      ["Más días seguidos parada, entre dos salidas", "244 días", "del 9 mar 2026 al 7 nov 2026"],
      ["Racha en curso saliendo", "2 días", "Sigue viva si saliste ayer: hoy aún no ha acabado"],
      ["Días parada ahora", "0 días", "Días completos sin salir; hoy no cuenta"],
    ];
    expect(tiles("Rachas")).toEqual(expected);
    expect(scope("Rachas")).toBe("Todo el historial");
    choose("2025");
    expect(tiles("Rachas")).toEqual(expected);
  });

  it("writes a streak of one day with its single date and in the singular", () => {
    const two = rides([
      { start: "2026-11-01T08:00:00-07:00", km: 9 },
      { start: "2026-11-03T08:00:00-08:00", km: 9 },
    ]);
    show({ routes: two, figures: two });
    expect(tiles("Rachas").map((tile) => tile.slice(1))).toEqual([
      ["1 día", "1 nov 2026"],
      ["1 día", "2 nov 2026"],
      ["0 días", "Sigue viva si saliste ayer: hoy aún no ha acabado"],
      ["5 días", "Días completos sin salir; hoy no cuenta"],
    ]);
  });

  it("measures the short trips of the chosen period", () => {
    show();
    const meters = (): string[][] =>
      [...block("Trayectos cortos").querySelectorAll(".meter")].map((meter) => [
        meter.querySelector("label")?.textContent ?? "",
        meter.querySelector("progress")?.getAttribute("value") ?? "",
        meter.querySelector(".meter-value")?.textContent ?? "",
      ]);
    expect(meters()).toEqual([
      ["Parte de las salidas", "40", "40 % · 2 de 5 salidas"],
      ["Parte de los km", "8", "8 % · 7 de 84 km"],
    ]);
    expect(block("Trayectos cortos").textContent).toContain("Salidas de menos de 5 km.");
    choose("2025");
    expect(meters()).toEqual([
      ["Parte de las salidas", "0", "0 % · 0 de 2 salidas"],
      ["Parte de los km", "0", "0 % · 0 de 42 km"],
    ]);
    for (const meter of block("Trayectos cortos").querySelectorAll(".meter")) {
      expect(meter.querySelector("label")?.getAttribute("for")).toBe(meter.querySelector("progress")?.id);
    }
  });

  it("writes the share card of the chosen period", () => {
    show();
    const card = (): string => block("Tarjeta para compartir").querySelector(".notice")?.textContent ?? "";
    expect(card()).toBe(
      "Tu 2026 en moto (datos de ejemplo). Kilómetros: 84 km; Salidas: 5; Horas en marcha: 2 h; Ruta más larga: 50,0 km; Mes con más km: marzo · 74 km.",
    );
    choose("2025");
    expect(card()).toContain("Tu 2025 en moto (datos de ejemplo). Kilómetros: 42 km; Salidas: 2;");
    choose("all");
    expect(card()).toContain("Tu historial en moto (datos de ejemplo). Kilómetros: 126 km; Salidas: 7;");
    show({ demo: false });
    expect(card()).toContain("Tu 2026 en moto. Kilómetros");
  });

  it("offers the current year even before its first ride", () => {
    show({ nowMs: Date.parse("2027-01-05T12:00:00-08:00") });
    expect([...view.querySelectorAll(".period option")].map((option) => option.textContent)).toEqual(["2027", "2026", "2025", "Todo"]);
    expect(tiles("Cifras").map((tile) => tile[1])).toEqual(["0 km", "0", "0 h", "0 km"]);
    expect(tiles("Cifras")[3]?.[0]).toBe("enero frente a enero de 2026");
  });

  it("uses the routes that count for the figures, not the listed ones", () => {
    const listed: Route[] = LIST.slice(0, 3);
    show({ routes: listed, figures: LIST });
    expect(tiles("Cifras")[1]?.[1]).toBe("5");
    show({ routes: LIST, figures: listed });
    choose("all");
    expect(tiles("Cifras")[1]?.[1]).toBe("3");
  });

  it("labels the period of each block and uses one heading level for all of them", () => {
    show();
    // Section 01 (the four figures and the period) comes first, with its own header.
    expect(view.querySelector("section h2")?.textContent).toBe("Tu año en cifras");
    expect(view.querySelector("section")?.contains(view.querySelector(".period"))).toBe(true);
    expect([...view.querySelectorAll("section > .block-head > h2")].map((heading) => heading.textContent)).toEqual([
      "Estado",
      "Km por mes",
      "Hábitos",
      "Récords",
      "Trayectos cortos",
      "Tarjeta para compartir",
      "Rachas",
      "Mantenimiento",
    ]);
    for (const section of view.querySelectorAll("section")) {
      expect(section.getAttribute("aria-labelledby")).toBe(section.querySelector("h2")?.id);
    }
    const period = view.querySelector(".period") as HTMLElement;
    expect(period.querySelector("label")?.getAttribute("for")).toBe(period.querySelector("select")?.id);
  });
});

describe("Resumen, notes and empty account", () => {
  const notes = (): string[] => [...view.querySelectorAll(".notes li")].map((item) => item.textContent ?? "");

  it("writes the notes in the singular and in the plural", () => {
    show({ hiddenShort: 1, skipped: 1 });
    expect(notes()[1]).toBe(
      "1 ruta de menos de 300 m no cuenta como salida ni aparece en la lista ni en el mapa. La app de MAPIT sí las cuenta, así que su número de salidas puede ser mayor.",
    );
    expect(notes()[2]).toBe("1 ruta se ha descartado porque el servicio la envió sin fecha o sin km.");
    show({ hiddenShort: 3, skipped: 2 });
    expect(notes()[1]).toContain("3 rutas de menos de 300 m no cuentan como salidas ni aparecen en la lista ni en el mapa.");
    expect(notes()[2]).toBe("2 rutas se han descartado porque el servicio las envió sin fecha o sin km.");
    show({ hiddenShort: 0, skipped: 0 });
    expect(notes()[1]).toBe("No hay rutas de menos de 300 m.");
    expect(notes()[2]).toBe("Ninguna ruta se ha descartado por venir sin fecha o sin km.");
  });

  it("says it when the short routes do count in the figures", () => {
    show({ hiddenShort: 3, shortCounted: true });
    expect(notes()[1]).toBe("3 rutas de menos de 300 m no se listan ni se dibujan, pero sí cuentan en las cifras.");
  });

  it("shows only the state, the maintenance and the notes for an account without rides", () => {
    show({ routes: [], figures: [] });
    expect([...view.querySelectorAll("section h2")].map((heading) => heading.textContent)).toEqual(["Estado", "Mantenimiento"]);
    expect(view.querySelector(".period")).toBeNull();
    expect(view.textContent).toContain("Todavía no hay rutas en esta cuenta.");
    expect(notes().length).toBe(5);
  });
});

describe("Resumen, maintenance", () => {
  const form = (): HTMLFormElement => view.querySelector("form.maintenance") as HTMLFormElement;
  const inputs = (): [HTMLInputElement, HTMLInputElement] => [...form().querySelectorAll("input")] as [HTMLInputElement, HTMLInputElement];
  const result = (): string => view.querySelector(".maintenance-result")?.textContent ?? "";
  function submit(interval: string, last: string): void {
    const [a, b] = inputs();
    a.value = interval;
    b.value = last;
    form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  it("says how much is left, that the service is due right now, and by how much it is overdue", () => {
    show({ vehicle: { status: null, batteryPercent: 1, lastCommunicationMs: null, odometer: 15500 } });
    submit("6000", "10000");
    expect(result()).toBe("Te faltan 500 km para la revisión (toca a los 16.000 km). Guardado en este navegador.");
    submit("5500", "10000");
    expect(result()).toBe("Te faltan 0 km para la revisión (toca a los 15.500 km). Guardado en este navegador.");
    submit("5000", "10000");
    expect(result()).toBe("Te has pasado 500 km de la revisión (tocaba a los 15.000 km). Guardado en este navegador.");
  });

  it("uses the vehicle mileage when the state has no odometer, and says so when there is none", () => {
    show({ vehicle: { status: null, batteryPercent: 1, lastCommunicationMs: null, odometer: null } });
    submit("6000", "10000");
    expect(result()).toContain("Te faltan 1.000 km para la revisión");
    show({ vehicle: { status: null, batteryPercent: 1, lastCommunicationMs: null, odometer: null }, info: null });
    submit("6000", "10000");
    expect(result()).toBe("El servicio no ha dado el odómetro, así que no se puede calcular. Guardado en este navegador.");
  });

  it("explains the limits when a number is out of range", () => {
    show();
    submit("150000", "100");
    expect(result()).toBe("Revisa los números: el intervalo debe estar entre 1 y 100.000 km, y el odómetro entre 0 y 10.000.000 km.");
  });

  it("clears both fields on request", () => {
    show();
    submit("6000", "10000");
    [...form().querySelectorAll("button")].find((button) => button.textContent === "Borrar")?.click();
    expect(inputs().map((input) => input.value)).toEqual(["", ""]);
    // And a new view finds nothing stored.
    show();
    expect(inputs().map((input) => input.value)).toEqual(["", ""]);
    expect(result()).toBe("Escribe los dos números para saber cuánto falta.");
  });

  it("labels its two fields", () => {
    show();
    const labels = [...form().querySelectorAll("label")];
    expect(labels.map((label) => label.textContent)).toEqual(["Revisión cada (km)", "Odómetro en la última revisión (km)"]);
    labels.forEach((label, index) => expect(label.getAttribute("for")).toBe(inputs()[index]?.id));
    // An odometer has decimals: the fields accept them.
    expect(inputs().map((input) => [input.type, input.getAttribute("step"), input.getAttribute("min")])).toEqual([
      ["number", "any", "1"],
      ["number", "any", "0"],
    ]);
    submit("6000", "10000.5");
    expect(result()).toContain("Guardado en este navegador.");
  });
});
