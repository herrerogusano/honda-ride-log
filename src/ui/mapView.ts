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
  /** Releases the map. The view must not be used afterwards. */
  destroy(): void;
}

export interface MapViewOptions {
  /** Offered when a trace fails because the session is over; null in the demo or without a service. */
  readonly signIn: (() => void) | null;
}

export type MapFactory = (data: RiderData, caller: ToolCaller, options: MapViewOptions) => MapView;

export function createMapView(
  data: RiderData,
  caller: ToolCaller,
  options: MapViewOptions = { signIn: null },
  createSurface: SurfaceFactory = createLeafletSurface,
): MapView {
  /** Trimmed traces already known, and the requests still on their way. */
  const traces = new Map<RouteRef, TrimmedTrace>();
  const pending = new Map<RouteRef, Promise<TrimmedTrace>>();
  let surface: MapSurface | null = null;
  let current: Route | null = null;
  /** Each opening gets a number; an answer that is no longer the latest is not drawn. */
  let opening = 0;
  let destroyed = false;

  const heading = el("h2", {}, "Mapa");
  const facts = el("p", { class: "lead" }, "Elige una ruta en la pestaña Rutas para verla aquí.");
  // A live region that exists from the start, so that what is written in it later is announced.
  const status = el("div", { class: "map-status", attrs: { role: "status" } });
  const canvas = el("div", { class: "map-canvas", attrs: { role: "region", "aria-label": "Mapa de la ruta elegida" } });
  canvas.hidden = true;
  const previous = el("button", { class: "button", attrs: { type: "button" } }, "← Ruta anterior");
  const next = el("button", { class: "button", attrs: { type: "button" } }, "Ruta siguiente →");
  const stepper = el("div", { class: "toolbar" }, previous, next);
  stepper.hidden = true;

  function say(text: string): void {
    clear(status);
    status.append(el("p", { class: "notice" }, text));
  }

  function fail(route: Route, error: unknown): void {
    const text = errorText(error instanceof LoadError ? error : new LoadError("detail", "unknown", null));
    surface?.clear();
    canvas.hidden = true;
    clear(status);
    // Retrying with a token the client has already forgotten would fail the same way.
    let action: HTMLElement | null = null;
    if (text.action === "retry") {
      action = el("button", { class: "button", attrs: { type: "button" }, on: { click: () => open(route) } }, "Reintentar");
    } else if (text.action === "sign_in" && options.signIn !== null) {
      const signIn = options.signIn;
      action = el("button", { class: "button button-primary", attrs: { type: "button" }, on: { click: () => signIn() } }, "Volver a entrar");
    }
    status.append(
      el(
        "div",
        { class: "error", attrs: { role: "alert" } },
        el("p", {}, el("strong", {}, text.title), ` ${text.explanation}`),
        el("p", {}, "Código: ", el("code", {}, text.code)),
        action,
      ),
    );
  }

  function draw(route: Route, trace: TrimmedTrace): void {
    if (trace.empty !== null) {
      surface?.clear();
      canvas.hidden = true;
      say(
        trace.empty === "hidden"
          ? `Traza oculta por privacidad: no se dibuja nada a menos de ${TRIM_METERS} m de donde empieza o acaba una ruta, y de esta no queda nada fuera.`
          : "El servicio no ha enviado el recorrido de esta ruta.",
      );
      return;
    }
    canvas.hidden = false;
    // The map is created the first time there is something to draw.
    surface ??= createSurface(canvas);
    surface.show(trace.lines);
    const inferred = trace.lines.some((line) => line.inferred === true);
    clear(status);
    status.append(
      el(
        "p",
        { class: "sr-only" },
        `Recorrido dibujado en el mapa${inferred ? ", con tramos marcados como inferidos" : ""}. Ruta de ${formatKm(route.distanceKm)}.`,
      ),
    );
  }

  /** The trimmed trace of a route: from memory, from a request on its way, or from a new request. */
  function traceOf(route: Route): Promise<TrimmedTrace> {
    const known = traces.get(route.ref);
    if (known !== undefined) return Promise.resolve(known);
    let request = pending.get(route.ref);
    if (request === undefined) {
      request = loadRouteTrace(caller, route.ref)
        .then((untrimmed) => {
          // Only the trimmed lines are kept; the untrimmed trace is dropped here.
          const trimmed = trimTrace(untrimmed);
          // An answer that arrives after the view is gone is not kept.
          if (!destroyed) traces.set(route.ref, trimmed);
          return trimmed;
        })
        .finally(() => pending.delete(route.ref));
      pending.set(route.ref, request);
    }
    return request;
  }

  function open(route: Route): void {
    opening += 1;
    const mine = opening;
    current = route;
    const index = data.routes.indexOf(route);
    heading.textContent = `Ruta del ${formatDateLong(route.startMs)}`;
    facts.textContent = `Salida a las ${formatTime(route.startMs)} · ${formatKm(route.distanceKm)} · ${formatDuration(route.durationS)}`;
    stepper.hidden = index < 0;
    previous.disabled = index <= 0;
    next.disabled = index < 0 || index >= data.routes.length - 1;

    const known = traces.get(route.ref);
    if (known === undefined) {
      surface?.clear();
      say("Cargando el recorrido…");
    }
    // One handler for everything that can go wrong, the drawing included:
    // the tab never stays blank without a message.
    traceOf(route)
      .then((trace) => {
        if (mine === opening) draw(route, trace);
      })
      .catch((error: unknown) => {
        if (mine === opening) fail(route, error);
      });
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
      "Trazo de puntos: tramo que el servicio marca como inferido. Es una etiqueta descriptiva, no una garantía de precisión.",
    ),
    el(
      "li",
      {},
      `No se dibuja nada a menos de ${TRIM_METERS} m de donde empieza o acaba cada ruta (eso quita, como poco, sus primeros y últimos ${TRIM_METERS} m), ni marcadores de inicio o de fin.`,
    ),
  );

  return {
    element: el("div", { class: "stack map-view" }, el("div", {}, heading, facts), stepper, status, canvas, legend),
    open,
    shown() {
      surface?.resize();
    },
    destroy() {
      // Answers still on their way must not draw on a map that is gone.
      opening += 1;
      destroyed = true;
      surface?.destroy();
      surface = null;
      // The trimmed traces leave memory with the view (sign-out, another load).
      traces.clear();
      current = null;
    },
  };
}
