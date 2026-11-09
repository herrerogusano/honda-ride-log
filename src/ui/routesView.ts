/** The Rutas tab: a searchable, sortable list and the CSV export of what it shows. */
import { routesToCsv } from "../domain/csv";
import { formatDate, formatDuration, formatIsoDate, formatNumber, formatTime, matchesSearch, WEEKDAYS_SHORT } from "../domain/format";
import type { Route } from "../domain/model";
import type { RiderData } from "./data";
import { clear, el, uniqueId } from "./dom";
import { downloadBlob } from "./download";

export type SortOrder = "date_desc" | "date_asc" | "km_desc" | "km_asc";

const SORTS: readonly { readonly id: SortOrder; readonly label: string }[] = [
  { id: "date_desc", label: "Fecha, las más recientes primero" },
  { id: "date_asc", label: "Fecha, las más antiguas primero" },
  { id: "km_desc", label: "Distancia, de mayor a menor" },
  { id: "km_asc", label: "Distancia, de menor a mayor" },
];

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
  return found.sort((a, b) => byKm(b, a));
}

function weekday(ms: number): string {
  return WEEKDAYS_SHORT[(new Date(ms).getDay() + 6) % 7] as string;
}

export function renderRoutes(data: RiderData, onOpen: (route: Route) => void): HTMLElement {
  if (data.routes.length === 0) {
    return el("p", { class: "notice", attrs: { role: "status" } }, "No hay rutas que mostrar.");
  }

  let order: SortOrder = "date_desc";
  let shown = PAGE_SIZE;
  let current: Route[] = [];

  const searchId = uniqueId("search");
  const sortId = uniqueId("sort");
  const search = el("input", { id: searchId, attrs: { type: "search", autocomplete: "off", placeholder: "sábado, marzo 2026, 07/03/2026…" } });
  const sort = el("select", { id: sortId }, ...SORTS.map((one) => el("option", { attrs: { value: one.id } }, one.label)));
  const count = el("p", { class: "count", attrs: { role: "status" } });
  const body = el("tbody");
  const more = el("button", { class: "button", attrs: { type: "button" } }, "Mostrar más rutas");
  const exportButton = el("button", { class: "button", attrs: { type: "button" } }, "Exportar CSV");

  function row(route: Route): HTMLElement {
    const label = `${weekday(route.startMs)} ${formatDate(route.startMs)}`;
    return el(
      "tr",
      {},
      el(
        "th",
        { attrs: { scope: "row" } },
        el(
          "button",
          { class: "row-button", attrs: { type: "button", title: "Ver esta ruta en el mapa" }, on: { click: () => onOpen(route) } },
          label,
          el("span", { class: "sr-only" }, ", ver en el mapa"),
        ),
      ),
      el("td", {}, formatTime(route.startMs)),
      el("td", {}, formatDuration(route.durationS)),
      el("td", { class: "num" }, formatNumber(route.distanceKm, 1)),
      el("td", { class: "num" }, route.averageSpeed === null ? "—" : formatNumber(route.averageSpeed)),
    );
  }

  function draw(): void {
    current = selectRoutes(data.routes, search.value, order);
    clear(body);
    body.append(...current.slice(0, shown).map(row));
    const total = current.length;
    count.textContent =
      total === 0
        ? "Ninguna ruta coincide con la búsqueda."
        : `${formatNumber(total)} ${total === 1 ? "ruta" : "rutas"}${total > shown ? `; se muestran las primeras ${formatNumber(shown)}` : ""}.`;
    more.hidden = total <= shown;
    exportButton.disabled = total === 0;
  }

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

  return el(
    "div",
    { class: "stack" },
    el(
      "div",
      { class: "toolbar" },
      el("div", { class: "field grow" }, el("label", { attrs: { for: searchId } }, "Buscar por fecha"), search),
      el("div", { class: "field" }, el("label", { attrs: { for: sortId } }, "Orden"), sort),
      exportButton,
    ),
    count,
    el(
      "div",
      { class: "table-scroll" },
      el(
        "table",
        { class: "data-table routes-table" },
        el("caption", { class: "sr-only" }, "Rutas. Pulsa una fecha para ver la ruta en el mapa."),
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", { attrs: { scope: "col" } }, "Fecha"),
            el("th", { attrs: { scope: "col" } }, "Salida"),
            el("th", { attrs: { scope: "col" } }, "Duración"),
            el("th", { class: "num", attrs: { scope: "col" } }, "Km"),
            el("th", { class: "num", attrs: { scope: "col" } }, "Vel. media (km/h)"),
          ),
        ),
        body,
      ),
    ),
    more,
  );
}
