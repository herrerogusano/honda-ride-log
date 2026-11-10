/**
 * The rider's page, everything but the map and the list (docs/PLAN.md,
 * sections 3 and 12): the hero with the vehicle state, the numbered
 * sections with their blocks and the footer with the notes. Every figure is
 * computed here, in the browser.
 *
 * One period selector (built here, shown in the top bar) drives the blocks
 * that follow the period: the four figures, the records, the habits, the
 * short trips and the card. The others (state, km per month, the month
 * comparison, streaks, maintenance) never change with it, and each block
 * says which period it shows.
 */
import { SUMMARY_DEFAULT_PERIOD } from "../config";
import {
  formatDate,
  formatKm,
  formatMonth,
  formatNumber,
  formatPercent,
  formatTime,
  formatWholeKm,
  MONTHS_LONG,
  MONTHS_SHORT,
  NBSP,
  WEEKDAYS_LONG,
  WEEKDAYS_SHORT,
  withUnit,
} from "../domain/format";
import { maintenanceStatus, validPlan, type MaintenancePlan } from "../domain/maintenance";
import { TRIM_METERS } from "../domain/privacy";
import {
  inPeriod,
  kmByMonth,
  lastUseMs,
  monthVsLastYear,
  records,
  ridesByHour,
  ridesByWeekday,
  shortTrips,
  SHORT_TRIP_KM,
  streaks,
  totals,
  yearsWithRoutes,
  type Period,
  type Streak,
} from "../domain/stats";
import { clearMaintenance, readMaintenance, writeMaintenance, type StorageScope } from "../storage/maintenance";
import { cardContent, cardText, drawCard } from "./card";
import { barChart } from "./charts";
import type { RiderData } from "./data";
import { clear, el, uniqueId } from "./dom";
import { downloadBlob } from "./download";
import { countUp, durationToken, MAX_STAGGER, reveal, watchOnScreen } from "./motion";
import { periodControl } from "./period";
import { sectionHeader, type SectionHeader } from "./sectionHeader";

const days = (count: number): string => (count === 1 ? withUnit("1", "día") : withUnit(formatNumber(count), "días"));
const plural = (count: number, one: string, many: string): string => `${formatNumber(count)} ${count === 1 ? one : many}`;

/** What the page promises about the rider's data: on the landing and in the footer. */
export const PROMISES: readonly string[] = [
  "Los datos se leen y se calculan en tu navegador; esta web no tiene servidor propio ni analítica.",
  "Nunca se muestran la matrícula, el bastidor, el concesionario ni la posición actual de la moto.",
  `Los mapas ocultan los primeros y los últimos ${TRIM_METERS} m de cada ruta.`,
];

/** A block inside a numbered section: a small heading, the period it shows and its content. */
function block(title: string, scope: string | null, ...children: (Node | null)[]): HTMLElement {
  const id = uniqueId("block");
  return el(
    "section",
    { class: "block rv", attrs: { "aria-labelledby": id } },
    el("div", { class: "block-head" }, el("h3", { id }, title), scope === null ? null : el("span", { class: "scope" }, scope)),
    ...children,
  );
}

function tile(label: string, value: string, note?: string | null): HTMLElement {
  return el(
    "div",
    { class: "tile" },
    el("dt", {}, label),
    el("dd", {}, el("span", { class: "tile-value" }, value), note ? el("span", { class: "tile-note" }, note) : null),
  );
}

/**
 * The vehicle state, as the slanted plate of the hero. The plate is the
 * place where the 3D atlas will go (a later phase): it has a head, a body
 * and a foot, and the state can share it.
 */
function statusPlate(data: RiderData): HTMLElement {
  const { vehicle, info } = data;
  const lastUse = lastUseMs(data.figures, vehicle);
  const odometer = vehicle.odometer ?? info?.mileage ?? null;
  const id = uniqueId("block");
  return el(
    "section",
    { class: "block plate", attrs: { "aria-labelledby": id } },
    el("div", { class: "block-head plate-head" }, el("h3", { id }, "Estado"), info?.model ? el("span", { class: "scope" }, info.model) : null),
    el(
      "dl",
      { class: "tiles plate-tiles" },
      tile("Batería", vehicle.batteryPercent === null ? "—" : withUnit(formatNumber(vehicle.batteryPercent), "%")),
      tile(
        "Último uso",
        lastUse === null ? "—" : formatDate(lastUse),
        lastUse === null ? "Sin rutas ni comunicación registrada" : `a las ${formatTime(lastUse)}`,
      ),
      tile("Odómetro", odometer === null ? "—" : formatWholeKm(odometer)),
    ),
    el("p", { class: "plate-note" }, "Sin posición: esta web nunca enseña dónde está la moto."),
  );
}

function signedKm(km: number): string {
  const rounded = Math.round(km);
  if (rounded === 0) return "igual";
  return `${rounded > 0 ? "+" : "−"}${formatWholeKm(Math.abs(rounded))}`;
}

/** The title of section 01 for a period: two lines, uppercase on screen. */
export function figuresTitle(period: Period, currentYear: number): string[] {
  if (period === "all") return ["Todo", "en cifras"];
  return [period === currentYear ? "Tu año" : `Tu ${period}`, "en cifras"];
}

/**
 * One figure of the readout strip: a huge number that counts up, a small
 * red unit and a caption. `note` says something about this very figure
 * (`.tile-note`); without one, `caption` says what the figure measures.
 */
function figure(
  label: string,
  value: number,
  unit: string | null,
  note: string | null,
  caption: string,
  count: (element: HTMLElement, value: number) => void,
): HTMLElement {
  const number = el("span", { class: "mv-num" });
  count(number, value);
  return el(
    "div",
    { class: "tile m" },
    el("dt", {}, label),
    el(
      "dd",
      {},
      // The no-break space keeps "84 km" as the text of the value, on one line.
      el("span", { class: "tile-value mv" }, number, unit === null ? null : NBSP, unit === null ? null : el("small", { class: "mv-unit" }, unit)),
      note === null ? el("span", { class: "mc" }, caption) : el("span", { class: "tile-note mc" }, note),
    ),
  );
}

/** The four figures of the period (docs/PLAN.md, "Resumen", item 2). */
function figures(data: RiderData, period: Period, count: (element: HTMLElement, value: number) => void): HTMLElement[] {
  const sum = totals(inPeriod(data.figures, period));
  const month = monthVsLastYear(data.figures, data.nowMs);
  return [
    figure("Kilómetros", sum.km, "km", null, "Según el servicio; unidad sin confirmar", count),
    figure("Salidas", sum.rides, null, null, "Rutas que cuentan en las cifras", count),
    figure(
      "Horas en marcha",
      sum.hours,
      "h",
      sum.ridesWithoutDuration > 0 ? `${plural(sum.ridesWithoutDuration, "salida", "salidas")} sin duración conocida no suman` : null,
      "Suma de las duraciones conocidas",
      count,
    ),
    figure(
      `${MONTHS_LONG[month.month]} frente a ${MONTHS_LONG[month.month]} de ${month.year - 1}`,
      month.km,
      "km",
      `${formatWholeKm(month.previousKm)} hace un año · ${signedKm(month.differenceKm)}. No depende del periodo elegido.`,
      "",
      count,
    ),
  ];
}

/** This year in red, last year in light grey, older years in dark grey. */
function yearTone(year: number, currentYear: number): string {
  if (year === currentYear) return "tone-now";
  return year === currentYear - 1 ? "tone-prev" : "tone-old";
}

/** Month initials for the phone drawing of the 12-month chart. */
const MONTH_INITIALS = ["E", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"] as const;

function monthsBlock(data: RiderData): HTMLElement {
  const currentYear = new Date(data.nowMs).getFullYear();
  const series = kmByMonth(data.figures);
  return block(
    "Km por mes",
    "Últimos años con rutas",
    barChart({
      title: "Kilómetros por mes, comparando años",
      categories: MONTHS_SHORT,
      categoryNames: MONTHS_LONG,
      categoryHeader: "Mes",
      series: series.map((one) => ({ label: String(one.year), values: one.km, tone: yearTone(one.year, currentYear) })),
      formatValue: formatWholeKm,
      narrow: { categories: MONTH_INITIALS, formatTick: (value) => formatNumber(value) },
    }),
  );
}

/** The fourth figure, drawn: this month against the same month a year ago, as two bars. */
function monthDetailBlock(data: RiderData): HTMLElement {
  const month = monthVsLastYear(data.figures, data.nowMs);
  const peak = Math.max(month.km, month.previousKm);
  const bar = (label: string, km: number, now: boolean): HTMLElement => {
    const fill = el("span", { class: now ? "mbar-fill now" : "mbar-fill" });
    fill.style.setProperty("--v", peak > 0 ? (km / peak).toFixed(4) : "0");
    return el(
      "li",
      { class: "mbar" },
      el("span", { class: "mbar-label" }, label),
      el("span", { class: "mbar-track", attrs: { "aria-hidden": "true" } }, fill),
      el("strong", { class: "mbar-value" }, formatWholeKm(km)),
    );
  };
  const name = MONTHS_LONG[month.month] as string;
  return block(
    "Mes frente a mes",
    "No depende del periodo",
    el(
      "ul",
      { class: "mbars" },
      bar(`${name} de ${month.year - 1}`, month.previousKm, false),
      bar(`${name} de ${month.year}`, month.km, true),
    ),
    el(
      "p",
      { class: "mbar-diff" },
      el("strong", {}, signedKm(month.differenceKm)),
      ` en ${name} frente al mismo mes del año pasado. El mes en curso aún no ha terminado.`,
    ),
  );
}

function habitsBlock(data: RiderData, period: Period, periodLabel: string): HTMLElement {
  const routes = inPeriod(data.figures, period);
  const count = (value: number): string => formatNumber(value);
  return block(
    "Días y horas",
    periodLabel,
    el(
      "div",
      { class: "pair" },
      el(
        "div",
        {},
        el("h4", {}, "Salidas por día de la semana"),
        barChart({
          title: "Salidas por día de la semana",
          categories: WEEKDAYS_SHORT,
          categoryNames: WEEKDAYS_LONG,
          categoryHeader: "Día",
          series: [{ label: "Salidas", values: ridesByWeekday(routes) }],
          formatValue: count,
          compact: true,
        }),
      ),
      el(
        "div",
        {},
        el("h4", {}, "Salidas por hora de salida"),
        barChart({
          title: "Salidas por hora de salida",
          categories: Array.from({ length: 24 }, (_, hour) => String(hour)),
          categoryNames: Array.from({ length: 24 }, (_, hour) => withUnit(String(hour), "h")),
          categoryHeader: "Hora",
          series: [{ label: "Salidas", values: ridesByHour(routes) }],
          formatValue: count,
          labelEvery: 3,
          compact: true,
        }),
      ),
    ),
  );
}

function recordsBlock(data: RiderData, period: Period, periodLabel: string): HTMLElement {
  const best = records(inPeriod(data.figures, period));
  const row = (label: string, value: string, when: string): HTMLElement =>
    el("li", { class: "record" }, el("span", { class: "record-label" }, label), el("strong", {}, value), el("span", { class: "record-when" }, when));
  return block(
    "Récords",
    periodLabel,
    el(
      "ul",
      { class: "records" },
      row(
        "Ruta más larga",
        best.longestRide === null ? "—" : formatKm(best.longestRide.km),
        best.longestRide === null ? "" : formatDate(best.longestRide.startMs),
      ),
      row(
        "Día con más km",
        best.bestDay === null ? "—" : formatKm(best.bestDay.km),
        best.bestDay === null ? "" : formatDate(best.bestDay.dayMs),
      ),
      row(
        "Mes con más km",
        best.bestMonth === null ? "—" : formatWholeKm(best.bestMonth.km),
        best.bestMonth === null ? "" : formatMonth(best.bestMonth.year, best.bestMonth.month),
      ),
    ),
  );
}

function streakRange(streak: Streak | null): string {
  if (streak === null) return "";
  return streak.days === 1 ? formatDate(streak.fromMs) : `del ${formatDate(streak.fromMs)} al ${formatDate(streak.toMs)}`;
}

function streaksBlock(data: RiderData): HTMLElement {
  const result = streaks(data.figures, data.nowMs);
  return block(
    "Rachas",
    "Todo el historial",
    el(
      "dl",
      { class: "tiles tiles-4" },
      tile("Más días seguidos saliendo", result.longestRiding === null ? "—" : days(result.longestRiding.days), streakRange(result.longestRiding)),
      tile(
        "Más días seguidos parada, entre dos salidas",
        result.longestParked === null ? "—" : days(result.longestParked.days),
        streakRange(result.longestParked),
      ),
      tile("Racha en curso saliendo", days(result.currentRiding), "Sigue viva si saliste ayer: hoy aún no ha acabado"),
      tile("Días parada ahora", days(result.currentParked), "Días completos sin salir; hoy no cuenta"),
    ),
  );
}

function shortTripsBlock(data: RiderData, period: Period, periodLabel: string): HTMLElement {
  const result = shortTrips(inPeriod(data.figures, period));
  const meter = (label: string, share: number, detail: string): HTMLElement => {
    const id = uniqueId("meter");
    return el(
      "div",
      { class: "meter" },
      el("label", { attrs: { for: id } }, label),
      el("progress", { id, attrs: { max: 100, value: Math.round(share * 100) } }, formatPercent(share)),
      el("span", { class: "meter-value" }, `${formatPercent(share)} · ${detail}`),
    );
  };
  return block(
    "Trayectos cortos",
    periodLabel,
    el("p", { class: "lead" }, `Salidas de menos de ${withUnit(String(SHORT_TRIP_KM), "km")}.`),
    meter(
      "Parte de las salidas",
      result.rideShare,
      `${formatNumber(result.shortRides)} de ${plural(result.rides, "salida", "salidas")}`,
    ),
    meter("Parte de los km", result.kmShare, `${formatNumber(result.shortKm)} de ${formatWholeKm(result.km)}`),
  );
}

function maintenanceBlock(data: RiderData, scope: StorageScope): HTMLElement {
  const odometer = data.vehicle.odometer ?? data.info?.mileage ?? null;
  const intervalId = uniqueId("interval");
  const lastId = uniqueId("last-service");
  const stored = readMaintenance(scope);
  const interval = el("input", {
    id: intervalId,
    attrs: { type: "number", inputmode: "decimal", min: 1, max: 100000, step: "any", required: true, value: stored?.intervalKm ?? null },
  });
  const last = el("input", {
    id: lastId,
    attrs: { type: "number", inputmode: "decimal", min: 0, max: 10000000, step: "any", required: true, value: stored?.lastServiceKm ?? null },
  });
  const result = el("p", { class: "maintenance-result", attrs: { role: "status" } });

  function show(plan: MaintenancePlan | null, note = ""): void {
    if (plan === null) {
      result.textContent = note || "Escribe los dos números para saber cuánto falta.";
      return;
    }
    if (odometer === null) {
      result.textContent = `El servicio no ha dado el odómetro, así que no se puede calcular. ${note}`.trim();
      return;
    }
    const status = maintenanceStatus(plan, odometer);
    const due = formatWholeKm(status.dueAtKm);
    const text =
      status.remainingKm >= 0
        ? `Te faltan ${formatWholeKm(status.remainingKm)} para la revisión (toca a los ${due}).`
        : `Te has pasado ${formatWholeKm(-status.remainingKm)} de la revisión (tocaba a los ${due}).`;
    result.textContent = `${text} ${note}`.trim();
  }

  const form = el(
    "form",
    { class: "maintenance", attrs: { novalidate: true } },
    el("div", { class: "field" }, el("label", { attrs: { for: intervalId } }, "Revisión cada (km)"), interval),
    el("div", { class: "field" }, el("label", { attrs: { for: lastId } }, "Odómetro en la última revisión (km)"), last),
    el("button", { class: "button", attrs: { type: "submit" } }, "Guardar"),
    el(
      "button",
      {
        class: "button button-quiet",
        attrs: { type: "button" },
        on: {
          click: () => {
            clearMaintenance(scope);
            interval.value = "";
            last.value = "";
            show(null, "Números borrados de este navegador.");
          },
        },
      },
      "Borrar",
    ),
  );
  form.addEventListener("submit", (event) => {
    // The page never submits a form anywhere: everything stays in the browser.
    event.preventDefault();
    const plan =
      interval.value.trim() === "" || last.value.trim() === "" ? null : validPlan(Number(interval.value), Number(last.value));
    if (plan === null) {
      show(null, `Revisa los números: el intervalo debe estar entre 1 y ${withUnit("100.000", "km")}, y el odómetro entre 0 y ${withUnit("10.000.000", "km")}.`);
      return;
    }
    const saved = writeMaintenance(scope, plan);
    show(plan, saved ? "Guardado en este navegador." : "Este navegador no deja guardarlo: el cálculo vale hasta que cierres la página.");
  });
  show(stored);

  return block(
    "Mantenimiento",
    null,
    el(
      "p",
      { class: "lead" },
      "Escribe cada cuántos km toca revisión y el odómetro de la última. Los dos números se guardan solo en este navegador.",
    ),
    form,
    result,
  );
}

function cardBlock(data: RiderData, period: Period, periodLabel: string): HTMLElement {
  const content = cardContent(inPeriod(data.figures, period), period, data.demo);
  const text = cardText(content);
  const canvas = el("canvas", { class: "card-canvas", attrs: { role: "img", "aria-label": text } }, text);
  const drawn = drawCard(canvas, content);
  const button = el(
    "button",
    {
      class: "button button-primary",
      attrs: { type: "button", disabled: !drawn },
      on: {
        click: () => {
          canvas.toBlob((blob) => {
            if (blob !== null) downloadBlob(content.fileName, blob);
          }, "image/png");
        },
      },
    },
    "Descargar tarjeta (PNG)",
  );
  return block(
    "Tarjeta para compartir",
    periodLabel,
    el("p", { class: "lead" }, "Solo cifras: sin mapa, sin coordenadas y sin fechas de rutas concretas."),
    drawn ? canvas : el("p", { class: "notice" }, text),
    button,
  );
}

/** The footer: what the figures mean and what the web does with the data. */
function footer(data: RiderData): HTMLElement {
  const short = plural(data.hiddenShort, "ruta", "rutas");
  let shortNote: string;
  if (data.hiddenShort === 0) shortNote = "No hay rutas de menos de 300 m.";
  else if (data.shortCounted) shortNote = `${short} de menos de 300 m no se listan ni se dibujan, pero sí cuentan en las cifras.`;
  else {
    shortNote = `${short} de menos de 300 m no ${data.hiddenShort === 1 ? "cuenta como salida ni aparece" : "cuentan como salidas ni aparecen"} en la lista ni en el mapa. La app de MAPIT sí las cuenta, así que su número de salidas puede ser mayor.`;
  }
  const skipped =
    data.skipped === 0
      ? "Ninguna ruta se ha descartado por venir sin fecha o sin km."
      : `${plural(data.skipped, "ruta se ha descartado", "rutas se han descartado")} porque el servicio ${data.skipped === 1 ? "la envió" : "las envió"} sin fecha o sin km.`;
  return el(
    "footer",
    { class: "site-foot rv" },
    el(
      "div",
      { class: "notes" },
      el("h2", { class: "foot-title" }, "Notas"),
      el(
        "ul",
        {},
        el("li", {}, "Los «km» y las velocidades son los que entrega el servicio; el propio servicio avisa de que esa conversión de unidades está sin confirmar."),
        el("li", {}, shortNote),
        el("li", {}, skipped),
        el("li", {}, "Fechas y horas en la zona horaria de este navegador."),
        el(
          "li",
          {},
          "El historial se lee hacia atrás, año a año, y se deja de buscar al encontrar un año natural entero sin rutas: lo anterior a ese año no aparece.",
        ),
      ),
    ),
    el(
      "div",
      { class: "foot-privacy" },
      el("h2", { class: "foot-title" }, "Privacidad"),
      el(
        "ul",
        {},
        ...PROMISES.map((promise) => el("li", {}, promise)),
        el("li", {}, "Al salir, la web olvida tus datos. En este navegador solo quedan los dos números del mantenimiento, si los guardas."),
      ),
    ),
    el("p", { class: "foot-brand" }, el("b", {}, "Ride"), " Log · proyecto personal, sin relación con Honda ni con MAPIT."),
  );
}

/** The sentence of the hero, from the whole history: «412 salidas entre el 3 ene 2024 y el 9 nov 2026.» */
function heroLead(data: RiderData): HTMLElement {
  const starts = data.figures.map((route) => route.startMs);
  if (starts.length === 0) return el("p", { class: "lead hero-lead" }, "Todavía no hay salidas en esta cuenta.");
  const first = Math.min(...starts);
  const last = Math.max(...starts);
  const count = el("b", {}, plural(starts.length, "salida", "salidas"));
  return starts.length === 1
    ? el("p", { class: "lead hero-lead" }, count, `, el ${formatDate(first)}.`)
    : el("p", { class: "lead hero-lead" }, count, ` entre el ${formatDate(first)} y el ${formatDate(last)}.`);
}

/** Three title lines that rise one after another; the last one in bright red. */
export function heroTitle(id: string, lines: readonly string[]): HTMLElement {
  const title = el("h2", { id, class: "hero-title" });
  lines.forEach((line, index) => {
    if (index > 0) title.append(" ");
    const inner = el("span", { class: index === lines.length - 1 ? "ln-in red" : "ln-in" }, line);
    const outer = el("span", { class: "ln" }, inner);
    outer.style.setProperty("--l", String(index));
    title.append(outer);
  });
  return title;
}

function hero(data: RiderData): HTMLElement {
  const id = uniqueId("hero");
  return el(
    "section",
    { class: "hero", attrs: { "aria-labelledby": id } },
    el(
      "div",
      { class: "hero-grid" },
      el(
        "div",
        { class: "hero-copy" },
        el("p", { class: "eyebrow hero-eyebrow" }, `${data.info?.model ?? "Tu moto"} · Ride Log`),
        heroTitle(id, ["Una moto.", "Cada", "trazo."]),
        heroLead(data),
      ),
      statusPlate(data),
    ),
  );
}

export interface PageSection {
  /** A short internal name (`resumen`, `ritmo`...): `data-section`, never the address. */
  readonly id: string;
  /** The label of its link in the top bar. */
  readonly label: string;
  readonly element: HTMLElement;
  readonly header: SectionHeader;
}

export interface RiderPage {
  readonly hero: HTMLElement;
  readonly sections: readonly PageSection[];
  readonly footer: HTMLElement;
  /** The period selector, for the top bar; null for an account without rides. */
  readonly period: HTMLElement | null;
}

export interface RiderPageOptions {
  /** Aborted when the page replaces this view: running counts, reveals and observers stop in their final state. */
  readonly signal?: AbortSignal | undefined;
  /** The content of section «Rutas» (map and list), built by the page; without it there is no such section. */
  readonly archive?: HTMLElement | undefined;
}

export function renderRiderPage(data: RiderData, scope: StorageScope, options: RiderPageOptions = {}): RiderPage {
  const { signal } = options;
  const currentYear = new Date(data.nowMs).getFullYear();
  const years = [...new Set([currentYear, ...yearsWithRoutes(data.figures)])].sort((a, b) => b - a);
  let period: Period = SUMMARY_DEFAULT_PERIOD === "all" ? "all" : currentYear;
  const empty = data.figures.length === 0;

  const sections: PageSection[] = [];
  function section(id: string, label: string, lines: readonly string[], ...children: (Node | null)[]): PageSection {
    const number = String(sections.length + 1).padStart(2, "0");
    const headingId = uniqueId("section");
    const header = sectionHeader(number, label, lines, headingId);
    const element = el(
      "section",
      { class: `page-sec sec-${id}`, attrs: { "aria-labelledby": headingId, "data-section": id } },
      header.element,
      ...children,
    );
    const made = { id, label, element, header };
    sections.push(made);
    return made;
  }

  // Blocks that follow the period live in slots, refilled on each change.
  const slot = (): HTMLElement => el("div", { class: "slot" });
  const slots = { records: slot(), habits: slot(), shortTrips: slot(), card: slot() };
  const periodScope = el("span", { class: "scope" });
  const readout = el("dl", { class: "readout rv" });

  const summary = section(
    "resumen",
    "Resumen",
    figuresTitle(period, currentYear),
    empty
      ? el("p", { class: "notice", attrs: { role: "status" } }, "Todavía no hay rutas en esta cuenta. Cuando salgas con la moto, aquí aparecerán tus cifras.")
      : el("div", { class: "sec-top" }, periodScope, el("span", { class: "sec-hint" }, "El periodo se elige arriba, en la barra")),
    empty ? null : readout,
  );
  if (!empty) {
    section(
      "ritmo",
      "Ritmo",
      ["El pulso", "de los meses"],
      monthsBlock(data),
      el("div", { class: "grid-2" }, slots.records, monthDetailBlock(data)),
      streaksBlock(data),
    );
    section("habitos", "Hábitos", ["Cada salida", "cuenta"], slots.habits, slots.shortTrips);
  }
  if (options.archive !== undefined) section("rutas", "Rutas", ["El archivo", "de salidas"], options.archive);
  section("taller", "Taller", ["A punto"], el("div", { class: "grid-2 grid-taller" }, maintenanceBlock(data, scope), empty ? null : slots.card));

  const page = { hero: hero(data), footer: footer(data) };
  // Everything that never changes is revealed once, before the slots are filled,
  // so that no observer keeps watching a block a period change has removed.
  for (const part of [page.hero, ...sections.map((one) => one.element), page.footer]) reveal(part, { signal });

  const seen = watchOnScreen([...Object.values(slots), summary.header.element], { signal });

  /** Motion of the current drawing; replaced on each period change. */
  let drawing: AbortController | null = null;
  signal?.addEventListener("abort", () => drawing?.abort(), { once: true });

  function draw(first: boolean): void {
    drawing?.abort();
    if (empty) return;
    const motion = new AbortController();
    drawing = motion;
    const label = period === "all" ? "Todo el historial" : `Año ${period}`;
    summary.header.setTitle(figuresTitle(period, currentYear));
    periodScope.textContent = label;
    // The first count lasts the hero duration; a period change counts again, shorter.
    const durationMs = first ? undefined : durationToken("--dur-reveal", 520);
    clear(readout);
    readout.append(
      ...figures(data, period, (element, value) => {
        countUp(element, value, (shown) => formatNumber(shown), { signal: motion.signal, durationMs });
      }),
    );
    const blocks: [HTMLElement, HTMLElement][] = [
      [slots.records, recordsBlock(data, period, label)],
      [slots.habits, habitsBlock(data, period, label)],
      [slots.shortTrips, shortTripsBlock(data, period, label)],
      [slots.card, cardBlock(data, period, label)],
    ];
    let order = 0;
    for (const [place, made] of blocks) {
      const swap = !first && seen(place);
      place.replaceChildren(made);
      if (swap) {
        // On screen: the new block fades in where the old one was, one after
        // another; its parts are shown at once (bars still grow).
        for (const part of [made, ...made.querySelectorAll(".rv")]) part.classList.add("in");
        made.style.setProperty("--d", String(Math.min(order, MAX_STAGGER)));
        made.classList.add("swap");
        order += 1;
      } else {
        reveal(made, { signal: motion.signal });
      }
    }
    if (!first && seen(summary.header.element)) summary.header.replay();
  }

  const control = empty
    ? null
    : periodControl(
        years,
        period,
        (next) => {
          period = next;
          draw(false);
        },
        { signal },
      );
  draw(true);

  return { ...page, sections, period: control?.element ?? null };
}
