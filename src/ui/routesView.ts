/** The list of section «Rutas»: searchable, sortable, and the CSV export of what it shows. */
import { routesToCsv } from "../domain/csv";
import {
  formatDate,
  formatDuration,
  formatEndTime,
  formatInferred,
  formatIsoDate,
  formatNumber,
  formatTime,
  matchesSearch,
  WEEKDAYS_SHORT,
} from "../domain/format";
import type { Route } from "../domain/model";
import type { RiderData } from "./data";
import { clear, el, uniqueId } from "./dom";
import { downloadBlob } from "./download";
import { scrollBehavior } from "./motion";

export type SortOrder = "date_desc" | "date_asc" | "km_desc" | "km_asc" | "max_speed_desc";

const SORTS: readonly { readonly id: SortOrder; readonly label: string }[] = [
  { id: "date_desc", label: "Fecha, las más recientes primero" },
  { id: "date_asc", label: "Fecha, las más antiguas primero" },
  { id: "km_desc", label: "Distancia, de mayor a menor" },
  { id: "km_asc", label: "Distancia, de menor a mayor" },
  // Short on purpose: the select is as wide as its longest option, and a longer one
  // made the page scroll sideways at 320 px (checked in Chrome on 2026-11-10).
  { id: "max_speed_desc", label: "Vel. máxima, de mayor a menor" },
];

/** The footnote under the list; the map repeats the same caveats in its legend. */
export const ROUTES_NOTE =
  "Los km y las velocidades media y máxima son los que entrega el servicio; el propio servicio avisa de que sus unidades están sin confirmar. " +
  "«Tramos inferidos» es una etiqueta descriptiva del servicio, no una garantía de precisión del GPS. Un guion (—) es un dato que el servicio no ha enviado.";

/** Rows drawn at first and added by each "show more". */
export const PAGE_SIZE = 100;

/** The routes that match the search, in the chosen order. This is also what the CSV carries. */
export function selectRoutes(routes: readonly Route[], query: string, order: SortOrder): Route[] {
  const found = routes.filter((route) => matchesSearch(route, query));
  const byDate = (a: Route, b: Route): number => a.startMs - b.startMs;
  const byKm = (a: Route, b: Route): number => a.distanceKm - b.distanceKm || byDate(a, b);
  if (order === "date_asc") return found.sort(byDate);
  if (order === "date_desc") return found.sort((a, b) => byDate(b, a));
  if (order === "km_asc") return found.sort(byKm);
  if (order === "max_speed_desc") {
    // Fastest first; a route without a maximum goes last; a tie, oldest first.
    const fastest = (route: Route): number => route.maxSpeed ?? -1;
    return found.sort((a, b) => fastest(b) - fastest(a) || byDate(a, b));
  }
  return found.sort((a, b) => byKm(b, a));
}

const speedCell = (speed: number | null): string => (speed === null ? "—" : formatNumber(speed));

function weekday(ms: number): string {
  return WEEKDAYS_SHORT[(new Date(ms).getDay() + 6) % 7] as string;
}

export interface RouteListOptions {
  /**
   * Where the visible part of the page starts, in pixels from the top of the
   * window, when the list is not a box of its own (phones: under the bar and
   * the pinned map). Used to keep the chosen row in view.
   */
  readonly visibleTop?: (() => number) | undefined;
}

export interface RouteList {
  readonly element: HTMLElement;
  /** The footnote, placed by the page; `renderRoutes` keeps it under the list. */
  readonly note: HTMLElement;
  /**
   * Marks `route` as the chosen one. With `reveal`, its row is brought into
   * view: inside the list's own box when the list is one (wide screens), or
   * the page, only as far as needed, when the list is part of the page.
   */
  mark(route: Route, reveal: boolean): void;
}

/** A box scrolls by itself when its content is taller than it and its overflow lets it. */
function scrollsByItself(box: HTMLElement): boolean {
  if (box.scrollHeight <= box.clientHeight + 1) return false;
  const overflow = getComputedStyle(box).overflowY;
  return overflow === "auto" || overflow === "scroll";
}

/** Room left between the edge of the visible part and a row brought into view. */
const ROW_GAP = 12;

export function createRouteList(data: RiderData, onOpen: (route: Route) => void, options: RouteListOptions = {}): RouteList {
  const note = el("p", { class: "fine-print" }, ROUTES_NOTE);
  if (data.routes.length === 0) {
    return { element: el("p", { class: "notice", attrs: { role: "status" } }, "No hay rutas que mostrar."), note, mark: () => undefined };
  }

  let order: SortOrder = "date_desc";
  let shown = PAGE_SIZE;
  let current: Route[] = [];
  let chosen: Route | null = null;
  const rows = new Map<Route, HTMLTableRowElement>();

  const searchId = uniqueId("search");
  const sortId = uniqueId("sort");
  const search = el("input", { id: searchId, attrs: { type: "search", autocomplete: "off", placeholder: "sábado, marzo 2026, 07/03/2026…" } });
  const sort = el("select", { id: sortId }, ...SORTS.map((one) => el("option", { attrs: { value: one.id } }, one.label)));
  const count = el("p", { class: "count", attrs: { role: "status" } });
  const body = el("tbody", { attrs: { role: "rowgroup" } });
  const more = el("button", { class: "button", attrs: { type: "button" } }, "Mostrar más rutas");
  const exportButton = el("button", { class: "button", attrs: { type: "button" } }, "Exportar CSV");

  // Each cell names its figure for the row layout of the stylesheet (`data-label`, `data-unit`);
  // the table header stays the one screen readers announce.
  const cell = (text: string, label: string, kind: string, unit = ""): HTMLElement =>
    el("td", { class: kind, attrs: { role: "cell", "data-label": label, "data-unit": unit === "" ? null : unit } }, text);

  function row(route: Route): HTMLTableRowElement {
    const label = `${weekday(route.startMs)} ${formatDate(route.startMs)}`;
    const button = el(
      "button",
      { class: "row-button", attrs: { type: "button", title: "Ver esta ruta en el mapa" }, on: { click: () => onOpen(route) } },
      label,
      el("span", { class: "sr-only" }, ", ver en el mapa"),
    );
    const known = (value: number | null): string => (value === null ? "" : "km/h");
    const tr = el(
      "tr",
      { class: route === chosen ? "is-chosen" : "", attrs: { role: "row" } },
      el("th", { class: "c-date", attrs: { scope: "row", role: "rowheader" } }, button),
      cell(formatTime(route.startMs), "Salida", "c-start"),
      cell(formatEndTime(route.startMs, route.endMs), "Llegada", "c-end"),
      cell(formatDuration(route.durationS), "Duración", "c-dur"),
      cell(formatNumber(route.distanceKm, 1), "Distancia", "num c-km", "km"),
      cell(speedCell(route.averageSpeed), "Media", "num c-avg", known(route.averageSpeed)),
      cell(speedCell(route.maxSpeed), "Máxima", "num c-max", known(route.maxSpeed)),
      cell(formatInferred(route.hasInferredSegments), "Inferidos", route.hasInferredSegments === true ? "c-inf on" : "c-inf"),
    );
    if (route === chosen) button.setAttribute("aria-current", "true");
    rows.set(route, tr);
    return tr;
  }

  function draw(): void {
    current = selectRoutes(data.routes, search.value, order);
    clear(body);
    rows.clear();
    body.append(...current.slice(0, shown).map(row));
    const total = current.length;
    count.textContent =
      total === 0
        ? "Ninguna ruta coincide con la búsqueda."
        : `${formatNumber(total)} ${total === 1 ? "ruta" : "rutas"}${total > shown ? `; se muestran las primeras ${formatNumber(shown)}` : ""}.`;
    more.hidden = total <= shown;
    exportButton.disabled = total === 0;
  }

  const scroller = el(
    "div",
    { class: "routes-scroll", attrs: { role: "region", "aria-label": "Lista de rutas", tabindex: 0 } },
    el(
      "table",
      { class: "data-table routes-table", attrs: { role: "table" } },
      el("caption", { class: "sr-only" }, "Rutas. Pulsa una fecha para ver la ruta en el mapa."),
      el(
        "thead",
        { attrs: { role: "rowgroup" } },
        el(
          "tr",
          { attrs: { role: "row" } },
          el("th", { attrs: { scope: "col", role: "columnheader" } }, "Fecha"),
          el("th", { attrs: { scope: "col", role: "columnheader" } }, "Salida"),
          el("th", { attrs: { scope: "col", role: "columnheader" } }, "Llegada"),
          el("th", { attrs: { scope: "col", role: "columnheader" } }, "Duración"),
          el("th", { class: "num", attrs: { scope: "col", role: "columnheader" } }, "Km"),
          el("th", { class: "num", attrs: { scope: "col", role: "columnheader" } }, "Vel. media (km/h)"),
          el("th", { class: "num", attrs: { scope: "col", role: "columnheader" } }, "Vel. máx. (km/h)"),
          el("th", { attrs: { scope: "col", role: "columnheader" } }, "Tramos inferidos"),
        ),
      ),
      body,
    ),
    more,
  );

  /** Brings a row into view without moving anything that does not need to move. */
  function bringRow(tr: HTMLElement): void {
    const box = tr.getBoundingClientRect();
    if (scrollsByItself(scroller)) {
      const frame = scroller.getBoundingClientRect();
      const head = scroller.querySelector("thead")?.getBoundingClientRect().height ?? 0;
      if (box.top >= frame.top + head && box.bottom <= frame.bottom) return;
      const top = scroller.scrollTop + box.top - frame.top - head - ROW_GAP;
      scroller.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior() });
      return;
    }
    const visibleTop = options.visibleTop?.() ?? 0;
    if (box.top >= visibleTop && box.bottom <= window.innerHeight) return;
    const delta = box.top < visibleTop ? box.top - visibleTop - ROW_GAP : box.bottom - window.innerHeight + ROW_GAP;
    window.scrollTo({ top: Math.max(0, window.scrollY + delta), behavior: scrollBehavior() });
  }

  function mark(route: Route, revealRow: boolean): void {
    if (chosen !== null) {
      const before = rows.get(chosen);
      before?.classList.remove("is-chosen");
      before?.querySelector(".row-button")?.removeAttribute("aria-current");
    }
    chosen = route;
    let tr = rows.get(route);
    // A route that matches the search but is past the rows drawn: draw up to it.
    if (tr === undefined) {
      const at = current.indexOf(route);
      if (at < 0) return;
      shown = Math.ceil((at + 1) / PAGE_SIZE) * PAGE_SIZE;
      draw();
      tr = rows.get(route);
      if (tr === undefined) return;
    }
    tr.classList.add("is-chosen");
    tr.querySelector(".row-button")?.setAttribute("aria-current", "true");
    if (revealRow) bringRow(tr);
  }

  // ↑ and ↓ on a row move to the route above or below and open it.
  body.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const from = (event.target as HTMLElement).closest("tr");
    if (from === null || !(event.target as HTMLElement).classList.contains("row-button")) return;
    const to = event.key === "ArrowDown" ? from.nextElementSibling : from.previousElementSibling;
    const button = to?.querySelector<HTMLButtonElement>(".row-button");
    event.preventDefault();
    if (button === null || button === undefined) return;
    button.focus({ preventScroll: true });
    button.click();
    bringRow(to as HTMLElement);
  });

  search.addEventListener("input", () => {
    shown = PAGE_SIZE;
    draw();
  });
  sort.addEventListener("change", () => {
    order = sort.value as SortOrder;
    shown = PAGE_SIZE;
    draw();
  });
  more.addEventListener("click", () => {
    shown += PAGE_SIZE;
    draw();
  });
  exportButton.addEventListener("click", () => {
    const blob = new Blob([routesToCsv(current)], { type: "text/csv;charset=utf-8" });
    downloadBlob(`rutas-${formatIsoDate(data.nowMs)}${data.demo ? "-demo" : ""}.csv`, blob);
  });
  draw();

  const element = el(
    "div",
    { class: "route-list" },
    el(
      "div",
      { class: "toolbar list-tools" },
      el("div", { class: "field grow" }, el("label", { attrs: { for: searchId } }, "Buscar por fecha"), search),
      el("div", { class: "field" }, el("label", { attrs: { for: sortId } }, "Orden"), sort),
      exportButton,
    ),
    count,
    scroller,
  );
  return { element, note, mark };
}

/** The list with its footnote under it, as one block. */
export function renderRoutes(data: RiderData, onOpen: (route: Route) => void): HTMLElement {
  const list = createRouteList(data, onOpen);
  if (data.routes.length === 0) return list.element;
  return el("div", { class: "stack" }, list.element, list.note);
}

