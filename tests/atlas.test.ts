// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import type { Route, TraceLine } from "../src/domain/model";
import { trimTrace } from "../src/domain/trim";
import { ToolCallError, type ToolCaller } from "../src/service/contract";
import { loadAllRoutes, loadRouteTrace, loadVehicleState } from "../src/service/loader";
import { ServiceError } from "../src/service/mcpClient";
import { ATLAS_MAX, chooseRoutes, createAtlasView, DEFAULT_SPACING, DEFAULT_TILT, DEFAULT_YAW, LIFT, type AtlasView } from "../src/ui/atlas/atlasView";
import { camera, farToNear, fitFraming, fitPlane, gridStepKm, layerZ, linesToPlane, toPlane, wrapAngle } from "../src/ui/atlas/geometry";
import { INK } from "../src/ui/atlas/render";
import { buildRiderData, type RiderData } from "../src/ui/data";
import { createMapView } from "../src/ui/mapView";
import { createTraceStore, type TraceStore } from "../src/ui/traceStore";

/**
 * Section «Atlas» (docs/PLAN.md, section 15). jsdom with a recording 2D
 * context, a hand-driven IntersectionObserver and frame queue, and the demo
 * service behind a caller that counts. This proves the contract as we read
 * it against fakes: not what a browser paints, nor the real service.
 */

// ---------- recording 2D context ----------
interface Stroke {
  readonly style: string;
  readonly width: number;
  readonly points: (readonly [number, number])[];
}
class RecordingContext {
  strokeStyle = "";
  fillStyle = "";
  lineWidth = 1;
  globalAlpha = 1;
  font = "";
  textAlign = "";
  textBaseline = "";
  lineJoin = "";
  lineCap = "";
  strokes: Stroke[] = [];
  dots: { x: number; y: number; style: string }[] = [];
  texts: string[] = [];
  clears = 0;
  private path: (readonly [number, number])[] = [];
  private arcs: { x: number; y: number }[] = [];
  setTransform(): void {}
  setLineDash(): void {}
  clearRect(): void {
    this.clears += 1;
    this.strokes = [];
    this.dots = [];
    this.texts = [];
  }
  beginPath(): void {
    this.path = [];
    this.arcs = [];
  }
  closePath(): void {}
  moveTo(x: number, y: number): void {
    this.path.push([x, y]);
  }
  lineTo(x: number, y: number): void {
    this.path.push([x, y]);
  }
  arc(x: number, y: number): void {
    this.arcs.push({ x, y });
  }
  ellipse(x: number, y: number): void {
    this.arcs.push({ x, y });
  }
  stroke(): void {
    this.strokes.push({ style: this.strokeStyle, width: this.lineWidth, points: [...this.path] });
  }
  fill(): void {
    for (const arc of this.arcs) this.dots.push({ ...arc, style: this.fillStyle });
  }
  fillText(text: string): void {
    this.texts.push(text);
  }
}

// ---------- observer, frames, motion ----------
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
function tick(step = 16): void {
  clock += step;
  const waiting = [...frames.values()];
  frames.clear();
  for (const callback of waiting) callback(clock);
}
let reduced = false;
let tabHidden = false;

function animated(): void {
  vi.stubGlobal("IntersectionObserver", FakeObserver);
}

beforeEach(() => {
  FakeObserver.all = [];
  frames = new Map();
  nextFrame = 0;
  clock = 1000;
  reduced = false;
  tabHidden = false;
  // No IntersectionObserver by default: every change is painted at once (as with reduced motion).
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") ? reduced : false, media: query }));
  Object.defineProperty(document, "hidden", { configurable: true, get: () => tabHidden });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// ---------- data ----------
const NOW = Date.parse("2026-11-09T20:00:00.000Z");
const rider = generateRider({ seed: 8, nowMs: NOW });
const shortId = rider.routes.find((route) => (route.distance_km ?? 0) > 0.3 && (route.distance_km ?? 0) < 0.79)?.route_id as string;

interface Harness {
  readonly view: AtlasView;
  readonly data: RiderData;
  readonly store: TraceStore;
  readonly ctx: RecordingContext;
  readonly reads: string[];
  readonly shown: Route[];
  /** Requests waiting for the test to answer them (when `manual`). */
  readonly waiting: (() => void)[];
  maxInFlight: number;
}

interface HarnessOptions {
  /** Answers wait until the test releases them. */
  readonly manual?: boolean;
  /** Replaces the answer of the read number n (1-based). */
  readonly answer?: (n: number, routeId: string) => unknown;
  readonly noCanvas?: boolean;
}

const service = createDemoService(rider);
const baseData: Promise<RiderData> = (async () =>
  buildRiderData(await loadVehicleState(service), null, await loadAllRoutes(service, NOW), true, NOW))();

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const data = await baseData;
  const reads: string[] = [];
  const waiting: (() => void)[] = [];
  let inFlight = 0;
  const h = { reads, waiting, maxInFlight: 0 } as unknown as Harness & { maxInFlight: number };
  const caller: ToolCaller = {
    async callTool(name, args) {
      if (name !== "get_route_detail") return service.callTool(name, args);
      const id = (args as { route_id: string }).route_id;
      reads.push(id);
      inFlight += 1;
      h.maxInFlight = Math.max(h.maxInFlight, inFlight);
      try {
        if (options.manual === true) await new Promise<void>((resolve) => waiting.push(resolve));
        const replaced = options.answer?.(reads.length, id);
        if (replaced instanceof Error) throw replaced;
        return replaced ?? (await service.callTool(name, args));
      } finally {
        inFlight -= 1;
      }
    },
  };
  const store = createTraceStore(caller);
  const ctx = new RecordingContext();
  const shown: Route[] = [];
  const view = createAtlasView(data, "all", {
    traces: store,
    signIn: () => undefined,
    showOnMap: (route) => void shown.push(route),
    context: () => (options.noCanvas === true ? null : (ctx as unknown as CanvasRenderingContext2D)),
  });
  document.body.append(view.element);
  return Object.assign(h, { view, data, store, ctx, shown });
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const $ = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T;
const press = async (selector: string): Promise<void> => {
  $<HTMLButtonElement>(selector).click();
  await settle();
};
const stageState = (): string | null => $(".atlas-stage").getAttribute("data-state");

// ---------- the math ----------
describe("atlas geometry", () => {
  const line = (points: [number, number][]): TraceLine => ({ inferred: false, points });

  it("puts the set's centre at the middle of the plate and its widest side at the margin", () => {
    // 0.2° of longitude at the equator ≈ 22.264 km wide; 0.1° of latitude ≈ 11.06 km tall.
    const plane = fitPlane([[line([[0, 0], [0.1, 0.2]])]]);
    expect(plane.center).toEqual([0.05, 0.1]);
    expect(plane.halfKm).toBeCloseTo((0.2 * 111.32 * Math.cos((0.05 * Math.PI) / 180) * 1.08) / 2, 6);
    expect(toPlane(plane, [0.05, 0.1])).toEqual([0, 0]);
    const east = toPlane(plane, [0.05, 0.2]);
    expect(east[0]).toBeCloseTo(1 / 1.08, 9);
    expect(east[1]).toBeCloseTo(0, 9);
    const north = toPlane(plane, [0.1, 0.1]);
    expect(north[0]).toBeCloseTo(0, 9);
    expect(north[1]).toBeCloseTo((0.05 * 110.574) / plane.halfKm, 9);
  });

  it("picks the grid of 1, 2, 5, 10, 20… km closest to eight cells across", () => {
    expect([0.5, 3, 5, 6, 24, 25, 26, 90, 400].map(gridStepKm)).toEqual([1, 1, 1, 2, 5, 5, 5, 20, 100]);
    // Wherever the ladder allows, 6 to 10 cells.
    for (const half of [3, 4, 7, 30, 45, 70, 200]) {
      const cells = (2 * half) / gridStepKm(half);
      expect(cells).toBeGreaterThanOrEqual(6);
      expect(cells).toBeLessThanOrEqual(10);
    }
  });

  it("projects by hand: from above north is up and east is right; yaw turns the plate", () => {
    const top = camera({ yaw: 0, tilt: Math.PI / 2, width: 300, height: 300 });
    const [cx, cy] = top.project(0, 0, 0);
    const [ex, ey] = top.project(1, 0, 0);
    const [nx, ny] = top.project(0, 1, 0);
    expect(ex).toBeGreaterThan(cx);
    expect(ey).toBeCloseTo(cy, 9);
    expect(ny).toBeLessThan(cy);
    expect(nx).toBeCloseTo(cx, 9);
    // A quarter turn puts east where north was.
    const turned = camera({ yaw: Math.PI / 2, tilt: Math.PI / 2, width: 300, height: 300 });
    const [tx, ty] = turned.project(1, 0, 0);
    expect(tx).toBeCloseTo(nx, 9);
    expect(ty).toBeCloseTo(ny, 9);
    // …and north to the west: a turn, not a mirror.
    const [wx, wy] = turned.project(0, 1, 0);
    expect(wx).toBeLessThan(cx);
    expect(wy).toBeCloseTo(cy, 9);
    // From the side (tilt 0) height goes up the screen.
    const side = camera({ yaw: 0, tilt: 0, width: 300, height: 300 });
    expect(side.project(0, 0, 0.5)[1]).toBeLessThan(side.project(0, 0, 0)[1]);
  });

  it("orders the layers far to near, and from above the higher one is nearer", () => {
    const zs = [layerZ(0, 3, 0.1), layerZ(1, 3, 0.1), layerZ(2, 3, 0.1)];
    expect(zs).toEqual([-0.1, 0, 0.1]);
    expect(farToNear(zs, camera({ yaw: 0.3, tilt: (60 * Math.PI) / 180, width: 400, height: 300 }))).toEqual([0, 1, 2]);
  });

  it("wraps angles into (-π, π]", () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(-Math.PI, 9);
    expect(wrapAngle(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 9);
    expect(wrapAngle(2 * Math.PI + 0.25)).toBeCloseTo(0.25, 9);
  });
});

describe("which routes", () => {
  it("takes at most eight of the period, the longest or the latest, oldest first", async () => {
    const data = await baseData;
    const longest = chooseRoutes(data.routes, "all", "longest");
    expect(longest).toHaveLength(ATLAS_MAX);
    const floor = Math.min(...longest.map((route) => route.distanceKm));
    expect(data.routes.filter((route) => route.distanceKm > floor).every((route) => longest.includes(route))).toBe(true);
    expect(longest.map((route) => route.startMs)).toEqual([...longest.map((route) => route.startMs)].sort((a, b) => a - b));
    const latest = chooseRoutes(data.routes, 2025, "latest");
    expect(latest.every((route) => new Date(route.startMs).getFullYear() === 2025)).toBe(true);
    const last2025 = data.routes.filter((route) => new Date(route.startMs).getFullYear() === 2025).slice(-ATLAS_MAX);
    expect(latest).toEqual(last2025);
  });
});

// ---------- data rules ----------
describe("reads", () => {
  it("asks nothing until the button, then at most eight, strictly one after another", async () => {
    const h = await harness({ manual: true });
    await settle();
    expect(h.reads).toHaveLength(0);
    expect($(".atlas-cost").textContent).toBe("Hará hasta 8 lecturas al servicio, una cada vez.");
    expect(stageState()).toBe("idle");
    await press(".atlas-build");
    for (let n = 1; n <= ATLAS_MAX; n += 1) {
      expect(h.reads).toHaveLength(n);
      expect(stageState()).toBe("loading");
      h.waiting.shift()?.();
      await settle();
    }
    expect(h.reads).toHaveLength(ATLAS_MAX);
    expect(h.maxInFlight).toBe(1);
    expect(stageState()).toBe("built");
    expect(new Set(h.reads).size).toBe(ATLAS_MAX);
  });

  it("does not read again what the map (the shared store) already has", async () => {
    const h = await harness();
    const chosen = chooseRoutes(h.data.routes, "all", "longest");
    await h.store.get(chosen[0] as Route);
    await h.store.get(chosen[5] as Route);
    expect($(".atlas-cost").textContent).toContain("6 lecturas");
    await press(".atlas-build");
    await settle();
    expect(h.reads).toHaveLength(8);
    expect(new Set(h.reads).size).toBe(8);
    // A second build costs nothing.
    expect($(".atlas-cost").textContent).toContain("no hará ninguna lectura");
    await press(".atlas-build");
    expect(h.reads).toHaveLength(8);
  });

  for (const [label, stop] of [
    ["cancel", () => $<HTMLButtonElement>(".atlas-cancel").click()],
    ["a period change", (view: AtlasView) => view.setPeriod(2025)],
    ["the view going (sign-out, another load)", (view: AtlasView) => view.destroy()],
    ["a set change", () => $<HTMLButtonElement>('.atlas-set-opt[data-set="latest"]').click()],
  ] as const) {
    it(`stops before the next read on ${label}`, async () => {
      const h = await harness({ manual: true });
      await press(".atlas-build");
      h.waiting.shift()?.();
      await settle();
      expect(h.reads).toHaveLength(2);
      stop(h.view);
      // The read in flight finishes; nothing else is asked.
      h.waiting.shift()?.();
      await settle();
      expect(h.reads).toHaveLength(2);
      if (!label.startsWith("the view")) expect(stageState()).not.toBe("loading");
    });
  }

  it("skips a trace hidden by privacy and counts it, without calling it an error", async () => {
    expect(shortId).toBeDefined();
    const h = await harness({ answer: (n) => (n === 2 ? rider.detail(shortId) : undefined) });
    await press(".atlas-build");
    await settle();
    expect(h.reads).toHaveLength(8);
    expect(stageState()).toBe("built");
    expect($(".atlas-skipped").textContent).toBe("1 traza oculta por privacidad");
    expect(document.querySelector(".atlas .error")).toBeNull();
    expect($(".atlas-canvas").getAttribute("aria-label")).toMatch(/^Atlas de 7 trazas apiladas/);
    expect(document.querySelectorAll(".atlas-table tbody tr")).toHaveLength(7);
  });

  it("stops at a failed read, keeps what arrived, and «Reintentar» goes on from there", async () => {
    let fail = true;
    const h = await harness({ answer: (n) => (n === 3 && fail ? new ToolCallError("tool_error", "boom") : undefined) });
    await press(".atlas-build");
    await settle();
    expect(h.reads).toHaveLength(3);
    const error = $(".atlas .error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.querySelector("code")?.textContent).toBe("detail/tool_error (tool_error)");
    expect($(".atlas-canvas").getAttribute("aria-label")).toMatch(/^Atlas de 2 trazas/);
    fail = false;
    const retry = [...error.querySelectorAll("button")].find((button) => button.textContent === "Reintentar") as HTMLButtonElement;
    retry.click();
    await settle();
    // The two that arrived are not read again.
    expect(h.reads).toHaveLength(3 + 6);
    expect($(".atlas-canvas").getAttribute("aria-label")).toMatch(/^Atlas de 8 trazas/);
  });

  it("offers a new sign-in, not a retry, when the session ended", async () => {
    const h = await harness({ answer: (n) => (n === 1 ? new ServiceError("reauth_required") : undefined) });
    await press(".atlas-build");
    await settle();
    expect(h.reads).toHaveLength(1);
    const buttons = [...document.querySelectorAll(".atlas .error button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Volver a entrar"]);
  });
});

// ---------- privacy of the drawing ----------
/** Stroke widths used only by the plate: the scale bar and the selected ring (1.5), ticks and north (2). */
const PLATE_WIDTHS = new Set([1.5, 2]);
const distanceToSegment = (p: readonly [number, number], a: readonly number[], b: readonly number[]): number => {
  const dx = (b[0] as number) - (a[0] as number);
  const dy = (b[1] as number) - (a[1] as number);
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - (a[0] as number)) * dx + (p[1] - (a[1] as number)) * dy) / length));
  return Math.hypot(p[0] - ((a[0] as number) + t * dx), p[1] - ((a[1] as number) + t * dy));
};

async function trimmedOf(routes: readonly Route[]): Promise<TraceLine[][]> {
  return Promise.all(routes.map(async (route) => [...trimTrace(await loadRouteTrace(service, route.ref)).lines]));
}

describe("what is drawn", () => {
  it("draws every trace point, footprint and head only on the trimmed lines", async () => {
    const h = await harness();
    await press(".atlas-build");
    const traces = (await trimmedOf(chooseRoutes(h.data.routes, "all", "longest"))).filter((lines) => lines.length > 0);
    const plane = fitPlane(traces);
    // The framing of a full stack of eight at the default angle (src/ui/atlas/atlasView.ts).
    const full = 7 * DEFAULT_SPACING;
    const fullGround = -full / 2 - 0.18;
    const framing = fitFraming(640, 512, DEFAULT_YAW, DEFAULT_TILT, fullGround, fullGround + Math.max(0.6, full + 0.3) + LIFT);
    const view = camera({ yaw: DEFAULT_YAW, tilt: DEFAULT_TILT, width: 640, height: 512, framing });
    const n = traces.length;
    const ground = layerZ(0, n, DEFAULT_SPACING) - 0.18;

    const check = (lift: number, selectedIndex: number): void => {
      const segments: (readonly number[])[][] = [];
      traces.forEach((lines, index) => {
        const z = layerZ(index, n, DEFAULT_SPACING) + (index === selectedIndex ? lift : 0);
        for (const at of [z, ground]) {
          for (const line of linesToPlane(plane, lines)) {
            for (let k = 1; k < line.points.length; k += 1) {
              const a = line.points[k - 1] as readonly [number, number];
              const b = line.points[k] as readonly [number, number];
              segments.push([view.project(a[0], a[1], at), view.project(b[0], b[1], at)]);
            }
          }
        }
      });
      const near = (p: readonly [number, number]): number => Math.min(...segments.map(([a, b]) => distanceToSegment(p, a as number[], b as number[])));
      // Everything but the plate (grid, frame, sheets, crop marks, scale bar, ticks, north and the drop line).
      const traceStrokes = h.ctx.strokes.filter((stroke) => !PLATE_WIDTHS.has(stroke.width) && ![INK.grid, INK.frame, INK.fg3, INK.fg].includes(stroke.style as never));
      expect(traceStrokes.length).toBeGreaterThan(n);
      let checked = 0;
      for (const stroke of traceStrokes) {
        for (const point of stroke.points) {
          expect(near(point)).toBeLessThan(0.01);
          checked += 1;
        }
      }
      for (const dot of h.ctx.dots) expect(near([dot.x, dot.y])).toBeLessThan(0.05);
      expect(checked).toBeGreaterThan(200);
    };
    check(0, -1);
    // A selected layer lifts; a scrubbed replay draws part of it with a head on its trimmed lines.
    const select = $<HTMLSelectElement>(".atlas-select");
    select.value = "2";
    select.dispatchEvent(new Event("change"));
    const progress = document.querySelectorAll<HTMLInputElement>(".atlas-ranges input")[3] as HTMLInputElement;
    progress.value = "430";
    progress.dispatchEvent(new Event("input"));
    expect(h.ctx.dots.length).toBeGreaterThan(0);
    check(LIFT, 2);
  });

  it("writes the north mark and the grid scale, and a complete drawing has no dot at all", async () => {
    const h = await harness();
    await press(".atlas-build");
    const step = /Cuadrícula de (\d+) km\./.exec($(".atlas-canvas").getAttribute("aria-label") ?? "")?.[1];
    expect(step).toBeDefined();
    expect(h.ctx.texts[0]).toBe(`${step as string} km`);
    expect(h.ctx.texts[h.ctx.texts.length - 1]).toBe("N");
    // Between them, short dates beside the nearest post (some skipped when they would touch).
    const dates = h.ctx.texts.slice(1, -1);
    expect(dates.length).toBeGreaterThan(2);
    expect(dates.every((one) => /^\d{1,2} [a-z]{3}$/.test(one))).toBe(true);
    // The concept drew a start dot: here a dot only exists while a trace draws itself.
    expect(h.ctx.dots).toHaveLength(0);
  });
});

describe("projection cache", () => {
  it("projects the traces again when the camera turns, and not when it stays", async () => {
    const h = await harness();
    await press(".atlas-build");
    const traceStroke = (): Stroke => h.ctx.strokes.find((stroke) => !PLATE_WIDTHS.has(stroke.width) && stroke.width > 1.6) as Stroke;
    const before = traceStroke().points.map((point) => [...point]);
    // Same camera (a spacing change of nothing): the same points.
    const spacing = document.querySelectorAll<HTMLInputElement>(".atlas-ranges input")[2] as HTMLInputElement;
    spacing.dispatchEvent(new Event("input"));
    expect(traceStroke().points.map((point) => [...point])).toEqual(before);
    $(".atlas-canvas").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const after = traceStroke().points.map((point) => [...point]);
    expect(after).toHaveLength(before.length);
    expect(after).not.toEqual(before);
  });
});

// ---------- interaction ----------
describe("selection", () => {
  it("selects with the control, ↑/↓ on the canvas and Escape; «Ver en el mapa» opens that route", async () => {
    const h = await harness();
    await press(".atlas-build");
    const map = $<HTMLButtonElement>(".atlas-tomap");
    expect(map.disabled).toBe(true);
    const canvas = $(".atlas-canvas");
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect($<HTMLSelectElement>(".atlas-select").value).toBe("0");
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect($<HTMLSelectElement>(".atlas-select").value).toBe("1");
    expect($(".atlas-lead").textContent).toMatch(/^Capa 2 de 8 · /);
    expect([...document.querySelectorAll(".atlas-fig dt")].map((one) => one.textContent)).toEqual(["Distancia", "Duración", "Vel. media", "Vel. máxima"]);
    map.click();
    const chosen = chooseRoutes(h.data.routes, "all", "longest");
    expect(h.shown).toEqual([chosen[1]]);
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($<HTMLSelectElement>(".atlas-select").value).toBe("-1");
    expect(map.disabled).toBe(true);
    // ← and → turn the plate (and its slider).
    const yaw = document.querySelectorAll<HTMLInputElement>(".atlas-ranges input")[0] as HTMLInputElement;
    const before = Number(yaw.value);
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(Number(yaw.value)).toBe(before + 10);
  });
});

// ---------- frames ----------
describe("frames", () => {
  it("asks for no frame while idle, off screen or in a hidden tab, and stops when everything settles", async () => {
    animated();
    await harness();
    expect(frames.size).toBe(0);
    await press(".atlas-build");
    // Off screen: the layers arrive but nothing animates.
    expect(frames.size).toBe(0);
    tabHidden = true;
    screen(true);
    expect(frames.size).toBe(0);
    tabHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(1);
    // The build-up and the intro run, then the frames stop by themselves.
    let count = 0;
    while (frames.size > 0 && count < 2000) {
      tick();
      count += 1;
    }
    expect(count).toBeGreaterThan(30);
    expect(count).toBeLessThan(2000);
    expect(frames.size).toBe(0);
    // Leaving the screen mid-move stops the frames.
    $<HTMLButtonElement>(".atlas-play").click();
    expect(frames.size).toBe(1);
    screen(false);
    tick();
    expect(frames.size).toBe(0);
  });

  it("with reduced motion: no observer, no frame, no replay button, the drawing complete at once", async () => {
    reduced = true;
    animated();
    const h = await harness();
    await press(".atlas-build");
    expect(FakeObserver.all).toHaveLength(0);
    expect(frames.size).toBe(0);
    expect($(".atlas-play").hidden).toBe(true);
    expect(h.ctx.dots).toHaveLength(0);
    // Sliders and selection still work, painted at once.
    const before = h.ctx.clears;
    const tilt = document.querySelectorAll<HTMLInputElement>(".atlas-ranges input")[1] as HTMLInputElement;
    tilt.value = "70";
    tilt.dispatchEvent(new Event("input"));
    expect(h.ctx.clears).toBe(before + 1);
    expect(frames.size).toBe(0);
  });

  it("lets go of its frame and observers when destroyed", async () => {
    animated();
    const h = await harness();
    await press(".atlas-build");
    screen(true);
    expect(frames.size).toBe(1);
    h.view.destroy();
    expect(frames.size).toBe(0);
    expect(FakeObserver.all.every((one) => one.disconnected)).toBe(true);
  });
});

describe("without a canvas", () => {
  it("lists the routes it would stack and reads nothing", async () => {
    const h = await harness({ noCanvas: true });
    expect(stageState()).toBe("fallback");
    expect($(".atlas-fallback-title").textContent).toBe("Este navegador no puede dibujar el atlas");
    const chosen = chooseRoutes(h.data.routes, "all", "longest");
    expect(document.querySelectorAll(".atlas-fallback-list li")).toHaveLength(chosen.length);
    expect($(".atlas-build").hidden).toBe(true);
    $<HTMLButtonElement>(".atlas-build").click();
    await settle();
    expect(h.reads).toHaveLength(0);
  });
});

describe("shared with the map", () => {
  it("opens in the map, without a new read, a route the atlas has read", async () => {
    const h = await harness();
    await press(".atlas-build");
    expect(h.reads).toHaveLength(8);
    const painted: unknown[] = [];
    const map = createMapView(h.data, { callTool: () => Promise.reject(new Error("no reads here")) }, { signIn: null, traces: h.store }, () => ({
      show: (lines) => void painted.push(lines),
      frame: (_lines, _fly, settled) => settled(),
      paint: () => undefined,
      clear: () => undefined,
      resize: () => undefined,
      destroy: () => undefined,
    }));
    document.body.append(map.element);
    map.open(chooseRoutes(h.data.routes, "all", "longest")[4] as Route);
    await settle();
    expect(h.reads).toHaveLength(8);
    expect(painted).toHaveLength(1);
    map.destroy();
  });
});
