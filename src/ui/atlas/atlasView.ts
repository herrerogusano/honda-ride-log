/**
 * Section «Atlas» (docs/PLAN.md, section 15): up to eight trimmed traces of
 * the period stacked in layers by date, oldest at the bottom, on a slanted
 * plate drawn with Canvas 2D and a hand-written projection.
 *
 * Data: nothing is asked on page load. The rider presses «Reconstruir en 3D»;
 * then at most ATLAS_MAX route details are read, one after another, through
 * the store the map uses (a route the map has opened costs nothing, and a
 * route read here opens at once in the map). A series stops before its next
 * request when it is cancelled, replaced (period or set change) or the view
 * goes. A failed read stops it and keeps what arrived.
 *
 * Motion: frames run only while something moves (a layer rising, a trace
 * drawing, the intro, inertia, the parallax settling, a replay), never off
 * screen or in a hidden tab. With reduced motion, or without
 * IntersectionObserver, every change is painted at once in its final state.
 */
import { formatDate, formatDuration, formatKm, formatNumber, formatSpeed } from "../../domain/format";
import type { Route } from "../../domain/model";
import { TRIM_METERS } from "../../domain/privacy";
import { inPeriod, type Period } from "../../domain/stats";
import type { TrimmedTrace } from "../../domain/trim";
import { LoadError } from "../../service/loader";
import type { RiderData } from "../data";
import { clear, el, uniqueId } from "../dom";
import { errorText } from "../errors";
import { canAnimate, durationToken, scanLine } from "../motion";
import { drawDuration, easeInOut, partialTrace, planTrace, type TracePlan } from "../traceDraw";
import type { TraceStore } from "../traceStore";
import { camera, farToNear, fitPlane, gridStepKm, layerZ, linesToPlane, toPlane, wrapAngle, type Plane } from "./geometry";
import { paintScene, pickLayer, type LayerScene, type Scene } from "./render";

/** The most route details one atlas reads. */
export const ATLAS_MAX = 8;

export type AtlasSet = "longest" | "latest";

/** The routes of the period the atlas would draw: the eight longest or the eight latest, oldest first. */
export function chooseRoutes(routes: readonly Route[], period: Period, set: AtlasSet): Route[] {
  const pool = [...inPeriod(routes, period)];
  pool.sort(set === "longest" ? (a, b) => b.distanceKm - a.distanceKm || b.startMs - a.startMs : (a, b) => b.startMs - a.startMs);
  return pool.slice(0, ATLAS_MAX).sort((a, b) => a.startMs - b.startMs);
}

const DEG = Math.PI / 180;
export const DEFAULT_YAW = -28 * DEG;
export const DEFAULT_TILT = 54 * DEG;
const MIN_TILT = 25 * DEG;
const MAX_TILT = 85 * DEG;
export const DEFAULT_SPACING = 0.15;
const MIN_SPACING = 0.04;
const MAX_SPACING = 0.22;
/** How tight the stack stays while it is being built; the intro opens it to 1. */
const BUILD_EXPLODE = 0.5;
/** How far a selected layer lifts above its place. */
const LIFT = 0.16;
/** Yaw the intro starts from, before turning to the default. */
const INTRO_TURN = -60 * DEG;
/** Keyboard step for ← and →. */
const KEY_TURN = 10 * DEG;
const MAX_RATIO = 2;

export interface AtlasOptions {
  /** The trimmed traces of the page, shared with the map. */
  readonly traces: TraceStore;
  /** Offered when a read fails because the session is over; null in the demo. */
  readonly signIn: (() => void) | null;
  /** Opens a route in the map of «Rutas» and brings it into view. */
  readonly showOnMap: (route: Route) => void;
  /** The canvas's 2D context; tests pass a recording one. Null means the browser cannot draw it. */
  readonly context?: ((canvas: HTMLCanvasElement) => CanvasRenderingContext2D | null) | undefined;
}

export interface AtlasView {
  readonly element: HTMLElement;
  /** The period chosen in the bar: a different one abandons a series and offers to build again. */
  setPeriod(period: Period): void;
  /** Stops everything: no more reads, frames, observers or listeners. */
  destroy(): void;
}

interface Layer {
  readonly route: Route;
  readonly plan: TracePlan;
  /** Current height, eased towards its place. */
  z: number;
  /** Frame time when it started to rise and draw; null until the first frame that sees it. */
  began: number | null;
  /** Fraction of the trace drawn by its own build-up (1 when done). */
  drawn: number;
  opacity: number;
}

type Phase = "idle" | "loading" | "built" | "error" | "empty";

const plural = (count: number, one: string, many: string): string => `${formatNumber(count)} ${count === 1 ? one : many}`;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const routeLabel = (route: Route): string => `${formatDate(route.startMs)} · ${formatKm(route.distanceKm)}`;

export function createAtlasView(data: RiderData, initialPeriod: Period, options: AtlasOptions): AtlasView {
  const { traces } = options;
  let period = initialPeriod;
  let set: AtlasSet = "longest";
  let chosen = chooseRoutes(data.routes, period, set);
  let phase: Phase = "idle";
  /** Each series gets a number; one that is no longer the latest asks for nothing more. */
  let series = 0;
  let destroyed = false;
  let built = false;
  let layers: Layer[] = [];
  let hidden = 0;
  let noLine = 0;
  let selected = -1;

  // ---- structure ----
  const canvas = el("canvas", { class: "atlas-canvas", attrs: { role: "img", tabindex: 0, "aria-label": "Atlas sin trazas todavía" } });
  const context = (options.context ?? ((one: HTMLCanvasElement) => one.getContext("2d")))(canvas);
  const scan = scanLine("atlas-scan");
  const overlay = el("div", { class: "atlas-overlay" });
  const count = el("p", { class: "atlas-count", attrs: { "aria-hidden": "true" } });
  const stage = el("div", { class: "atlas-stage", attrs: { "data-state": "idle" } }, canvas, scan, count, overlay);
  const plate = el(
    "div",
    { class: "plate atlas-plate" },
    el(
      "div",
      { class: "atlas-plate-head", attrs: { "aria-hidden": "true" } },
      el("span", { class: "atlas-plate-title" }),
      el("span", {}, "Capas = orden cronológico"),
    ),
    stage,
  );
  const plateTitle = plate.querySelector(".atlas-plate-title") as HTMLElement;

  const announce = el("p", { class: "sr-only", attrs: { role: "status", "aria-live": "polite" } });
  const readout = el("div", { class: "atlas-readout" });
  const cost = el("p", { class: "atlas-cost" });
  const setGroupId = uniqueId("atlas-set");
  const setButtons = (["longest", "latest"] as const).map((one) =>
    el("button", { class: "button atlas-set-opt", attrs: { type: "button", "data-set": one, "aria-pressed": String(one === set) } }, one === "longest" ? "Las 8 más largas" : "Las 8 últimas"),
  );
  const setGroup = el(
    "div",
    { class: "atlas-set", attrs: { role: "group", "aria-labelledby": setGroupId } },
    el("span", { id: setGroupId, class: "atlas-label" }, "Qué rutas"),
    el("div", { class: "atlas-set-opts" }, ...setButtons),
  );
  const buildButton = el("button", { class: "button button-primary atlas-build", attrs: { type: "button" } }, "Reconstruir en 3D");
  const cancelButton = el("button", { class: "button atlas-cancel", attrs: { type: "button" } }, "Cancelar");
  cancelButton.hidden = true;

  const field = (labelText: string, control: HTMLElement): HTMLElement => {
    const id = uniqueId("atlas");
    control.id = id;
    return el("div", { class: "field atlas-field" }, el("label", { attrs: { for: id } }, labelText), control);
  };
  const range = (min: number, max: number, value: number, step = 1): HTMLInputElement =>
    el("input", { attrs: { type: "range", min, max, step, value } });
  const layerSelect = el("select", { class: "atlas-select" });
  const yawInput = range(-180, 180, Math.round(DEFAULT_YAW / DEG));
  const tiltInput = range(MIN_TILT / DEG, MAX_TILT / DEG, Math.round(DEFAULT_TILT / DEG));
  const spacingInput = range(MIN_SPACING * 100, MAX_SPACING * 100, DEFAULT_SPACING * 100);
  const progressInput = range(0, 1000, 1000);
  const playButton = el("button", { class: "button atlas-play", attrs: { type: "button", "aria-pressed": "false" } }, "Trazar");
  const resetButton = el("button", { class: "button atlas-reset", attrs: { type: "button" } }, "Restablecer");
  const mapButton = el("button", { class: "button atlas-tomap", attrs: { type: "button" } }, "Ver en el mapa");
  const controls = el(
    "div",
    { class: "atlas-controls" },
    field("Traza", layerSelect),
    el("div", { class: "atlas-actions" }, playButton, resetButton, mapButton),
    el("div", { class: "atlas-ranges" }, field("Giro", yawInput), field("Inclinación", tiltInput), field("Separación", spacingInput), field("Progreso", progressInput)),
  );
  controls.hidden = true;

  const tableBody = el("tbody");
  const tableCaption = el("caption", { class: "sr-only" });
  const table = el(
    "details",
    { class: "chart-data atlas-table" },
    el("summary", {}, "Ver las trazas en tabla"),
    el(
      "div",
      { class: "table-scroll" },
      el(
        "table",
        { class: "data-table" },
        tableCaption,
        el(
          "thead",
          {},
          el("tr", {}, ...["Capa", "Fecha", "Distancia", "Duración", "Vel. media", "Vel. máxima"].map((name) => el("th", { attrs: { scope: "col" } }, name))),
        ),
        tableBody,
      ),
    ),
  );
  table.hidden = true;
  const fallbackList = el("ul", { class: "atlas-fallback-list" });
  const note = el(
    "p",
    { class: "atlas-note" },
    `Proyección esquemática, sin mapa base. La altura separa las trazas por fecha (abajo la más antigua) y no es altitud. Solo se dibujan las trazas recortadas: nada a menos de ${TRIM_METERS} m de donde empieza o acaba cada ruta, sin marcas de inicio ni de fin. Cada traza es una lectura al servicio, como al abrirla en el mapa.`,
  );

  const panel = el("div", { class: "atlas-panel" }, readout, setGroup, el("div", { class: "atlas-go" }, buildButton, cancelButton), cost, controls, announce);
  const element = el("div", { class: "atlas rv" }, plate, panel, el("div", { class: "atlas-foot" }, table, note));

  // ---- camera and motion state ----
  const animate = canAnimate();
  const fine = typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  let yaw = DEFAULT_YAW;
  let tilt = DEFAULT_TILT;
  let spacing = DEFAULT_SPACING;
  let explode = 1;
  let velocity = 0;
  let parallaxYaw = 0;
  let parallaxTilt = 0;
  let parallaxYawTarget = 0;
  let parallaxTiltTarget = 0;
  let lift = 0;
  /** Replay of the selected trace, or of all: the fraction shown, and the replay under way. */
  let progress = 1;
  let replay: { began: number | null; duration: number; from: number } | null = null;
  let intro: { began: number | null; duration: number; fromYaw: number; fromExplode: number } | null = null;
  let plane: Plane | null = null;
  let width = 0;
  let height = 0;
  let ratio = 1;
  let frame = 0;
  let lastTime: number | null = null;
  let onScreen = !animate;
  let lastScene: Scene | null = null;
  const hero = durationToken("--dur-hero", 800);
  const reveal = durationToken("--dur-reveal", 520);

  // ---- painting ----
  function sceneNow(): Scene {
    const view = camera({ yaw: yaw + parallaxYaw, tilt: clamp(tilt + parallaxTilt, MIN_TILT, MAX_TILT), width, height });
    const n = layers.length;
    const gap = spacing * explode;
    const stack = Math.max(n - 1, 0) * gap;
    const groundZ = -stack / 2 - 0.16;
    const topZ = groundZ + Math.max(0.55, stack + 0.26);
    const single = selected >= 0;
    const scenes: LayerScene[] = layers.map((layer, index) => {
      const shown = single ? (index === selected ? progress : 1) : progress;
      const fraction = Math.min(layer.drawn, shown);
      const partial = partialTrace(layer.plan, fraction);
      const own = plane as Plane;
      return {
        lines: linesToPlane(own, partial.lines),
        full: linesToPlane(own, layer.plan.lines),
        head: partial.head === null ? null : toPlane(own, partial.head),
        z: layer.z,
        age: n > 1 ? index / (n - 1) : 1,
        opacity: layer.opacity,
        selected: index === selected,
        dimmed: single && index !== selected,
      };
    });
    return {
      width,
      height,
      view,
      layers: scenes,
      groundZ,
      topZ,
      halfKm: plane?.halfKm ?? 10,
      order: farToNear(scenes.map((one) => one.z), view),
    };
  }

  function paint(): void {
    if (context === null || width === 0 || height === 0) return;
    lastScene = sceneNow();
    paintScene(context, lastScene, ratio);
  }

  const active = (): boolean => onScreen && !document.hidden;

  /** Where each layer belongs now. */
  function targetZ(index: number): number {
    return layerZ(index, layers.length, spacing * explode) + (index === selected ? lift : 0);
  }

  /** Moves everything one frame on; true while something still moves. */
  function advance(now: number, dt: number): boolean {
    let moving = false;
    if (intro !== null) {
      intro.began ??= now;
      const t = clamp((now - intro.began) / intro.duration, 0, 1);
      const eased = easeInOut(t);
      yaw = intro.fromYaw + (DEFAULT_YAW - intro.fromYaw) * eased;
      explode = intro.fromExplode + (1 - intro.fromExplode) * eased;
      if (t >= 1) intro = null;
      else moving = true;
      syncInputs();
    }
    for (const layer of layers) {
      layer.began ??= now;
      const elapsed = now - layer.began;
      const drawFor = drawDuration(layer.plan, hero);
      layer.opacity = clamp(elapsed / reveal, 0, 1);
      layer.drawn = elapsed >= drawFor ? 1 : easeInOut(clamp(elapsed / drawFor, 0, 1));
      if (layer.drawn < 1 || layer.opacity < 1) moving = true;
    }
    const k = 1 - Math.exp(-dt / 140);
    layers.forEach((layer, index) => {
      const target = targetZ(index);
      if (Math.abs(target - layer.z) > 1e-4) {
        layer.z += (target - layer.z) * k;
        moving = true;
      } else layer.z = target;
    });
    if (replay !== null) {
      replay.began ??= now;
      progress = clamp(replay.from + (now - replay.began) / replay.duration, 0, 1);
      progressInput.value = String(Math.round(progress * 1000));
      if (progress >= 1) stopReplay();
      else moving = true;
    }
    if (!dragging && Math.abs(velocity) > 2e-5) {
      yaw = wrapAngle(yaw + velocity * dt);
      velocity *= 0.9 ** (dt / 16);
      syncInputs();
      moving = true;
    } else if (!dragging) velocity = 0;
    const settle = 1 - Math.exp(-dt / 130);
    if (Math.abs(parallaxYaw - parallaxYawTarget) > 1e-4 || Math.abs(parallaxTilt - parallaxTiltTarget) > 1e-4) {
      parallaxYaw += (parallaxYawTarget - parallaxYaw) * settle;
      parallaxTilt += (parallaxTiltTarget - parallaxTilt) * settle;
      moving = true;
    }
    return moving;
  }

  /** Puts everything in its final state at once (reduced motion, no observer). */
  function settleAll(): void {
    intro = null;
    replay = null;
    velocity = 0;
    explode = 1;
    if (selected < 0 || progress >= 1) progress = 1;
    parallaxYaw = parallaxTilt = parallaxYawTarget = parallaxTiltTarget = 0;
    layers.forEach((layer, index) => {
      layer.began = 0;
      layer.drawn = 1;
      layer.opacity = 1;
      layer.z = targetZ(index);
    });
  }

  function step(now: number): void {
    frame = 0;
    if (destroyed || !active()) {
      lastTime = null;
      return;
    }
    const dt = lastTime === null ? 16 : Math.min(50, now - lastTime);
    lastTime = now;
    const moving = advance(now, dt);
    paint();
    if (moving) frame = requestAnimationFrame(step);
    else lastTime = null;
  }

  /** Something changed: paint now (no motion) or ask for frames until it settles. */
  function redraw(): void {
    if (destroyed || context === null) return;
    if (!animate) {
      settleAll();
      paint();
      return;
    }
    if (frame === 0 && active()) frame = requestAnimationFrame(step);
  }

  // ---- size ----
  function measure(): void {
    const box = stage.getBoundingClientRect();
    width = Math.round(box.width) || 640;
    height = Math.round(box.height) || 512;
    ratio = Math.min(window.devicePixelRatio || 1, MAX_RATIO);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    if (!animate) paint();
    else if (frame === 0) paint();
  }

  const cleanups: (() => void)[] = [];
  if (context !== null) {
    if (typeof ResizeObserver === "function") {
      const sizer = new ResizeObserver(() => measure());
      sizer.observe(stage);
      cleanups.push(() => sizer.disconnect());
    }
    measure();
    if (animate) {
      const watcher = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined) return;
        onScreen = entry.isIntersecting;
        if (onScreen) redraw();
      });
      watcher.observe(stage);
      cleanups.push(() => watcher.disconnect());
    }
    const onVisibility = (): void => {
      lastTime = null;
      if (!document.hidden) redraw();
    };
    document.addEventListener("visibilitychange", onVisibility);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));
    // Canvas text uses the page's fonts once they are there.
    void document.fonts?.ready.then(() => {
      if (!destroyed) paint();
    });
  }

  // ---- text ----
  function syncInputs(): void {
    yawInput.value = String(Math.round(wrapAngle(yaw) / DEG));
    tiltInput.value = String(Math.round(tilt / DEG));
    spacingInput.value = String(Math.round(spacing * 100));
  }

  function summary(): string {
    if (layers.length === 0) {
      return phase === "loading" ? "Atlas: reconstruyendo las trazas" : "Atlas sin trazas todavía: la rejilla vacía del suelo";
    }
    const first = layers[0] as Layer;
    const last = layers[layers.length - 1] as Layer;
    const range = layers.length === 1 ? `del ${formatDate(first.route.startMs)}` : `del ${formatDate(first.route.startMs)} (abajo) al ${formatDate(last.route.startMs)} (arriba)`;
    const grid = plane === null ? "" : ` Cuadrícula de ${gridStepKm(plane.halfKm)} km.`;
    const chosenText = selected >= 0 ? ` Elegida: ${routeLabel((layers[selected] as Layer).route)}.` : "";
    return `Atlas de ${plural(layers.length, "traza apilada", "trazas apiladas")} ${range}.${grid}${chosenText}`;
  }

  function skippedText(): string | null {
    const parts = [
      hidden > 0 ? `${plural(hidden, "traza oculta", "trazas ocultas")} por privacidad` : null,
      noLine > 0 ? `${plural(noLine, "ruta", "rutas")} sin recorrido` : null,
    ].filter((one): one is string => one !== null);
    return parts.length === 0 ? null : parts.join(" · ");
  }

  function figure(labelText: string, value: string): HTMLElement {
    return el("div", { class: "atlas-fig" }, el("dt", {}, labelText), el("dd", {}, value));
  }

  function writeReadout(): void {
    clear(readout);
    const skipped = skippedText();
    if (phase === "loading") {
      readout.append(el("p", { class: "atlas-lead" }, "Reconstruyendo, una lectura cada vez…"));
    } else if (selected >= 0) {
      const route = (layers[selected] as Layer).route;
      readout.append(
        el("p", { class: "atlas-lead" }, `Capa ${selected + 1} de ${layers.length} · ${formatDate(route.startMs)}`),
        el(
          "dl",
          { class: "atlas-figs" },
          figure("Distancia", formatKm(route.distanceKm)),
          figure("Duración", formatDuration(route.durationS)),
          figure("Vel. media", formatSpeed(route.averageSpeed)),
          figure("Vel. máxima", formatSpeed(route.maxSpeed)),
        ),
      );
    } else if (layers.length > 0) {
      const total = layers.reduce((sum, layer) => sum + layer.route.distanceKm, 0);
      const first = layers[0] as Layer;
      const last = layers[layers.length - 1] as Layer;
      readout.append(
        el("p", { class: "atlas-lead" }, `${plural(layers.length, "traza", "trazas")} · ${formatKm(total)} en total`),
        el("p", { class: "atlas-sub" }, `${formatDate(first.route.startMs)} (abajo) → ${formatDate(last.route.startMs)} (arriba)`),
      );
    } else if (phase === "empty") {
      readout.append(el("p", { class: "atlas-lead" }, "Ninguna traza que apilar"));
    } else if (chosen.length === 0) {
      readout.append(el("p", { class: "atlas-lead" }, "No hay rutas en este periodo"));
    } else {
      readout.append(
        el("p", { class: "atlas-lead" }, "Tus rutas, una sobre otra"),
        el("p", { class: "atlas-sub" }, `${plural(chosen.length, "ruta", "rutas")} del periodo, apiladas por fecha. Pulsa «Reconstruir en 3D» para leer sus trazas.`),
      );
    }
    if (skipped !== null) readout.append(el("p", { class: "atlas-skipped" }, skipped));
  }

  function writeCost(): void {
    const reads = chosen.filter((route) => !traces.has(route.ref)).length;
    if (context === null) cost.textContent = "Este navegador no puede dibujar el atlas: no se hace ninguna lectura.";
    else if (chosen.length === 0) cost.textContent = "Elige otro periodo en la barra para apilar sus rutas.";
    else if (reads === 0) cost.textContent = "Todas sus trazas ya están en memoria: no hará ninguna lectura al servicio.";
    else if (phase === "loading") cost.textContent = `Quedan hasta ${plural(reads, "lectura", "lecturas")} al servicio.`;
    else cost.textContent = `Hará hasta ${plural(reads, "lectura", "lecturas")} al servicio, una cada vez.`;
    buildButton.disabled = chosen.length === 0 || context === null || phase === "loading";
  }

  function writeTable(): void {
    clear(tableBody);
    layers.forEach((layer, index) => {
      const { route } = layer;
      tableBody.append(
        el(
          "tr",
          {},
          el("td", {}, String(index + 1)),
          el("th", { attrs: { scope: "row" } }, formatDate(route.startMs)),
          el("td", {}, formatKm(route.distanceKm)),
          el("td", {}, formatDuration(route.durationS)),
          el("td", {}, formatSpeed(route.averageSpeed)),
          el("td", {}, formatSpeed(route.maxSpeed)),
        ),
      );
    });
    tableCaption.textContent = `Trazas del atlas, de abajo (capa 1, la más antigua) arriba.${skippedText() === null ? "" : ` ${skippedText() as string}.`}`;
    table.hidden = layers.length === 0;
  }

  function writeSelect(): void {
    clear(layerSelect);
    layerSelect.append(el("option", { attrs: { value: "-1" } }, `Las ${formatNumber(layers.length)} trazas, apiladas`));
    layers.forEach((layer, index) => layerSelect.append(el("option", { attrs: { value: String(index) } }, `${index + 1} · ${routeLabel(layer.route)}`)));
    layerSelect.value = String(selected);
  }

  function writeAll(): void {
    stage.setAttribute("data-state", context === null ? "fallback" : phase);
    plateTitle.textContent = `Atlas 3D · ${plural(layers.length, "traza", "trazas")}`;
    canvas.setAttribute("aria-label", summary());
    writeReadout();
    writeCost();
    controls.hidden = layers.length === 0 || phase === "loading";
    mapButton.disabled = selected < 0;
    playButton.hidden = !animate;
    count.textContent = phase === "loading" ? `${layers.length + hidden + noLine} / ${chosen.length}` : "";
    setButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset["set"] === set)));
    cancelButton.hidden = phase !== "loading";
    buildButton.hidden = phase === "loading" || context === null;
    // Once there is a stack, building again is a quieter action.
    buildButton.classList.toggle("button-primary", layers.length === 0);
    syncInputs();
  }

  /** Without a 2D context: the routes it would stack, as a list. Nothing is read. */
  function writeFallback(): void {
    if (context !== null) return;
    clear(fallbackList);
    for (const route of chosen) fallbackList.append(el("li", {}, routeLabel(route)));
  }

  function say(text: string): void {
    announce.textContent = text;
  }

  // ---- data ----
  function reset(): void {
    series += 1;
    layers = [];
    hidden = 0;
    noLine = 0;
    selected = -1;
    plane = null;
    progress = 1;
    replay = null;
    intro = null;
    clear(overlay);
  }

  function addLayer(route: Route, trace: TrimmedTrace): void {
    if (trace.empty === "hidden") {
      hidden += 1;
      return;
    }
    if (trace.empty === "no_geometry" || trace.lines.length === 0) {
      noLine += 1;
      return;
    }
    layers.push({ route, plan: planTrace(trace.lines), z: 0, began: null, drawn: 0, opacity: 0 });
    // The plate fits the traces read so far; it refits as each one arrives.
    plane = fitPlane(layers.map((layer) => layer.plan.lines));
    // A new layer rises from the ground.
    const ground = layerZ(0, layers.length, spacing * explode) - 0.16;
    (layers[layers.length - 1] as Layer).z = ground;
  }

  function fail(error: unknown, mine: number): void {
    if (mine !== series) return;
    phase = layers.length > 0 ? "built" : "error";
    const text = errorText(error instanceof LoadError ? error : new LoadError("detail", "unknown", null));
    let action: HTMLElement | null = null;
    if (text.action === "retry") {
      action = el("button", { class: "button", attrs: { type: "button" }, on: { click: () => void build() } }, "Reintentar");
    } else if (text.action === "sign_in" && options.signIn !== null) {
      const signIn = options.signIn;
      action = el("button", { class: "button button-primary", attrs: { type: "button" }, on: { click: () => signIn() } }, "Volver a entrar");
    }
    clear(overlay);
    overlay.append(
      el(
        "div",
        { class: "error", attrs: { role: "alert" } },
        el("p", {}, el("strong", {}, text.title), ` ${text.explanation} Se conserva lo que ya había llegado.`),
        el("p", {}, "Código: ", el("code", {}, text.code)),
        action,
      ),
    );
    finishSeries(false);
  }

  /** Ends a series: the stack opens and turns into place (or stays as it is with reduced motion). */
  function finishSeries(complete: boolean): void {
    if (layers.length === 0 && phase !== "error") phase = "empty";
    else if (phase !== "error") phase = "built";
    if (layers.length > 0 && animate) intro = { began: null, duration: hero * 2, fromYaw: yaw, fromExplode: explode };
    writeAll();
    writeSelect();
    writeTable();
    const skipped = skippedText();
    if (complete) say(`Atlas listo: ${plural(layers.length, "traza", "trazas")}.${skipped === null ? "" : ` ${skipped}.`}`);
    redraw();
  }

  async function build(): Promise<void> {
    if (context === null || chosen.length === 0) return;
    reset();
    built = true;
    const mine = series;
    const wanted = (): boolean => mine === series && !destroyed;
    const routes = chosen;
    const cachedAll = routes.every((route) => traces.known(route.ref) !== undefined);
    phase = "loading";
    if (animate) {
      // The stack starts flat and turned; a cached set goes straight to the intro.
      yaw = DEFAULT_YAW + INTRO_TURN;
      explode = cachedAll ? 0 : BUILD_EXPLODE;
      velocity = 0;
    }
    writeAll();
    say(cachedAll ? "Apilando las trazas que ya estaban en memoria." : `Reconstruyendo el atlas: ${plural(routes.length, "ruta", "rutas")}.`);
    for (const route of routes) {
      // Stop before the next request when the series was replaced, cancelled or the view is gone.
      if (!wanted()) return;
      const known = traces.known(route.ref);
      let trace: TrimmedTrace;
      if (known !== undefined) trace = known;
      else {
        try {
          trace = await traces.get(route);
        } catch (error) {
          fail(error, mine);
          return;
        }
        if (!wanted()) return;
      }
      addLayer(route, trace);
      writeAll();
      redraw();
    }
    finishSeries(true);
  }

  function cancel(): void {
    if (phase !== "loading") return;
    series += 1;
    say(`Reconstrucción cancelada: ${plural(layers.length, "traza", "trazas")}.`);
    finishSeries(false);
  }

  function choose(nextPeriod: Period, nextSet: AtlasSet): void {
    if (nextPeriod === period && nextSet === set) return;
    period = nextPeriod;
    set = nextSet;
    chosen = chooseRoutes(data.routes, period, set);
    reset();
    phase = "idle";
    writeAll();
    writeSelect();
    writeTable();
    writeFallback();
    redraw();
    // After a first build, a set that costs nothing is stacked at once.
    if (built && context !== null && chosen.length > 0 && chosen.every((route) => traces.known(route.ref) !== undefined)) void build();
  }

  // ---- selection and replay ----
  function select(index: number, speak = true): void {
    const next = index >= 0 && index < layers.length ? index : -1;
    if (next === selected) return;
    selected = next;
    lift = LIFT;
    stopReplay();
    progress = 1;
    progressInput.value = "1000";
    layerSelect.value = String(selected);
    writeAll();
    if (speak) say(selected < 0 ? "Todas las trazas, apiladas." : `Capa ${selected + 1} de ${layers.length}: ${routeLabel((layers[selected] as Layer).route)}.`);
    redraw();
  }

  function stopReplay(): void {
    replay = null;
    playButton.textContent = "Trazar";
    playButton.setAttribute("aria-pressed", "false");
  }

  function play(): void {
    if (!animate) return;
    if (replay !== null) {
      stopReplay();
      return;
    }
    intro = null;
    explode = 1;
    if (progress >= 1) progress = 0;
    const plans = selected >= 0 ? [(layers[selected] as Layer).plan] : layers.map((layer) => layer.plan);
    // A whole replay lasts a little longer than the slowest build-up; it goes on from where the slider is.
    const duration = Math.max(...plans.map((one) => drawDuration(one, hero))) * 1.6;
    replay = { began: null, duration, from: progress };
    playButton.textContent = "Pausar";
    playButton.setAttribute("aria-pressed", "true");
    redraw();
  }

  function resetView(): void {
    yaw = DEFAULT_YAW;
    tilt = DEFAULT_TILT;
    spacing = DEFAULT_SPACING;
    velocity = 0;
    intro = null;
    explode = 1;
    stopReplay();
    progress = 1;
    progressInput.value = "1000";
    select(-1, false);
    syncInputs();
    redraw();
  }

  // ---- controls ----
  buildButton.addEventListener("click", () => void build());
  cancelButton.addEventListener("click", cancel);
  setButtons.forEach((button) => button.addEventListener("click", () => choose(period, button.dataset["set"] === "latest" ? "latest" : "longest")));
  layerSelect.addEventListener("change", () => select(Number(layerSelect.value)));
  yawInput.addEventListener("input", () => {
    yaw = Number(yawInput.value) * DEG;
    velocity = 0;
    intro = null;
    explode = 1;
    redraw();
  });
  tiltInput.addEventListener("input", () => {
    tilt = Number(tiltInput.value) * DEG;
    intro = null;
    explode = 1;
    redraw();
  });
  spacingInput.addEventListener("input", () => {
    spacing = Number(spacingInput.value) / 100;
    redraw();
  });
  progressInput.addEventListener("input", () => {
    stopReplay();
    intro = null;
    progress = Number(progressInput.value) / 1000;
    redraw();
  });
  playButton.addEventListener("click", play);
  resetButton.addEventListener("click", resetView);
  mapButton.addEventListener("click", () => {
    const layer = layers[selected];
    if (layer !== undefined) options.showOnMap(layer.route);
  });

  // ---- pointer and keyboard on the canvas ----
  let dragging = false;
  let pointer: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastAt = 0;
  let moved = false;

  canvas.addEventListener("pointerdown", (event) => {
    if (layers.length === 0 || (event.pointerType === "mouse" && event.button !== 0)) return;
    pointer = event.pointerId;
    canvas.setPointerCapture?.(event.pointerId);
    dragging = true;
    moved = false;
    velocity = 0;
    if (intro !== null) {
      intro = null;
      explode = 1;
    }
    startX = lastX = event.clientX;
    startY = lastY = event.clientY;
    lastAt = event.timeStamp;
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (event) => {
    if (dragging && event.pointerId === pointer) {
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      const dt = Math.max(1, event.timeStamp - lastAt);
      lastX = event.clientX;
      lastY = event.clientY;
      lastAt = event.timeStamp;
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 5) moved = true;
      yaw = wrapAngle(yaw + dx * 0.0085);
      velocity = animate ? clamp(0.7 * velocity + 0.3 * ((dx * 0.0085) / dt), -0.004, 0.004) : 0;
      // A mouse tilts too; on touch, vertical moves scroll the page (touch-action: pan-y).
      if (event.pointerType !== "touch") tilt = clamp(tilt + dy * 0.004, MIN_TILT, MAX_TILT);
      syncInputs();
      redraw();
    } else if (!dragging && event.pointerType === "mouse" && fine && animate && layers.length > 0) {
      const box = canvas.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      parallaxYawTarget = ((event.clientX - box.left) / box.width - 0.5) * 2 * 0.08;
      parallaxTiltTarget = -((event.clientY - box.top) / box.height - 0.5) * 2 * 0.025;
      redraw();
    }
  });
  const release = (event: PointerEvent, click: boolean): void => {
    if (event.pointerId !== pointer) return;
    dragging = false;
    pointer = null;
    canvas.classList.remove("dragging");
    if (Math.abs(velocity) < 4e-4) velocity = 0;
    if (click && !moved && lastScene !== null) {
      const box = canvas.getBoundingClientRect();
      const hit = pickLayer(lastScene, event.clientX - box.left, event.clientY - box.top);
      select(hit === selected ? -1 : hit);
    }
    redraw();
  };
  canvas.addEventListener("pointerup", (event) => release(event, true));
  canvas.addEventListener("pointercancel", (event) => release(event, false));
  canvas.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "mouse") return;
    parallaxYawTarget = 0;
    parallaxTiltTarget = 0;
    redraw();
  });
  canvas.addEventListener("dblclick", resetView);
  canvas.addEventListener("keydown", (event) => {
    if (layers.length === 0) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      intro = null;
      explode = 1;
      velocity = 0;
      yaw = wrapAngle(yaw + (event.key === "ArrowLeft" ? -KEY_TURN : KEY_TURN));
      syncInputs();
      redraw();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      // ↑ climbs to newer layers, ↓ goes down to older ones; from none, ↑ starts at the bottom.
      const from = selected < 0 ? (event.key === "ArrowUp" ? -1 : layers.length) : selected;
      select(clamp(from + (event.key === "ArrowUp" ? 1 : -1), 0, layers.length - 1));
    } else if (event.key === "Escape" && selected >= 0) {
      event.preventDefault();
      select(-1);
    }
  });

  // A route the map reads costs nothing here any more: the estimate follows.
  traces.onChange(() => {
    if (!destroyed) writeCost();
  });
  writeAll();
  writeSelect();
  if (context === null) {
    canvas.hidden = true;
    clear(overlay);
    overlay.append(
      el(
        "div",
        { class: "atlas-fallback" },
        el("p", { class: "atlas-fallback-title" }, "Este navegador no puede dibujar el atlas"),
        el("p", {}, "Estas son las rutas que apilaría, de la más antigua a la más reciente:"),
        fallbackList,
      ),
    );
  }
  writeFallback();
  redraw();

  return {
    element,
    setPeriod(next) {
      choose(next, set);
    },
    destroy() {
      destroyed = true;
      series += 1;
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      for (const cleanup of cleanups) cleanup();
      layers = [];
      lastScene = null;
    },
  };
}
