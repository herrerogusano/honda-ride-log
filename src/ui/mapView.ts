/** The Mapa tab. The map itself (Leaflet) arrives in the next change; this is its frame. */
import { formatDateLong, formatKm, formatTime } from "../domain/format";
import type { Route } from "../domain/model";
import type { ToolCaller } from "../service/contract";
import type { RiderData } from "./data";
import { clear, el } from "./dom";

export interface MapView {
  readonly element: HTMLElement;
  /** Shows one route. Its trace is requested now, never before. */
  open(route: Route): void;
  /** Tells the view its tab has just become visible. */
  shown(): void;
}

export type MapFactory = (data: RiderData, caller: ToolCaller) => MapView;

export const createMapView: MapFactory = () => {
  const body = el("div", { class: "stack" }, el("p", { class: "notice" }, "Elige una ruta en la pestaña Rutas para verla aquí."));
  return {
    element: body,
    open(route) {
      clear(body);
      body.append(
        el("h3", {}, `Ruta del ${formatDateLong(route.startMs)}`),
        el("p", { class: "lead" }, `Salida a las ${formatTime(route.startMs)} · ${formatKm(route.distanceKm)}`),
        el("p", { class: "notice" }, "El mapa todavía no está disponible."),
      );
    },
    shown() {
      // Nothing to lay out yet.
    },
  };
};
