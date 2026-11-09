/**
 * The Mapa tab: one map and the route chosen in the Rutas tab. A route's
 * trace is requested when the route is opened, never earlier, and only its
 * trimmed lines are kept in memory, so the same route is not asked twice.
 */
import { formatDateLong, formatDuration, formatKm, formatTime } from "../domain/format";
import type { Route, RouteRef } from "../domain/model";
import { TRIM_METERS } from "../domain/privacy";
import { trimTrace, type TrimmedTrace } from "../domain/trim";
import type { ToolCaller } from "../service/contract";
import { loadRouteTrace, LoadError } from "../service/loader";
import type { RiderData } from "./data";
import { clear, el } from "./dom";
import { errorText } from "./errors";
import { createLeafletSurface, type MapSurface, type SurfaceFactory } from "./leafletSurface";

export interface MapView {
  readonly element: HTMLElement;
  /** Shows one route. Its trace is requested now, never before. */
  open(route: Route): void;
  /** Tells the view its tab has just become visible. */
  shown(): void;
}

export type MapFactory = (data: RiderData, caller: ToolCaller) => MapView;

export function createMapView(data: RiderData, caller: ToolCaller, createSurface: SurfaceFactory = createLeafletSurface): MapView {
  const traces = new Map<RouteRef, TrimmedTrace>();
  let surface: MapSurface | null = null;
  let current: Route | null = null;
  /** Each request gets a number; an answer that is no longer the latest is dropped. */
  let request = 0;

  const heading = el("h3", {}, "Mapa");
  const facts = el("p", { class: "lead" }, "Elige una ruta en la pestaña Rutas para verla aquí.");
  const status = el("div", { class: "map-status" });
  const canvas = el("div", { class: "map-canvas", attrs: { role: "region", "aria-label": "Mapa de la ruta elegida" } });
  canvas.hidden = true;
  const previous = el("button", { class: "button", attrs: { type: "button" } }, "← Ruta anterior");
  const next = el("button", { class: "button", attrs: { type: "button" } }, "Ruta siguiente →");
  const stepper = el("div", { class: "toolbar" }, previous, next);
  stepper.hidden = true;

  function say(text: string, role: "status" | "alert" = "status"): void {
    clear(status);
    status.append(el("p", { class: "notice", attrs: { role } }, text));
  }

  function draw(route: Route, trace: TrimmedTrace): void {
    if (trace.empty !== null) {
      surface?.clear();
      canvas.hidden = true;
      say(
        trace.empty === "hidden"
          ? `Traza oculta por privacidad: no se dibujan los primeros ni los últimos ${TRIM_METERS} m de cada ruta, y de esta no queda nada entre medias.`
          : "El servicio no ha enviado el recorrido de esta ruta.",
      );
      return;
    }
    clear(status);
    canvas.hidden = false;
    // The map is created the first time there is something to draw.
    surface ??= createSurface(canvas);
    surface.show(trace.lines);
    const inferred = trace.lines.some((line) => line.inferred === true);
    status.append(
      el(
        "p",
        { class: "sr-only", attrs: { role: "status" } },
        `Recorrido dibujado en el mapa${inferred ? ", con tramos marcados como inferidos" : ""}. Ruta de ${formatKm(route.distanceKm)}.`,
      ),
    );
  }

  function open(route: Route): void {
    request += 1;
    const mine = request;
    current = route;
    const index = data.routes.indexOf(route);
    heading.textContent = `Ruta del ${formatDateLong(route.startMs)}`;
    facts.textContent = `Salida a las ${formatTime(route.startMs)} · ${formatKm(route.distanceKm)} · ${formatDuration(route.durationS)}`;
    stepper.hidden = index < 0;
    previous.disabled = index <= 0;
    next.disabled = index < 0 || index >= data.routes.length - 1;

    const known = traces.get(route.ref);
    if (known !== undefined) {
      draw(route, known);
      return;
    }
    surface?.clear();
    say("Cargando el recorrido…");
    loadRouteTrace(caller, route.ref).then(
      (untrimmed) => {
        // Only the trimmed lines are kept; the untrimmed trace is dropped here.
        const trimmed = trimTrace(untrimmed);
        traces.set(route.ref, trimmed);
        if (mine === request) draw(route, trimmed);
      },
      (error: unknown) => {
        if (mine !== request) return;
        const text = errorText(error instanceof LoadError ? error : new LoadError("detail", "unknown", null));
        canvas.hidden = true;
        clear(status);
        status.append(
          el(
            "div",
            { class: "error", attrs: { role: "alert" } },
            el("p", {}, el("strong", {}, text.title), ` ${text.explanation}`),
            el("p", {}, "Código: ", el("code", {}, text.code)),
            el("button", { class: "button", attrs: { type: "button" }, on: { click: () => open(route) } }, "Reintentar"),
          ),
        );
      },
    );
  }

  const step = (offset: number): void => {
    if (current === null) return;
    const target = data.routes[data.routes.indexOf(current) + offset];
    if (target !== undefined) open(target);
  };
  previous.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));

  const legend = el(
    "ul",
    { class: "map-legend" },
    el("li", {}, el("span", { class: "legend-line", attrs: { "aria-hidden": "true" } }), "Trazo continuo: tramo detectado."),
    el(
      "li",
      {},
      el("span", { class: "legend-line legend-inferred", attrs: { "aria-hidden": "true" } }),
      "Trazo discontinuo: tramo que el servicio marca como inferido. Es una etiqueta descriptiva, no una garantía de precisión.",
    ),
    el("li", {}, `No se dibujan los primeros ni los últimos ${TRIM_METERS} m de cada ruta, ni marcadores de inicio o de fin.`),
  );

  return {
    element: el("div", { class: "stack map-view" }, el("div", {}, heading, facts), stepper, status, canvas, legend),
    open,
    shown() {
      surface?.resize();
    },
  };
}
