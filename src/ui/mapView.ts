/**
 * The map of section «Rutas»: one map and the route chosen in the list. A route's
 * trace is requested when the route is opened, never earlier, and only its
 * trimmed lines are kept in memory, so the same route is not asked twice.
 *
 * When the route is chosen the map flies to it and the trace draws itself
 * from start to end (docs/PLAN.md, section 13), only while the map is on
 * screen and the tab is visible; with reduced motion, or without
 * IntersectionObserver, the map jumps and the trace is complete at once.
 */
import {
  formatDateLong,
  formatDuration,
  formatEndTime,
  formatInferred,
  formatKm,
  formatNumber,
  formatSpeed,
  formatTime,
} from "../domain/format";
import type { Route } from "../domain/model";
import { TRIM_METERS } from "../domain/privacy";
import type { TrimmedTrace } from "../domain/trim";
import type { ToolCaller } from "../service/contract";
import { LoadError } from "../service/loader";
import type { RiderData } from "./data";
import { clear, el } from "./dom";
import { errorText } from "./errors";
import { createLeafletSurface, type MapSurface, type SurfaceFactory } from "./leafletSurface";
import { canAnimate, countUp, durationToken, scanLine } from "./motion";
import { drawDuration, drawTrace, planTrace, type Drawing } from "./traceDraw";
import { createTraceStore, type TraceStore } from "./traceStore";

export interface MapView {
  readonly element: HTMLElement;
  /** What the dotted line means and what is never drawn; the page places it under the list. */
  readonly legend: HTMLElement;
  /** Shows one route. Its trace is requested now, never before. */
  open(route: Route): void;
  /** Tells the view its container may have changed size or just became visible: lines are framed again. */
  shown(): void;
  /** Releases the map. The view must not be used afterwards. */
  destroy(): void;
}

export interface MapViewOptions {
  /** Offered when a trace fails because the session is over; null in the demo or without a service. */
  readonly signIn: (() => void) | null;
  /** Told about every route the view opens, also with its own «anterior / siguiente» buttons. */
  readonly onOpen?: ((route: Route) => void) | undefined;
  /**
   * The trimmed traces shared with the atlas, owned by the page. Without it
   * the view keeps its own and forgets them when it is destroyed.
   */
  readonly traces?: TraceStore | undefined;
}

/** Everything the Rutas list says about one route, as one sentence (read out; the figures below show it). */
export function routeFacts(route: Route): string {
  return [
    `Salida: ${formatTime(route.startMs)}`,
    `Llegada: ${formatEndTime(route.startMs, route.endMs)}`,
    `Duración: ${formatDuration(route.durationS)}`,
    formatKm(route.distanceKm),
    `Vel. media: ${formatSpeed(route.averageSpeed)}`,
    `Vel. máxima: ${formatSpeed(route.maxSpeed)}`,
    `Tramos inferidos: ${formatInferred(route.hasInferredSegments)}`,
  ].join(" · ");
}

export type MapFactory = (data: RiderData, caller: ToolCaller, options: MapViewOptions) => MapView;

/** The stage shows one of these: nothing chosen, a trace loading, a trace drawn, nothing to draw, or a failure. */
type StageState = "idle" | "loading" | "drawn" | "empty" | "error";

export function createMapView(
  data: RiderData,
  caller: ToolCaller,
  options: MapViewOptions = { signIn: null },
  createSurface: SurfaceFactory = createLeafletSurface,
): MapView {
  /** Trimmed traces already known, and the requests still on their way (shared with the atlas when given). */
  const traces = options.traces ?? createTraceStore(caller);
  const ownTraces = options.traces === undefined;
  let surface: MapSurface | null = null;
  let current: Route | null = null;
  /** Each opening gets a number; an answer that is no longer the latest is not drawn. */
  let opening = 0;
  /** The drawing under way, a drawing waiting for the map to be seen, and the counts of the figures. */
  let drawing: Drawing | null = null;
  let waiting: (() => void) | null = null;
  let figures: AbortController | null = null;

  // Focusable by script only.
  const heading = el("h3", { class: "map-title", attrs: { tabindex: -1 } }, "Mapa");
  const facts = el("p", { class: "lead" }, "Elige una ruta de la lista para verla aquí.");
  // A live region that exists from the start, so that what is written in it later is announced.
  const status = el("div", { class: "map-status", attrs: { role: "status" } });
  const canvas = el("div", { class: "map-canvas", attrs: { role: "region", "aria-label": "Mapa de la ruta elegida" } });
  canvas.hidden = true;
  const stepLabel = (text: string): HTMLElement => el("span", { class: "step-label" }, text);
  const previous = el("button", { class: "button step", attrs: { type: "button" } }, "←", stepLabel(" Ruta anterior"));
  const next = el("button", { class: "button step", attrs: { type: "button" } }, stepLabel("Ruta siguiente "), "→");
  const stepper = el("div", { class: "map-step" }, previous, next);
  stepper.hidden = true;

  // The chosen route in large figures. Drawn for the eye: `facts` says the same to screen readers.
  const figure = (label: string): { cell: HTMLElement; value: HTMLElement; unit: HTMLElement } => {
    const value = el("span", { class: "rs-value" });
    const unit = el("span", { class: "rs-unit" });
    return { cell: el("div", { class: "rs-cell" }, el("dt", {}, label), el("dd", {}, value, unit)), value, unit };
  };
  const km = figure("Distancia");
  const time = figure("Duración");
  const average = figure("Vel. media");
  const top = figure("Vel. máxima");
  const span = el("p", { class: "rs-span" });
  const strip = el("div", { class: "route-strip", attrs: { "aria-hidden": "true" } }, span, el("dl", { class: "rs-grid" }, km.cell, time.cell, average.cell, top.cell));
  strip.hidden = true;

  const scan = scanLine("map-scan");
  const empty = el(
    "div",
    { class: "map-empty", attrs: { "aria-hidden": "true" } },
    el("p", { class: "map-empty-text" }, el("span", { class: "map-empty-mark" }), "Elige una ruta"),
  );
  const stage = el("div", { class: "map-stage", attrs: { "data-state": "idle" } }, canvas, empty, scan, status, stepper);

  const setState = (state: StageState): void => stage.setAttribute("data-state", state);

  /** Whether the stage is on screen; true when it cannot be known (no IntersectionObserver). */
  let onScreen = true;
  let observer: IntersectionObserver | null = null;
  const onVisibility = (): void => {
    if (document.hidden) drawing?.finish();
    else waiting?.();
  };
  // Watched only when the trace may draw itself; otherwise it is always complete at once.
  if (canAnimate()) {
    onScreen = false;
    observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      onScreen = entry.isIntersecting;
      // Leaving the screen mid-draw completes the trace; coming back starts a waiting one.
      if (onScreen) waiting?.();
      else drawing?.finish();
    });
    observer.observe(stage);
  }
  document.addEventListener("visibilitychange", onVisibility);

  /** Stops what moves on the map: the drawing (as it is), the wait for the map to be seen and a flight. */
  function stopMotion(): void {
    drawing?.cancel();
    drawing = null;
    waiting = null;
  }

  function say(text: string): void {
    clear(status);
    status.append(el("p", { class: "notice" }, text));
  }

  function fail(route: Route, error: unknown): void {
    const text = errorText(error instanceof LoadError ? error : new LoadError("detail", "unknown", null));
    stopMotion();
    surface?.clear();
    canvas.hidden = true;
    setState("error");
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

  /** Draws the trimmed lines: animated when motion is allowed, complete at once otherwise. */
  function animate(target: MapSurface, trace: TrimmedTrace, mine: number): void {
    const lines = trace.lines;
    if (!canAnimate()) {
      target.show(lines);
      return;
    }
    const hero = durationToken("--dur-hero", 800);
    const plan = planTrace(lines);
    const start = (fly: boolean): void => {
      waiting = null;
      target.clear();
      target.frame(lines, fly ? hero : null, () => {
        if (mine !== opening) return;
        // The map left the screen (or the tab was hidden) during the flight: nothing draws unseen.
        if (!onScreen || document.hidden) {
          target.show(lines);
          return;
        }
        drawing = drawTrace(plan, {
          durationMs: drawDuration(plan, hero),
          paint: (partial) => target.paint(partial.lines, partial.head),
          done: () => {
            drawing = null;
          },
        });
      });
    };
    if (onScreen && !document.hidden) {
      start(true);
      return;
    }
    // Not seen now: the map waits, empty and framed, and draws when it is seen.
    target.clear();
    target.frame(lines, null, () => undefined);
    waiting = () => {
      if (mine === opening && onScreen && !document.hidden) start(false);
    };
  }

  function draw(route: Route, trace: TrimmedTrace, mine: number): void {
    if (trace.empty !== null) {
      surface?.clear();
      canvas.hidden = true;
      setState("empty");
      clear(status);
      status.append(
        trace.empty === "hidden"
          ? el(
              "div",
              { class: "notice map-note map-note-hidden" },
              el("strong", { class: "map-note-title" }, "Traza oculta por privacidad"),
              el("span", { class: "sr-only" }, ": "),
              el(
                "span",
                {},
                `No se dibuja nada a menos de ${TRIM_METERS} m de donde empieza o acaba una ruta, y de esta no queda nada fuera.`,
              ),
            )
          : el(
              "div",
              { class: "notice map-note map-note-none" },
              el("strong", { class: "map-note-title" }, "Sin recorrido"),
              el("span", { class: "sr-only" }, ". "),
              el("span", {}, "El servicio no ha enviado el recorrido de esta ruta."),
            ),
      );
      return;
    }
    canvas.hidden = false;
    setState("drawn");
    // The map is created the first time there is something to draw.
    surface ??= createSurface(canvas);
    animate(surface, trace, mine);
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

  /** The large figures of the chosen route; they count up when they change on screen. */
  function showFigures(route: Route): void {
    figures?.abort();
    const motion = new AbortController();
    figures = motion;
    const short = { signal: motion.signal, durationMs: durationToken("--dur-reveal", 520) };
    strip.hidden = false;
    span.replaceChildren(
      el("span", { class: "rs-date" }, formatDateLong(route.startMs)),
      el("span", { class: "rs-times" }, `${formatTime(route.startMs)} → ${formatEndTime(route.startMs, route.endMs)}`),
      el(
        "span",
        { class: route.hasInferredSegments === true ? "rs-inferred on" : "rs-inferred" },
        `Tramos inferidos: ${formatInferred(route.hasInferredSegments)}`,
      ),
    );
    countUp(km.value, route.distanceKm, (value) => formatNumber(value, 1), short);
    km.unit.textContent = "km";
    for (const [cell, speed] of [
      [average, route.averageSpeed],
      [top, route.maxSpeed],
    ] as const) {
      if (speed === null) {
        cell.value.replaceChildren("—");
        cell.unit.textContent = "";
      } else {
        countUp(cell.value, speed, (value) => formatNumber(value), short);
        cell.unit.textContent = "km/h";
      }
    }
    // A duration is two numbers and two units: written as it is, without counting.
    time.value.textContent = formatDuration(route.durationS);
    time.unit.textContent = "";
  }

  function open(route: Route): void {
    opening += 1;
    const mine = opening;
    stopMotion();
    current = route;
    const index = data.routes.indexOf(route);
    heading.textContent = `Ruta del ${formatDateLong(route.startMs)}`;
    facts.textContent = routeFacts(route);
    facts.classList.add("sr-only");
    stepper.hidden = index < 0;
    previous.disabled = index <= 0;
    next.disabled = index < 0 || index >= data.routes.length - 1;
    showFigures(route);
    // The title and the figures fade in again for the new route (nothing moves with reduced motion: see the stylesheet).
    for (const part of [heading, strip]) {
      part.classList.remove("swap");
      void part.offsetWidth;
      part.classList.add("swap");
    }
    options.onOpen?.(route);

    if (traces.known(route.ref) === undefined) {
      surface?.clear();
      setState("loading");
      say("Cargando el recorrido…");
    }
    // One handler for everything that can go wrong, the drawing included:
    // the map never stays blank without a message.
    traces
      .get(route)
      .then((trace) => {
        if (mine === opening) draw(route, trace, mine);
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
    el(
      "li",
      {},
      "Los km y las velocidades media y máxima son los que entrega el servicio; el propio servicio avisa de que sus unidades están sin confirmar.",
    ),
  );

  return {
    element: el(
      "div",
      { class: "map-view" },
      el("div", { class: "map-head" }, el("div", { class: "map-head-text" }, heading, facts)),
      stage,
      strip,
    ),
    legend,
    open,
    shown() {
      surface?.resize();
    },
    destroy() {
      // Answers still on their way must not draw on a map that is gone.
      opening += 1;
      stopMotion();
      figures?.abort();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      surface?.destroy();
      surface = null;
      // The trimmed traces leave memory with the view (sign-out, another load); a shared store goes with the page.
      if (ownTraces) traces.dispose();
      current = null;
    },
  };
}
