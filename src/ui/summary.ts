/** The Resumen tab (docs/PLAN.md, "Resumen"). Everything is computed here, in the browser. */
import { SUMMARY_DEFAULT_PERIOD } from "../config";
import {
  formatDate,
  formatKm,
  formatMonth,
  formatNumber,
  formatPercent,
  formatTime,
  MONTHS_LONG,
  MONTHS_SHORT,
  WEEKDAYS_LONG,
  WEEKDAYS_SHORT,
} from "../domain/format";
import { maintenanceStatus, validPlan, type MaintenancePlan } from "../domain/maintenance";
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

const days = (count: number): string => (count === 1 ? "1 día" : `${formatNumber(count)} días`);
const plural = (count: number, one: string, many: string): string => `${formatNumber(count)} ${count === 1 ? one : many}`;

function section(title: string, scope: string | null, ...children: (Node | null)[]): HTMLElement {
  const id = uniqueId("section");
  return el(
    "section",
    { class: "block", attrs: { "aria-labelledby": id } },
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

function statusSection(data: RiderData): HTMLElement {
  const { vehicle, info } = data;
  const lastUse = lastUseMs(data.figures, vehicle);
  const odometer = vehicle.odometer ?? info?.mileage ?? null;
  return section(
    "Estado",
    info?.model ?? null,
    el(
      "dl",
      { class: "tiles tiles-3" },
      tile("Batería", vehicle.batteryPercent === null ? "—" : `${formatNumber(vehicle.batteryPercent)} %`),
      tile(
        "Último uso",
        lastUse === null ? "—" : formatDate(lastUse),
        lastUse === null ? "Sin rutas ni comunicación registrada" : `a las ${formatTime(lastUse)}`,
      ),
      tile("Odómetro", odometer === null ? "—" : `${formatNumber(odometer)} km`),
    ),
  );
}

function signedKm(km: number): string {
  const rounded = Math.round(km);
  if (rounded === 0) return "igual";
  return `${rounded > 0 ? "+" : "−"}${formatNumber(Math.abs(rounded))} km`;
}

function figuresSection(data: RiderData, period: Period, periodLabel: string): HTMLElement {
  const sum = totals(inPeriod(data.figures, period));
  const month = monthVsLastYear(data.figures, data.nowMs);
  return section(
    "Cifras",
    periodLabel,
    el(
      "dl",
      { class: "tiles tiles-4" },
      tile("Kilómetros", `${formatNumber(sum.km)} km`),
      tile("Salidas", formatNumber(sum.rides)),
      tile(
        "Horas en marcha",
        `${formatNumber(sum.hours)} h`,
        sum.ridesWithoutDuration > 0
          ? `${plural(sum.ridesWithoutDuration, "salida", "salidas")} sin duración conocida no suman`
          : null,
      ),
      tile(
        `${MONTHS_LONG[month.month]} frente a ${MONTHS_LONG[month.month]} de ${month.year - 1}`,
        `${formatNumber(month.km)} km`,
        `${formatNumber(month.previousKm)} km hace un año · ${signedKm(month.differenceKm)}. No depende del periodo elegido.`,
      ),
    ),
  );
}

function monthsSection(data: RiderData): HTMLElement {
  const series = kmByMonth(data.figures);
  return section(
    "Km por mes",
    "Últimos años con rutas",
    barChart({
      title: "Kilómetros por mes, comparando años",
      categories: MONTHS_SHORT,
      categoryNames: MONTHS_LONG,
      categoryHeader: "Mes",
      series: series.map((one) => ({ label: String(one.year), values: one.km })),
      formatValue: (value) => `${formatNumber(value)} km`,
    }),
  );
}

function habitsSection(data: RiderData, period: Period, periodLabel: string): HTMLElement {
  const routes = inPeriod(data.figures, period);
  const count = (value: number): string => formatNumber(value);
  return section(
    "Hábitos",
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
          categoryNames: Array.from({ length: 24 }, (_, hour) => `${hour} h`),
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

function recordsSection(data: RiderData, period: Period, periodLabel: string): HTMLElement {
  const best = records(inPeriod(data.figures, period));
  const row = (label: string, value: string, when: string): HTMLElement =>
    el("li", { class: "record" }, el("span", { class: "record-label" }, label), el("strong", {}, value), el("span", { class: "record-when" }, when));
  return section(
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
        best.bestMonth === null ? "—" : `${formatNumber(best.bestMonth.km)} km`,
        best.bestMonth === null ? "" : formatMonth(best.bestMonth.year, best.bestMonth.month),
      ),
    ),
  );
}

function streakRange(streak: Streak | null): string {
  if (streak === null) return "";
  return streak.days === 1 ? formatDate(streak.fromMs) : `del ${formatDate(streak.fromMs)} al ${formatDate(streak.toMs)}`;
}

function streaksSection(data: RiderData): HTMLElement {
  const result = streaks(data.figures, data.nowMs);
  return section(
    "Rachas",
    "Todo el historial",
    el(
      "dl",
      { class: "tiles tiles-4" },
      tile("Más días seguidos saliendo", result.longestRiding === null ? "—" : days(result.longestRiding.days), streakRange(result.longestRiding)),
      tile("Más días seguidos parada", result.longestParked === null ? "—" : days(result.longestParked.days), streakRange(result.longestParked)),
      tile("Racha en curso saliendo", days(result.currentRiding), "Sigue viva si saliste ayer: hoy aún no ha acabado"),
      tile("Días parada ahora", days(result.currentParked), "Días completos sin salir; hoy no cuenta"),
    ),
  );
}

function shortTripsSection(data: RiderData, period: Period, periodLabel: string): HTMLElement {
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
  return section(
    "Trayectos cortos",
    periodLabel,
    el("p", { class: "lead" }, `Salidas de menos de ${SHORT_TRIP_KM} km.`),
    meter(
      "Parte de las salidas",
      result.rideShare,
      `${formatNumber(result.shortRides)} de ${plural(result.rides, "salida", "salidas")}`,
    ),
    meter("Parte de los km", result.kmShare, `${formatNumber(result.shortKm)} de ${formatNumber(result.km)} km`),
  );
}

function maintenanceSection(data: RiderData, scope: StorageScope): HTMLElement {
  const odometer = data.vehicle.odometer ?? data.info?.mileage ?? null;
  const intervalId = uniqueId("interval");
  const lastId = uniqueId("last-service");
  const stored = readMaintenance(scope);
  const interval = el("input", {
    id: intervalId,
    attrs: { type: "number", inputmode: "numeric", min: 1, max: 100000, step: 1, required: true, value: stored?.intervalKm ?? null },
  });
  const last = el("input", {
    id: lastId,
    attrs: { type: "number", inputmode: "numeric", min: 0, max: 10000000, step: 1, required: true, value: stored?.lastServiceKm ?? null },
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
    const due = `${formatNumber(status.dueAtKm)} km`;
    const text =
      status.remainingKm >= 0
        ? `Te faltan ${formatNumber(status.remainingKm)} km para la revisión (toca a los ${due}).`
        : `Te has pasado ${formatNumber(-status.remainingKm)} km de la revisión (tocaba a los ${due}).`;
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
      show(null, "Revisa los números: el intervalo debe ser mayor que 0 y el odómetro no puede ser negativo.");
      return;
    }
    const saved = writeMaintenance(scope, plan);
    show(plan, saved ? "Guardado en este navegador." : "Este navegador no deja guardarlo: el cálculo vale hasta que cierres la página.");
  });
  show(stored);

  return section(
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

function cardSection(data: RiderData, period: Period, periodLabel: string): HTMLElement {
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
  return section(
    "Tarjeta para compartir",
    periodLabel,
    el("p", { class: "lead" }, "Solo cifras: sin mapa, sin coordenadas y sin fechas de rutas concretas."),
    drawn ? canvas : el("p", { class: "notice" }, text),
    button,
  );
}

function notes(data: RiderData): HTMLElement {
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
    { class: "notes" },
    el("h3", { class: "sr-only" }, "Notas"),
    el(
      "ul",
      {},
      el("li", {}, "Los «km» y las velocidades son los que entrega el servicio; el propio servicio avisa de que esa conversión de unidades está sin confirmar."),
      el("li", {}, shortNote),
      el("li", {}, skipped),
      el("li", {}, "Fechas y horas en la zona horaria de este navegador."),
    ),
  );
}

export function renderSummary(data: RiderData, scope: StorageScope): HTMLElement {
  const currentYear = new Date(data.nowMs).getFullYear();
  const years = [...new Set([currentYear, ...yearsWithRoutes(data.figures)])].sort((a, b) => b - a);
  let period: Period = SUMMARY_DEFAULT_PERIOD === "all" ? "all" : currentYear;

  const selectId = uniqueId("period");
  const select = el(
    "select",
    { id: selectId },
    ...years.map((year) => el("option", { attrs: { value: year, selected: year === period } }, String(year))),
    el("option", { attrs: { value: "all", selected: period === "all" } }, "Todo"),
  );
  const picker = el("div", { class: "period" }, el("label", { attrs: { for: selectId } }, "Periodo"), select);

  const byPeriodTop = el("div", { class: "stack" });
  const byPeriodBottom = el("div", { class: "stack" });
  const empty = data.figures.length === 0;

  function draw(): void {
    const label = period === "all" ? "Todo el historial" : `Año ${period}`;
    clear(byPeriodTop);
    clear(byPeriodBottom);
    if (empty) return;
    byPeriodTop.append(figuresSection(data, period, label));
    byPeriodBottom.append(
      habitsSection(data, period, label),
      recordsSection(data, period, label),
      shortTripsSection(data, period, label),
      cardSection(data, period, label),
    );
  }
  select.addEventListener("change", () => {
    period = select.value === "all" ? "all" : Number(select.value);
    draw();
  });
  draw();

  return el(
    "div",
    { class: "stack" },
    statusSection(data),
    empty
      ? el("p", { class: "notice", attrs: { role: "status" } }, "Todavía no hay rutas en esta cuenta. Cuando salgas con la moto, aquí aparecerán tus cifras.")
      : picker,
    byPeriodTop,
    empty ? null : monthsSection(data),
    byPeriodBottom,
    empty ? null : streaksSection(data),
    maintenanceSection(data, scope),
    notes(data),
  );
}
