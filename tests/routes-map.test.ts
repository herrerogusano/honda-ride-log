// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import { createDemoCaller } from "../src/demo/scenarios";
import type { LatLng, Route, TraceLine } from "../src/domain/model";
import { trimTrace } from "../src/domain/trim";
import type { ToolCaller, ToolName } from "../src/service/contract";
import { loadAllRoutes, loadRouteTrace, loadVehicleState } from "../src/service/loader";
import { startApp, type App } from "../src/ui/app";
import { buildRiderData, type RiderData } from "../src/ui/data";
import type { MapSurface } from "../src/ui/leafletSurface";
import { createMapView, type MapView } from "../src/ui/mapView";
import { partialTrace, planTrace } from "../src/ui/traceDraw";

/**
 * «04 Rutas» with the list and the map together, and the trace that draws
 * itself (docs/PLAN.md, section 13). jsdom, with a hand-driven
 * IntersectionObserver and frame queue and a map surface that records
 * instead of drawing: this proves the contract as we read it, not what
 * Leaflet or a browser shows (for that, the browser checks in section 13).
 */

class FakeObserver {
  static all: FakeObserver[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.disconnected = true;
    this.targets.clear();
  }
}

/** Tells every live observer that each element it watches is (or is not) on screen. */
function screen(isIntersecting: boolean): void {
  for (const observer of [...FakeObserver.all]) {
    if (observer.disconnected || observer.targets.size === 0) continue;
    observer.callback(
      [...observer.targets].map((target) => ({ target, isIntersecting }) as unknown as IntersectionObserverEntry),
      observer as unknown as IntersectionObserver,
    );
  }
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
let clock = 0;
/** Runs the frames waiting now, `step` ms after the previous run. */
function tick(step = 16): void {
  clock += step;
  const waiting = [...frames.values()];
  frames.clear();
  for (const callback of waiting) callback(clock);
}
let reduced = false;
let tabHidden = false;

const NOW = Date.parse("2026-11-09T20:00:00.000Z");
const rider = generateRider({ seed: 8, nowMs: NOW });

interface Recorder {
  readonly surface: MapSurface;
  readonly shows: (readonly TraceLine[])[];
  readonly flights: { readonly lines: readonly TraceLine[]; readonly flyMs: number | null }[];
  readonly paints: { readonly lines: readonly TraceLine[]; readonly head: LatLng | null }[];
  /** Ends the flights under way, as Leaflet's `moveend` does. */
  land(): void;
  clears: number;
}

function recorder(): Recorder {
  let landing: (() => void)[] = [];
  const record: Recorder = {
    shows: [],
    flights: [],
    paints: [],
    clears: 0,
    land() {
      const now = landing;
      landing = [];
      for (const settled of now) settled();
    },
    surface: {
      show: (lines) => void record.shows.push(lines),
      frame(lines, flyMs, settled) {
        record.flights.push({ lines, flyMs });
        // A jump is in place at once; a flight lands when the test says so.
        if (flyMs === null) settled();
        else landing.push(settled);
      },
      paint: (lines, head) => void record.paints.push({ lines, head }),
      clear() {
        record.clears += 1;
        landing = [];
      },
      resize: () => undefined,
      destroy: () => undefined,
    },
  };
  return record;
}

interface Harness {
  readonly view: MapView;
  readonly data: RiderData;
  readonly calls: ToolName[];
  readonly rec: Recorder;
  /** The trimmed lines of a route, computed here the way the view must compute them. */
  trimmed(route: Route): Promise<readonly TraceLine[]>;
}

async function harness(): Promise<Harness> {
  const service = createDemoService(rider);
  const calls: ToolName[] = [];
  const caller: ToolCaller = {
    callTool(name, args) {
      calls.push(name);
      return service.callTool(name, args);
    },
  };
  const data = buildRiderData(await loadVehicleState(service), null, await loadAllRoutes(service, NOW), true, NOW);
  const rec = recorder();
  const view = createMapView(data, caller, { signIn: null }, () => rec.surface);
  document.body.replaceChildren(view.element, view.legend);
  return { view, data, calls, rec, trimmed: async (route) => trimTrace(await loadRouteTrace(service, route.ref)).lines };
}

const longest = (routes: readonly Route[]): Route => routes.reduce((a, b) => (b.distanceKm > a.distanceKm ? b : a));
const stage = (): HTMLElement => document.querySelector(".map-stage") as HTMLElement;

// ---- geometry, independent of src/ui/traceDraw.ts ----
const R = 6_378_137;
const mercator = ([lat, lon]: LatLng): [number, number] => [(R * lon * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
function drawnLength(lines: readonly TraceLine[]): number {
  let total = 0;
  for (const line of lines) {
    for (let i = 1; i < line.points.length; i += 1) {
      const a = mercator(line.points[i - 1] as LatLng);
      const b = mercator(line.points[i] as LatLng);
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  }
  return total;
}
/** Distance in projected metres from `point` to the nearest segment of `lines`. */
function offTrace(point: LatLng, lines: readonly TraceLine[]): number {
  const p = mercator(point);
  let best = Infinity;
  for (const line of lines) {
    if (line.points.length === 1) best = Math.min(best, Math.hypot(...(mercator(line.points[0] as LatLng).map((v, k) => v - (p[k] as number)) as [number, number])));
    for (let i = 1; i < line.points.length; i += 1) {
      const a = mercator(line.points[i - 1] as LatLng);
      const b = mercator(line.points[i] as LatLng);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
    }
  }
  return best;
}

beforeEach(() => {
  FakeObserver.all = [];
  frames = new Map();
  clock = 0;
  reduced = false;
  tabHidden = false;
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void frames.delete(id));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query }));
  vi.stubGlobal("scrollTo", () => undefined);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => tabHidden });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("the drawing, as geometry", () => {
  const lines: TraceLine[] = [
    { inferred: true, points: [[40, -1], [40.01, -1], [40.01, -0.99]] },
    { inferred: false, points: [[40.02, -0.99], [40.03, -0.98], [40.05, -0.98], [40.05, -0.97]] },
  ];

  it("grows monotonically, keeps each line's kind, ends on exactly the same lines and never leaves them", () => {
    const plan = planTrace(lines);
    let before = -1;
    for (let k = 0; k <= 200; k += 1) {
      const partial = partialTrace(plan, k / 200);
      const length = drawnLength(partial.lines);
      expect(length).toBeGreaterThanOrEqual(before - 1e-6);
      before = length;
      partial.lines.forEach((line, index) => expect(line.inferred).toBe(lines[index]?.inferred));
      for (const line of partial.lines) for (const point of line.points) expect(offTrace(point, lines)).toBeLessThan(1e-3);
      if (partial.head !== null) expect(offTrace(partial.head, lines)).toBeLessThan(1e-3);
    }
    const done = partialTrace(plan, 1);
    expect(done.lines).toBe(lines);
    expect(done.head).toBeNull();
    // Half-way in time is half-way in length: progress follows length, not points.
    expect(drawnLength(partialTrace(plan, 0.5).lines)).toBeCloseTo(drawnLength(lines) / 2, 0);
  });
});

describe("the trace draws itself on the map", () => {
  it("flies to the route, then grows the trimmed lines frame by frame to exactly those lines, with a head that goes at the end", async () => {
    const h = await harness();
    screen(true);
    const route = longest(h.data.routes);
    const trimmed = await h.trimmed(route);
    h.view.open(route);
    await vi.waitFor(() => expect(h.rec.flights).toHaveLength(1));
    // A flight of --dur-hero (jsdom has no stylesheet: its fallback, 800 ms), with only the trimmed lines.
    expect(h.rec.flights[0]?.flyMs).toBe(800);
    expect(h.rec.flights[0]?.lines).toEqual(trimmed);
    expect(h.rec.paints).toEqual([]);
    expect(frames.size).toBe(0);
    h.rec.land();
    for (let i = 0; i < 200 && frames.size > 0; i += 1) tick();
    expect(frames.size).toBe(0);
    const paints = h.rec.paints;
    expect(paints.length).toBeGreaterThan(40);
    expect(paints[0]?.lines).toEqual([]);
    let before = -1;
    for (const paint of paints) {
      const length = drawnLength(paint.lines);
      expect(length).toBeGreaterThanOrEqual(before - 1e-6);
      before = length;
      for (const line of paint.lines) for (const point of line.points) expect(offTrace(point, trimmed)).toBeLessThan(1e-3);
      if (paint.head !== null) expect(offTrace(paint.head, trimmed)).toBeLessThan(1e-3);
    }
    expect(paints.slice(1, -1).every((paint) => paint.head !== null)).toBe(true);
    expect(paints[paints.length - 1]).toEqual({ lines: trimmed, head: null });
    // The whole drawing lasted 1.5 to 2 times --dur-hero.
    expect(clock).toBeGreaterThanOrEqual(1200);
    expect(clock).toBeLessThanOrEqual(1600 + 32);
    expect(h.rec.shows).toEqual([]);
  });

  it("stops the drawing at once when another route is chosen mid-draw, and draws only the new one", async () => {
    const h = await harness();
    screen(true);
    const [a, b] = [h.data.routes[20], h.data.routes[21]] as [Route, Route];
    h.view.open(a);
    await vi.waitFor(() => expect(h.rec.flights).toHaveLength(1));
    h.rec.land();
    tick();
    tick();
    tick(200);
    expect(frames.size).toBe(1);
    h.view.open(b);
    expect(frames.size).toBe(0);
    const painted = h.rec.paints.length;
    tick();
    expect(h.rec.paints.length).toBe(painted);
    await vi.waitFor(() => expect(h.rec.flights).toHaveLength(2));
    // A flight of the old route that lands late draws nothing.
    h.rec.land();
    for (let i = 0; i < 200 && frames.size > 0; i += 1) tick();
    expect(h.rec.paints[h.rec.paints.length - 1]).toEqual({ lines: await h.trimmed(b), head: null });
  });

  it("stops drawing and watching when the view is released", async () => {
    const h = await harness();
    screen(true);
    h.view.open(longest(h.data.routes));
    await vi.waitFor(() => expect(h.rec.flights).toHaveLength(1));
    h.rec.land();
    tick();
    tick(100);
    const painted = h.rec.paints.length;
    h.view.destroy();
    expect(frames.size).toBe(0);
    tick();
    expect(h.rec.paints.length).toBe(painted);
    expect(FakeObserver.all.every((observer) => observer.disconnected)).toBe(true);
  });

  it("with reduced motion, jumps and shows the complete trace at once: no flight, no frame, nothing watched", async () => {
    reduced = true;
    const h = await harness();
    const route = longest(h.data.routes);
    h.view.open(route);
    await vi.waitFor(() => expect(h.rec.shows).toHaveLength(1));
    expect(h.rec.shows[0]).toEqual(await h.trimmed(route));
    expect(h.rec.flights).toEqual([]);
    expect(h.rec.paints).toEqual([]);
    expect(frames.size).toBe(0);
    expect(FakeObserver.all).toHaveLength(0);
  });

  it("does not draw while the map is off screen, and draws without a flight once it comes on screen", async () => {
    const h = await harness();
    const route = longest(h.data.routes);
    h.view.open(route);
    await vi.waitFor(() => expect(h.rec.flights).toHaveLength(1));
    // Framed (a jump), nothing drawn, no frame asked for.
    expect(h.rec.flights[0]?.flyMs).toBeNull();
    expect(h.rec.paints).toEqual([]);
    expect(frames.size).toBe(0);
    screen(true);
    expect(h.rec.flights).toHaveLength(2);
    expect(h.rec.flights[1]?.flyMs).toBeNull();
    // The drawing starts (its empty first paint); the figures above may count up in the same frames.
    expect(h.rec.paints).toEqual([{ lines: [], head: null }]);
    for (let i = 0; i < 200 && frames.size > 0; i += 1) tick();
    expect(h.rec.paints[h.rec.paints.length - 1]).toEqual({ lines: await h.trimmed(route), head: null });
  });

  it("does not draw in a hidden tab, starts when the tab is shown, and completes at once when it hides mid-draw", async () => {
    const h = await harness();
    screen(true);
    tabHidden = true;
    const route = longest(h.data.routes);
    h.view.open(route);
    await vi.waitFor(() => expect(h.rec.flights).toHaveLength(1));
    expect(h.rec.flights[0]?.flyMs).toBeNull();
    expect(frames.size).toBe(0);
    tabHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(1);
    tick();
    tick(100);
    tabHidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    expect(h.rec.paints[h.rec.paints.length - 1]).toEqual({ lines: await h.trimmed(route), head: null });
  });

  it("completes the trace at once when the map leaves the screen mid-draw", async () => {
    const h = await harness();
    screen(true);
    const route = longest(h.data.routes);
    h.view.open(route);
    await vi.waitFor(() => expect(h.rec.flights).toHaveLength(1));
    h.rec.land();
    tick();
    tick(100);
    screen(false);
    expect(frames.size).toBe(0);
    expect(h.rec.paints[h.rec.paints.length - 1]).toEqual({ lines: await h.trimmed(route), head: null });
  });

  it("shows the short demo route as hidden for privacy: its message, nothing drawn, no flight", async () => {
    const h = await harness();
    screen(true);
    const short = h.data.routes.find((route) => route.distanceKm >= 0.3 && route.distanceKm <= 0.8);
    expect(short).toBeDefined();
    h.view.open(short as Route);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Traza oculta por privacidad"));
    expect(stage().getAttribute("data-state")).toBe("empty");
    expect(document.querySelector(".map-note-hidden")).not.toBeNull();
    expect(h.rec.flights).toEqual([]);
    expect(h.rec.paints).toEqual([]);
    expect(h.rec.shows).toEqual([]);
    expect(frames.size).toBe(0);
    expect((document.querySelector(".map-canvas") as HTMLElement).hidden).toBe(true);
  });

  it("shows a scan line while the trace loads and keeps a status line for screen readers", async () => {
    const h = await harness();
    h.view.open(h.data.routes[3] as Route);
    expect(stage().getAttribute("data-state")).toBe("loading");
    expect(stage().querySelector(".map-scan .scan-line")).not.toBeNull();
    expect(document.querySelector('.map-status[role="status"]')?.textContent).toBe("Cargando el recorrido…");
    await vi.waitFor(() => expect(stage().getAttribute("data-state")).toBe("drawn"));
  });

  it("writes the chosen route's figures large, with their units", async () => {
    const h = await harness();
    const route = h.data.routes.find((one) => one.durationS !== null && one.averageSpeed !== null && one.maxSpeed !== null) as Route;
    h.view.open(route);
    const strip = document.querySelector(".route-strip") as HTMLElement;
    expect(strip.hidden).toBe(false);
    const cells = [...strip.querySelectorAll(".rs-cell")].map((cell) => [cell.querySelector("dt")?.textContent, cell.querySelector(".rs-unit")?.textContent]);
    expect(cells).toEqual([
      ["Distancia", "km"],
      ["Duración", ""],
      ["Vel. media", "km/h"],
      ["Vel. máxima", "km/h"],
    ]);
    expect(strip.querySelector(".rs-times")?.textContent).toMatch(/^\d\d:\d\d → \d\d:\d\d/);
    expect(strip.querySelector(".rs-inferred")?.textContent).toMatch(/^Tramos inferidos: (Sí|No|—)$/);
  });
});

// ---- the page: list and map together ----

let root: HTMLElement;
let app: App | undefined;
let rec: Recorder;
let calls: ToolName[];

async function page(account = false): Promise<void> {
  app?.dispose();
  history.replaceState(null, "", "/");
  root = document.createElement("main");
  document.body.replaceChildren(root);
  rec = recorder();
  calls = [];
  app = startApp({
    root,
    now: () => NOW,
    demoDelayMs: 0,
    initialView: "none",
    createMap: (data, caller, options) => createMapView(data, caller, options, () => rec.surface),
    ...(account ? { account: { signIn: () => Promise.resolve(), signOut: () => undefined } } : {}),
  });
  const demo = createDemoCaller("commuter", NOW, 0);
  const counting: ToolCaller = {
    callTool(name, args) {
      calls.push(name);
      return demo.callTool(name, args);
    },
  };
  void app.load(counting, { demo: !account });
  await vi.waitFor(() => expect(root.querySelector(".routes-table tbody tr")).not.toBeNull());
  calls.length = 0;
}

const rows = (): HTMLTableRowElement[] => [...root.querySelectorAll<HTMLTableRowElement>(".routes-table tbody tr")];
const rowButton = (index: number): HTMLButtonElement => rows()[index]?.querySelector(".row-button") as HTMLButtonElement;
const chosen = (): number[] => rows().flatMap((row, index) => (row.querySelector('.row-button[aria-current="true"]') !== null ? [index] : []));
const pageButton = (label: string): HTMLButtonElement => [...root.querySelectorAll("button")].find((one) => (one.textContent ?? "").includes(label)) as HTMLButtonElement;

describe("list and map in the same place", () => {
  it("asks for each route's detail once, however often it is chosen", async () => {
    await page();
    rowButton(0).click();
    rowButton(1).click();
    rowButton(0).click();
    rowButton(1).click();
    await vi.waitFor(() => expect(root.querySelector(".map-stage")?.getAttribute("data-state")).toBe("drawn"));
    expect(calls).toEqual(["get_route_detail", "get_route_detail"]);
  });

  it("keeps the list's chosen row in step with «anterior / siguiente», scrolling the list's own box and never the page", async () => {
    await page();
    const scroller = root.querySelector(".routes-scroll") as HTMLElement;
    // A list box that scrolls (wide screens), with the row it must reveal below its bottom edge.
    scroller.style.setProperty("overflow-y", "auto");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 9000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ top: 200, bottom: 800 } as DOMRect);
    const inBox: unknown[] = [];
    scroller.scrollTo = ((options: unknown) => void inBox.push(options)) as typeof scroller.scrollTo;
    const onPage = vi.fn();
    vi.stubGlobal("scrollTo", onPage);
    rowButton(0).click();
    expect(chosen()).toEqual([0]);
    // Newest first: the route before the newest in time is the next row down.
    vi.spyOn(rows()[1] as HTMLElement, "getBoundingClientRect").mockReturnValue({ top: 900, bottom: 960 } as DOMRect);
    pageButton("Ruta anterior").click();
    expect(chosen()).toEqual([1]);
    expect(rows()[1]?.classList.contains("is-chosen")).toBe(true);
    expect(rows()[0]?.classList.contains("is-chosen")).toBe(false);
    expect(root.querySelector(".map-title")?.textContent).toContain((rows()[1]?.querySelector(".row-button")?.firstChild?.textContent ?? "").split(" ")[1] as string);
    expect(inBox).toHaveLength(1);
    expect((inBox[0] as ScrollToOptions).top).toBe(900 - 200 - 12);
    pageButton("Ruta siguiente").click();
    expect(chosen()).toEqual([0]);
    expect(onPage).not.toHaveBeenCalled();
  });

  it("on narrow screens (list in the page) brings the row up under the pinned map only for «anterior / siguiente»", async () => {
    await page();
    const onPage: ScrollToOptions[] = [];
    vi.stubGlobal("scrollTo", (options: ScrollToOptions) => void onPage.push(options));
    vi.spyOn(root.querySelector(".archive-map") as HTMLElement, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 500 } as DOMRect);
    // jsdom's window is 768 px tall: the rows sit below it.
    for (const row of rows().slice(0, 3)) vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ top: 900, bottom: 960 } as DOMRect);
    rowButton(0).click();
    expect(onPage).toEqual([]);
    pageButton("Ruta anterior").click();
    expect(chosen()).toEqual([1]);
    expect(onPage).toHaveLength(1);
    expect(onPage[0]?.top).toBe(960 - 768 + 12);
  });

  it("moves between routes with ↑ and ↓ on a row, opening each, without letting the key scroll the page", async () => {
    await page();
    rowButton(0).focus();
    rowButton(0).click();
    const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    rowButton(0).dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rowButton(1));
    expect(chosen()).toEqual([1]);
    rowButton(1).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(rowButton(0));
    expect(chosen()).toEqual([0]);
  });

  it("reaches the privacy-hidden demo route by sorting by distance", async () => {
    await page();
    const select = root.querySelector<HTMLSelectElement>(".archive-list select") as HTMLSelectElement;
    select.value = "km_asc";
    select.dispatchEvent(new Event("change"));
    const km = Number((rows()[0]?.querySelector(".c-km")?.textContent ?? "").replace(",", "."));
    expect(km).toBeGreaterThanOrEqual(0.3);
    expect(km).toBeLessThanOrEqual(0.8);
    rowButton(0).click();
    await vi.waitFor(() => expect(root.querySelector(".map-status")?.textContent).toContain("Traza oculta por privacidad"));
    expect(rec.paints).toEqual([]);
    expect(rec.shows).toEqual([]);
  });

  it("stops a drawing under way when the user signs out", async () => {
    await page(true);
    screen(true);
    rowButton(0).click();
    await vi.waitFor(() => expect(rec.flights).toHaveLength(1));
    rec.land();
    tick();
    expect(frames.size).toBeGreaterThan(0);
    pageButton("Salir").click();
    // Some frames belong to the page's own motion; none is left at all once the view is gone.
    expect(frames.size).toBe(0);
    const painted = rec.paints.length;
    tick();
    expect(rec.paints.length).toBe(painted);
    expect(root.querySelector(".map-stage")).toBeNull();
  });

  it("gives every route all its fields at every width: no cell is ever hidden, each figure carries its label and unit", async () => {
    await page();
    for (const row of rows()) {
      const cells = [...row.children];
      expect(cells.map((cell) => cell.getAttribute("role"))).toEqual(["rowheader", "cell", "cell", "cell", "cell", "cell", "cell", "cell"]);
      for (const cell of cells) expect((cell.textContent ?? "").trim()).not.toBe("");
      expect(cells.slice(1).map((cell) => cell.getAttribute("data-label"))).toEqual(["Salida", "Llegada", "Duración", "Distancia", "Media", "Máxima", "Inferidos"]);
      expect(row.querySelector(".c-km")?.getAttribute("data-unit")).toBe("km");
    }
    const css = readFileSync("src/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // No rule, at any width, takes a route's cell out of the layout or cuts it.
    for (const match of css.matchAll(/([^{}]*\.(?:c-(?:date|start|end|dur|km|avg|max|inf)|routes-table (?:tbody )?t[dh](?![\w-]))[^{}]*)\{([^}]*)\}/g)) {
      const selector = match[1] as string;
      if (/::(?:before|after)/.test(selector)) continue;
      expect(match[2], selector).not.toMatch(/display\s*:\s*none|visibility\s*:\s*hidden|overflow\s*:\s*hidden|text-overflow/);
    }
    // Rows wrap rather than scroll sideways; the header is read out, not removed.
    expect(css).toMatch(/\.routes-table tbody tr\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).not.toMatch(/\.routes-table thead\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.routes-table td\[data-label\]::before\s*\{[^}]*content:\s*attr\(data-label\)\s*\/\s*""/);
  });
});
