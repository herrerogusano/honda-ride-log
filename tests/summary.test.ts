// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Route } from "../src/domain/model";
import type { RiderData } from "../src/ui/data";
import { renderRiderPage, type RiderPage } from "../src/ui/summary";
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
let page: RiderPage;
/** The whole rider's page but the map and the list, with its period selector (the top bar's, in the page). */
function show(overrides: Partial<RiderData> = {}): void {
  page = renderRiderPage(data(overrides), "demo");
  view = document.createElement("div");
  view.append(...[page.period, page.hero, ...page.sections.map((one) => one.element), page.footer].filter((part) => part !== null));
  document.body.replaceChildren(view);
}

/** The four figures: section 01, whose title follows the period («Tu año en cifras»). */
const FIGURES = "Cifras";
const figuresTitle = (): string => block(FIGURES).querySelector("h2")?.textContent ?? "";
const block = (title: string): HTMLElement => {
  const found =
    title === FIGURES
      ? (view.querySelector<HTMLElement>('section[data-section="resumen"]') ?? undefined)
      : [...view.querySelectorAll("section")].find((one) => one.querySelector(":scope > .block-head > h3")?.textContent === title);
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
    .filter((cells) => cells.slice(1).some((cell) => !/^0(\u00A0km)?$/.test(cell)));
/** Picks a period in the selector, as a click on its option does. */
function choose(value: string): void {
  const option = view.querySelector<HTMLInputElement>(`.period-control input[value="${value}"]`);
  if (option === null) throw new Error(`no period ${value}`);
  option.click();
}
/** Labels of the period options, in order. */
const periodOptions = (): string[] => [...view.querySelectorAll(".period-control label")].map((label) => label.textContent ?? "");

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
      ["Batería", "77\u00A0%", ""],
      ["Último uso", "9 nov 2026", "a las 07:30"],
      ["Odómetro", "15.500\u00A0km", ""],
    ]);
    expect(scope("Estado")).toBe("Demo 125");
  });

  it("falls back to the vehicle mileage, to the last communication and to dashes", () => {
    show({ vehicle: { status: null, batteryPercent: null, lastCommunicationMs: Date.parse("2026-11-09T10:00:00-08:00"), odometer: null }, routes: [], figures: [] });
    expect(tiles("Estado")).toEqual([
      ["Batería", "—", ""],
      ["Último uso", "9 nov 2026", "a las 10:00"],
      ["Odómetro", "15.000\u00A0km", ""],
    ]);
    show({ vehicle: { status: null, batteryPercent: 5, lastCommunicationMs: null, odometer: null }, info: null, routes: [], figures: [] });
    expect(tiles("Estado")).toEqual([
      ["Batería", "5\u00A0%", ""],
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
      ["Kilómetros", "84\u00A0km", ""],
      ["Salidas", "5", ""],
      ["Horas en marcha", "2\u00A0h", "1 salida sin duración conocida no suman"],
      ["noviembre frente a noviembre de 2025", "10\u00A0km", "30\u00A0km hace un año · −20\u00A0km. No depende del periodo elegido."],
    ]);
  });

  it("follows the period selector, except for the month comparison", () => {
    show();
    const options = periodOptions();
    expect(options).toEqual(["2026", "2025", "Todo"]);
    choose("2025");
    expect(figuresTitle()).toBe("Tu 2025 en cifras");
    expect(scope("Cifras")).toBe("Año 2025");
    expect(tiles("Cifras").map((tile) => tile.slice(0, 2))).toEqual([
      ["Kilómetros", "42\u00A0km"],
      ["Salidas", "2"],
      ["Horas en marcha", "2\u00A0h"],
      ["noviembre frente a noviembre de 2025", "10\u00A0km"],
    ]);
    expect(tiles("Cifras")[2]?.[2]).toBe("");
    choose("all");
    expect(figuresTitle()).toBe("Todo en cifras");
    expect(scope("Cifras")).toBe("Todo el historial");
    expect(tiles("Cifras").map((tile) => tile[1])).toEqual(["126\u00A0km", "7", "4\u00A0h", "10\u00A0km"]);
  });

  it("writes the month difference with its sign, or says it is the same", () => {
    const more = rides([
      { start: "2026-11-02T08:00:00-08:00", km: 40 },
      { start: "2025-11-02T08:00:00-08:00", km: 15 },
    ]);
    show({ routes: more, figures: more });
    expect(tiles("Cifras")[3]?.[2]).toBe("15\u00A0km hace un año · +25\u00A0km. No depende del periodo elegido.");
    const same = rides([
      { start: "2026-11-02T08:00:00-08:00", km: 15.2 },
      { start: "2025-11-02T08:00:00-08:00", km: 15 },
    ]);
    show({ routes: same, figures: same });
    expect(tiles("Cifras")[3]?.[2]).toBe("15\u00A0km hace un año · igual. No depende del periodo elegido.");
  });

  it("draws km per month for every year with rides, whatever the period", () => {
    show();
    const figure = block("Km por mes").querySelector("figure") as HTMLElement;
    expect([...figure.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(["Mes", "2025", "2026"]);
    expect(chartRows(figure)).toEqual([
      ["marzo", "0\u00A0km", "74\u00A0km"],
      ["noviembre", "30\u00A0km", "10\u00A0km"],
      ["diciembre", "12\u00A0km", "0\u00A0km"],
    ]);
    // This year in red, last year in light grey (the legend keeps the names, so colour is not the only cue).
    expect([...figure.querySelectorAll(".chart-legend li")].map((item) => [item.textContent, item.querySelector(".chart-key")?.classList.contains("tone-now")])).toEqual([
      ["2025", false],
      ["2026", true],
    ]);
    expect(figure.querySelector(".chart-key.tone-prev")?.parentElement?.textContent).toBe("2025");
    choose("2025");
    expect(chartRows(block("Km por mes").querySelector("figure") as HTMLElement).length).toBe(3);
  });

  it("gives older years the dark grey", () => {
    show({ nowMs: Date.parse("2027-06-01T12:00:00-07:00") });
    const keys = [...block("Km por mes").querySelectorAll(".chart-legend .chart-key")].map((key) => [...key.classList].find((name) => name.startsWith("tone-")));
    expect(keys).toEqual(["tone-old", "tone-prev"]);
  });

  it("counts rides per weekday and per hour of the chosen period", () => {
    show();
    const [weekdays, hours] = [...block("Días y horas").querySelectorAll("figure")] as [HTMLElement, HTMLElement];
    expect(scope("Días y horas")).toBe("Año 2026");
    expect(chartRows(weekdays)).toEqual([["lunes", "1"], ["sábado", "1"], ["domingo", "3"]]);
    expect(chartRows(hours)).toEqual([["7\u00A0h", "1"], ["9\u00A0h", "1"], ["12\u00A0h", "1"], ["18\u00A0h", "1"], ["23\u00A0h", "1"]]);
    expect([...block("Días y horas").querySelectorAll("h4")].map((heading) => heading.textContent)).toEqual([
      "Salidas por día de la semana",
      "Salidas por hora de salida",
    ]);
    choose("2025");
    const [weekdays2025, hours2025] = [...block("Días y horas").querySelectorAll("figure")] as [HTMLElement, HTMLElement];
    expect(chartRows(weekdays2025)).toEqual([["lunes", "1"], ["miércoles", "1"]]);
    expect(chartRows(hours2025)).toEqual([["8\u00A0h", "1"], ["19\u00A0h", "1"]]);
  });

  it("names the three records of the chosen period with their dates", () => {
    show();
    const rows = (): string[][] => [...block("Récords").querySelectorAll("li")].map((row) => [...row.children].map((cell) => cell.textContent ?? ""));
    expect(rows()).toEqual([
      ["Ruta más larga", "50,0\u00A0km", "8 mar 2026"],
      ["Día con más km", "70,2\u00A0km", "8 mar 2026"],
      ["Mes con más km", "74\u00A0km", "marzo de 2026"],
    ]);
    choose("2025");
    expect(scope("Récords")).toBe("Año 2025");
    expect(rows()).toEqual([
      ["Ruta más larga", "30,0\u00A0km", "10 nov 2025"],
      ["Día con más km", "30,0\u00A0km", "10 nov 2025"],
      ["Mes con más km", "30\u00A0km", "noviembre de 2025"],
    ]);
  });

  it("shows the streaks of the whole history, whatever the period", () => {
    show();
    const expected = [
      ["Más días seguidos saliendo", "2\u00A0días", "del 7 mar 2026 al 8 mar 2026"],
      ["Más días seguidos parada, entre dos salidas", "244\u00A0días", "del 9 mar 2026 al 7 nov 2026"],
      ["Racha en curso saliendo", "2\u00A0días", "Sigue viva si saliste ayer: hoy aún no ha acabado"],
      ["Días parada ahora", "0\u00A0días", "Días completos sin salir; hoy no cuenta"],
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
      ["1\u00A0día", "1 nov 2026"],
      ["1\u00A0día", "2 nov 2026"],
      ["0\u00A0días", "Sigue viva si saliste ayer: hoy aún no ha acabado"],
      ["5\u00A0días", "Días completos sin salir; hoy no cuenta"],
    ]);
  });

  it("gives «En números» of the chosen period: the average ride and the short-trip shares, units in red", () => {
    show();
    const rows = (): string[][] =>
      [...block("En números").querySelectorAll(".num-row")].map((row) => [
        row.querySelector(".num-fig")?.textContent ?? "",
        row.querySelector(".num-fig .unit")?.textContent ?? "",
        row.querySelector(".num-label")?.textContent ?? "",
        row.querySelector(".num-detail")?.textContent ?? "",
        (row.querySelector(".num-fill") as HTMLElement | null)?.style.getPropertyValue("--v") ?? "",
      ]);
    // 84,2 km in 5 rides: 16,8 km each. Short (under 5 km): 2 rides (4 and 3 km), 7 km.
    const nb = String.fromCharCode(0xa0);
    expect(rows()).toEqual([
      [`16,8${nb}km`, "km", "Salida media", `84${nb}km entre 5 salidas: sale de las mismas cifras de arriba.`, ""],
      [`40${nb}%`, "%", `Salidas de menos de 5${nb}km`, "2 de 5 salidas", "0.4000"],
      [`8${nb}%`, "%", `De los km, en salidas de menos de 5${nb}km`, `7 de 84${nb}km`, (7 / 84.2).toFixed(4)],
    ]);
    choose("2025");
    expect(rows().map((row) => row[0])).toEqual([`21,0${nb}km`, `0${nb}%`, `0${nb}%`]);
    expect(rows()[1]?.[3]).toBe("0 de 2 salidas");
  });

  it("writes the share card of the chosen period", () => {
    show();
    const card = (): string => block("Tarjeta para compartir").querySelector(".notice")?.textContent ?? "";
    expect(card()).toBe(
      "Tu 2026 en moto (datos de ejemplo). Kilómetros: 84\u00A0km; Salidas: 5; Horas en marcha: 2\u00A0h; Ruta más larga: 50,0\u00A0km; Mes con más km: marzo · 74\u00A0km.",
    );
    choose("2025");
    expect(card()).toContain("Tu 2025 en moto (datos de ejemplo). Kilómetros: 42\u00A0km; Salidas: 2;");
    choose("all");
    expect(card()).toContain("Tu historial en moto (datos de ejemplo). Kilómetros: 126\u00A0km; Salidas: 7;");
    show({ demo: false });
    expect(card()).toContain("Tu 2026 en moto. Kilómetros");
  });

  it("offers the current year even before its first ride", () => {
    show({ nowMs: Date.parse("2027-01-05T12:00:00-08:00") });
    expect(periodOptions()).toEqual(["2027", "2026", "2025", "Todo"]);
    expect(tiles("Cifras").map((tile) => tile[1])).toEqual(["0\u00A0km", "0", "0\u00A0h", "0\u00A0km"]);
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

  it("numbers the sections, puts the blocks under them one heading level down and labels the period", () => {
    show();
    // The numbered sections, in order, each with its tag and its two-line title.
    expect(page.sections.map((one) => [one.id, one.element.querySelector(".sec-tag")?.textContent, one.header.heading.textContent])).toEqual([
      ["resumen", "01 Resumen", "Tu año en cifras"],
      ["ritmo", "02 Ritmo", "El pulso de los meses"],
      ["habitos", "03 Hábitos", "Cada salida cuenta"],
      ["taller", "04 Taller", "A punto"],
    ]);
    expect([...view.querySelectorAll("section.page-sec > .sec-head > h2")]).toHaveLength(4);
    // Every block is an h3 under its section's h2, in this order; the state is the hero's plate.
    expect([...view.querySelectorAll("section > .block-head > h3")].map((heading) => heading.textContent)).toEqual([
      "Estado",
      "Km por mes",
      "Récords",
      "Mes frente a mes",
      "Rachas",
      "Calendario de actividad",
      "Días y horas",
      "En números",
      "Mantenimiento",
      "Tarjeta para compartir",
    ]);
    expect(page.hero.contains(block("Estado"))).toBe(true);
    for (const section of view.querySelectorAll("section")) {
      expect(section.getAttribute("aria-labelledby")).toBe(section.querySelector("h2, h3")?.id);
    }
    // One period selector, a group of radio buttons with a name for screen readers.
    expect(view.querySelectorAll(".period-control")).toHaveLength(1);
    const period = view.querySelector(".period-control") as HTMLElement;
    expect(period.tagName).toBe("FIELDSET");
    expect(period.querySelector("legend")?.textContent).toBe("Periodo");
    const radios = [...period.querySelectorAll("input")];
    expect(radios.every((radio) => radio.type === "radio" && radio.name === radios[0]?.name && radio.closest("label") !== null)).toBe(true);
    expect(radios.filter((radio) => radio.checked).map((radio) => radio.value)).toEqual(["2026"]);
    // Section 01 says which period it shows, next to the readout.
    expect(block(FIGURES).querySelector(".sec-top .scope")?.textContent).toBe("Año 2026");
  });

  it("changes only the blocks that follow the period and leaves the others as they are", () => {
    show();
    const fixed = ["Km por mes", "Mes frente a mes", "Rachas", "Mantenimiento", "Estado"].map((title) => block(title));
    const following = ["Récords", "Calendario de actividad", "Días y horas", "En números", "Tarjeta para compartir"].map((title) => block(title));
    const readout = block(FIGURES).querySelector(".readout");
    const figures = [...(readout?.children ?? [])];
    choose("2025");
    // The same nodes for the blocks that do not follow the period: nothing of them is redrawn.
    expect(["Km por mes", "Mes frente a mes", "Rachas", "Mantenimiento", "Estado"].map((title) => block(title))).toEqual(fixed);
    // New nodes for those that do, in the same places, and new figures in the same readout.
    const redrawn = ["Récords", "Calendario de actividad", "Días y horas", "En números", "Tarjeta para compartir"].map((title) => block(title));
    redrawn.forEach((one, index) => {
      expect(one).not.toBe(following[index]);
      expect(following[index]?.isConnected).toBe(false);
      expect(one.parentElement?.classList.contains("slot")).toBe(true);
    });
    expect(block(FIGURES).querySelector(".readout")).toBe(readout);
    expect([...(readout?.children ?? [])].some((figure) => figures.includes(figure))).toBe(false);
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
    expect([...view.querySelectorAll("section > .block-head > h3")].map((heading) => heading.textContent)).toEqual(["Estado", "Mantenimiento"]);
    // Sections without content are not there; those that are keep consecutive numbers.
    expect(page.sections.map((one) => one.element.querySelector(".sec-tag")?.textContent)).toEqual(["01 Resumen", "02 Taller"]);
    expect(page.period).toBeNull();
    expect(view.querySelector(".period-control")).toBeNull();
    expect(block(FIGURES).textContent).toContain("Todavía no hay rutas en esta cuenta.");
    expect(page.hero.textContent).toContain("Todavía no hay salidas en esta cuenta.");
    expect(notes().length).toBe(5);
  });

  it("says what the web does with the data in the footer, apart from the notes", () => {
    show();
    const privacy = [...view.querySelectorAll(".foot-privacy li")].map((item) => item.textContent);
    expect(privacy).toEqual([
      "Los datos se leen y se calculan en tu navegador; esta web no tiene servidor propio ni analítica.",
      "Nunca se muestran la matrícula, el bastidor, el concesionario ni la posición actual de la moto.",
      "Los mapas ocultan los primeros y los últimos 400 m de cada ruta.",
      "Al salir, la web olvida tus datos. En este navegador solo quedan los dos números del mantenimiento, si los guardas.",
    ]);
    expect(page.footer.tagName).toBe("FOOTER");
  });
});

describe("hero", () => {
  it("names the bike, says how many rides and between which dates, and holds the state on its plate", () => {
    show();
    expect(page.hero.querySelector(".hero-eyebrow")?.textContent).toBe("Demo 125 · Ride Log");
    const title = page.hero.querySelector("h2") as HTMLElement;
    expect(title.textContent).toBe("Una moto. Cada trazo.");
    expect([...title.querySelectorAll(".ln-in")].map((line) => [line.textContent, line.classList.contains("red")])).toEqual([
      ["Una moto.", false],
      ["Cada", false],
      ["trazo.", true],
    ]);
    expect(page.hero.getAttribute("aria-labelledby")).toBe(title.id);
    // The whole history, whatever the period: 7 rides from 10 November 2025 to 9 November 2026.
    expect(page.hero.querySelector(".hero-lead")?.textContent).toBe("7 salidas entre el 10 nov 2025 y el 9 nov 2026.");
    choose("2025");
    expect(page.hero.querySelector(".hero-lead")?.textContent).toBe("7 salidas entre el 10 nov 2025 y el 9 nov 2026.");
    expect(page.hero.querySelector(".plate")).toBe(block("Estado"));
    const one = rides([{ start: "2026-03-07T10:00:00-08:00", km: 9 }]);
    show({ routes: one, figures: one, info: null });
    expect(page.hero.querySelector(".hero-lead")?.textContent).toBe("1 salida, el 7 mar 2026.");
    expect(page.hero.querySelector(".hero-eyebrow")?.textContent).toBe("Tu moto · Ride Log");
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
    expect(result()).toBe("Te faltan 500\u00A0km para la revisión (toca a los 16.000\u00A0km). Guardado en este navegador.");
    submit("5500", "10000");
    expect(result()).toBe("Te faltan 0\u00A0km para la revisión (toca a los 15.500\u00A0km). Guardado en este navegador.");
    submit("5000", "10000");
    expect(result()).toBe("Te has pasado 500\u00A0km de la revisión (tocaba a los 15.000\u00A0km). Guardado en este navegador.");
  });

  it("uses the vehicle mileage when the state has no odometer, and says so when there is none", () => {
    show({ vehicle: { status: null, batteryPercent: 1, lastCommunicationMs: null, odometer: null } });
    submit("6000", "10000");
    expect(result()).toContain("Te faltan 1.000\u00A0km para la revisión");
    show({ vehicle: { status: null, batteryPercent: 1, lastCommunicationMs: null, odometer: null }, info: null });
    submit("6000", "10000");
    expect(result()).toBe("El servicio no ha dado el odómetro, así que no se puede calcular. Guardado en este navegador.");
  });

  it("explains the limits when a number is out of range", () => {
    show();
    submit("150000", "100");
    expect(result()).toBe("Revisa los números: el intervalo debe estar entre 1 y 100.000\u00A0km, y el odómetro entre 0 y 10.000.000\u00A0km.");
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
