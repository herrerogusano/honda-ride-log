// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import { DEMO_SEED } from "../src/demo/scenarios";
import type { ToolCaller } from "../src/service/contract";
import { startApp, type App } from "../src/ui/app";
import { loadingStage, MAX_HOLD_MS, RULER_STEPS } from "../src/ui/loadingStage";
import { createMapView } from "../src/ui/mapView";

/**
 * The first load as an instrument cluster booting (docs/PLAN.md, section
 * 14). jsdom with a hand-driven IntersectionObserver and frame queue: this
 * proves the wiring (counter, year tag, ruler, status texts, hand-off and
 * cancellation), not what a browser shows; that was looked at in Chrome.
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
class FakeResize {
  observe(): void {
    // Sizes never change in jsdom.
  }
  disconnect(): void {
    // Nothing to release.
  }
}
function showAll(): void {
  for (const observer of [...FakeObserver.all]) {
    if (observer.disconnected || observer.targets.size === 0) continue;
    observer.callback([...observer.targets].map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry), observer as unknown as IntersectionObserver);
  }
}
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
function tick(at: number): void {
  const waiting = [...frames.values()];
  frames.clear();
  for (const callback of waiting) callback(at);
}
let reduced = false;
const live = (): FakeObserver[] => FakeObserver.all.filter((observer) => !observer.disconnected);

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  FakeObserver.all = [];
  frames = new Map();
  reduced = false;
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubGlobal("ResizeObserver", FakeResize);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void frames.delete(id));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query }));
  vi.stubGlobal("scrollTo", () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** The figure as shown: the passing digits while counting, else the exact text. */
const shownNumber = (stage: HTMLElement): string =>
  (stage.querySelector(".boot-num .cu-anim") ?? stage.querySelector(".boot-num .cu-final") ?? stage.querySelector(".boot-num"))?.textContent ?? "";
const exactNumber = (stage: HTMLElement): string => stage.querySelector(".boot-num")?.textContent?.replace(/^(\d[\d.]*)(?:.*)$/, "$1") ?? "";
const year = (stage: HTMLElement): string => stage.querySelector(".boot-year-in:not(.leave)")?.textContent ?? "";

describe("the loading stage", () => {
  it("counts up to the real number of routes at each step and ends on the exact figure; the digits are not read out", () => {
    const motion = new AbortController();
    const stage = loadingStage({ signal: motion.signal });
    document.body.append(stage.element);
    expect(shownNumber(stage.element)).toBe("0");
    expect(stage.element.querySelector(".boot-count")?.getAttribute("aria-hidden")).toBe("true");
    stage.progress(2026, 0);
    stage.progress(2026, 240);
    showAll();
    tick(1000);
    expect(shownNumber(stage.element)).toBe("0");
    tick(1260);
    const half = Number(shownNumber(stage.element));
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(240);
    // The next step goes on from the figure already reached, not from 0.
    stage.progress(2025, 1412);
    expect(stage.element.querySelector(".boot-num .cu-final")?.textContent).toBe("1.412");
    showAll();
    tick(2000);
    expect(shownNumber(stage.element)).toBe("240");
    tick(3000);
    expect(stage.element.querySelector(".boot-num .cu-anim")).toBeNull();
    expect(stage.element.querySelector(".boot-num")?.textContent).toBe("1.412");
    expect(exactNumber(stage.element)).toBe("1.412");
    // The status line says it in words, as it always did.
    expect(stage.status.getAttribute("role")).toBe("status");
    expect(stage.status.textContent).toBe("Cargando rutas de 2025… 1.412 hasta ahora.");
    motion.abort();
  });

  it("holds the year being read in the red tag, flipping the old one out when the loader moves on", () => {
    vi.useFakeTimers();
    const motion = new AbortController();
    const stage = loadingStage({ signal: motion.signal });
    expect(year(stage.element)).toBe("Estado");
    stage.step("Vehículo", "Leyendo los datos del vehículo…");
    expect([year(stage.element), stage.status.textContent]).toEqual(["Vehículo", "Leyendo los datos del vehículo…"]);
    stage.progress(2026, 10);
    expect(year(stage.element)).toBe("2026");
    expect(stage.element.querySelector(".boot-caption")?.textContent).toBe("Leyendo el historial");
    stage.progress(2026, 20);
    // The same year again does not flip.
    expect(stage.element.querySelectorAll(".boot-year-in.enter:not(.leave)")).toHaveLength(1);
    vi.advanceTimersByTime(200);
    stage.progress(2025, 30);
    expect(year(stage.element)).toBe("2025");
    expect(stage.element.querySelector(".boot-year-in.leave")?.textContent).toBe("2026");
    vi.advanceTimersByTime(200);
    expect([...stage.element.querySelectorAll(".boot-year-in")].map((one) => one.textContent)).toEqual(["2025"]);
    motion.abort();
  });

  it("moves a run of ticks one step per completed request, with no percentage anywhere", () => {
    const motion = new AbortController();
    const stage = loadingStage({ signal: motion.signal });
    const run = stage.element.querySelector(".boot-run") as HTMLElement;
    for (let step = 1; step <= RULER_STEPS + 2; step += 1) stage.progress(2026, step * 10);
    expect(run.style.getPropertyValue("--step")).toBe("2");
    expect(stage.element.classList.contains("reading")).toBe(true);
    expect(stage.element.textContent).not.toContain("%");
    motion.abort();
  });

  it("pauses its scan line off screen and in a hidden tab, and stops everything when aborted", () => {
    const motion = new AbortController();
    const stage = loadingStage({ signal: motion.signal });
    expect(stage.element.querySelector(".boot-scan .scan-line")).not.toBeNull();
    const observer = live()[0] as FakeObserver;
    observer.callback([{ target: stage.element, isIntersecting: false } as unknown as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
    expect(stage.element.classList.contains("paused")).toBe(true);
    observer.callback([{ target: stage.element, isIntersecting: true } as unknown as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
    expect(stage.element.classList.contains("paused")).toBe(false);
    stage.progress(2026, 500);
    showAll();
    tick(10);
    expect(frames.size).toBeGreaterThan(0);
    motion.abort();
    expect(frames.size).toBe(0);
    expect(live()).toHaveLength(0);
    expect(stage.element.classList.contains("paused")).toBe(true);
    expect(stage.element.querySelector(".boot-num")?.textContent).toBe("500");
  });

  it("holds a fast load at most MAX_HOLD_MS, and not at all once it has been seen long enough", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const motion = new AbortController();
    const stage = loadingStage({ signal: motion.signal, now: () => clock });
    clock = 100;
    let done = false;
    void stage.settle().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    clock = 600;
    done = false;
    void stage.settle().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toBe(true);
    clock = 5000;
    await expect(stage.settle()).resolves.toBeUndefined();
    motion.abort();
  });

  it("with reduced motion: the figure and the year just change; no observer, no frame, no hold, no wipe", async () => {
    reduced = true;
    const motion = new AbortController();
    const stage = loadingStage({ signal: motion.signal });
    stage.progress(2026, 50);
    stage.progress(2025, 80);
    expect([exactNumber(stage.element), year(stage.element)]).toEqual(["80", "2025"]);
    expect(stage.element.querySelectorAll(".boot-year-in")).toHaveLength(1);
    expect(stage.element.querySelector(".enter, .leave, .cu-anim")).toBeNull();
    expect([FakeObserver.all.length, frames.size]).toEqual([0, 0]);
    await expect(stage.settle()).resolves.toBeUndefined();
    const hero = document.createElement("section");
    document.body.append(stage.element, hero);
    motion.abort();
    stage.handOff(hero, new AbortController().signal);
    expect(stage.element.isConnected).toBe(false);
    expect(hero.classList.contains("handed")).toBe(false);
  });

  it("hands off to the page: lies over the hero, drops its status, wipes, and goes at the end or when the view goes", () => {
    vi.useFakeTimers();
    const loading = new AbortController();
    const stage = loadingStage({ signal: loading.signal });
    document.body.append(stage.element);
    loading.abort();
    const hero = document.createElement("section");
    document.body.append(hero);
    const view = new AbortController();
    stage.handOff(hero, view.signal);
    expect(stage.element.parentElement).toBe(hero);
    expect([stage.element.classList.contains("handoff"), hero.classList.contains("handed")]).toEqual([true, true]);
    expect(stage.element.querySelector('[role="status"]')).toBeNull();
    expect(stage.element.getAttribute("aria-hidden")).toBe("true");
    vi.advanceTimersByTime(999);
    expect(stage.element.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect([stage.element.isConnected, hero.classList.contains("handed")]).toEqual([false, false]);

    view.abort();
    const second = loadingStage({ signal: new AbortController().signal });
    const other = document.createElement("section");
    document.body.append(other);
    second.handOff(other, view.signal);
    // The view is already gone: nothing lies over anything.
    expect(second.element.isConnected).toBe(false);
  });
});

describe("the loading stage in the page", () => {
  const NOW = Date.parse("2026-11-09T20:00:00.000Z");
  const rider = generateRider({ seed: DEMO_SEED, nowMs: NOW });
  let root: HTMLElement;
  let app: App | undefined;

  function staged(fail = false): { caller: ToolCaller; release: () => Promise<void>; releaseAll: () => void } {
    const service = createDemoService(rider);
    const waiting: (() => void)[] = [];
    return {
      caller: {
        async callTool(name, args) {
          await new Promise<void>((resolve) => waiting.push(resolve));
          if (fail && name === "list_routes") throw new Error("down");
          return service.callTool(name, args);
        },
      },
      async release() {
        await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
        waiting.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      releaseAll() {
        for (const go of waiting.splice(0)) go();
      },
    };
  }
  function mount(): App {
    app?.dispose();
    history.replaceState(null, "", "/");
    root = document.createElement("main");
    document.body.replaceChildren(root);
    const surface = { show: () => undefined, clear: () => undefined, frame: (_l: unknown, _f: unknown, settled: () => void) => settled(), paint: () => undefined, resize: () => undefined, destroy: () => undefined };
    app = startApp({
      root,
      now: () => NOW,
      initialView: "none",
      createMap: (data, caller, options) => createMapView(data, caller, options, () => surface),
      account: { signIn: () => Promise.resolve(), signOut: () => undefined },
    });
    return app;
  }
  afterEach(() => {
    app?.dispose();
    app = undefined;
  });

  it("follows the loader: the same status texts, the year of each step and the routes so far, then becomes the page", async () => {
    const steps = staged();
    const loading = mount().load(steps.caller, { demo: false });
    const stage = root.querySelector(".boot") as HTMLElement;
    const status = (): string => root.querySelector('[role="status"]')?.textContent ?? "";
    expect(status()).toBe("Leyendo el estado de la moto…");
    await steps.release();
    expect(status()).toBe("Leyendo los datos del vehículo…");
    expect(stage.querySelector(".vehicle-line")).not.toBeNull();
    await steps.release();
    expect(status()).toBe("Cargando rutas de 2026… 0 hasta ahora.");
    expect(year(stage)).toBe("2026");
    await steps.release();
    const loaded = /… ([\d.]+) hasta ahora/.exec(status())?.[1];
    expect(stage.querySelector(".boot-num .cu-final")?.textContent).toBe(loaded);
    let finished = false;
    void loading.then(() => (finished = true));
    const seenYears = new Set<string>([year(stage)]);
    while (!finished) {
      steps.releaseAll();
      seenYears.add(year(stage));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect([...seenYears].filter((one) => /^\d{4}$/.test(one)).length).toBeGreaterThan(1);
    // The page is there; the stage lies over its hero for the wipe, without its status.
    expect(root.querySelector('section[data-section="resumen"]')).not.toBeNull();
    const over = root.querySelector(".boot");
    expect(over?.classList.contains("handoff")).toBe(true);
    expect(over?.parentElement?.classList.contains("hero")).toBe(true);
    expect(root.querySelector(".loading")).toBeNull();
  });

  it("stops the stage when the user signs out mid-load, and resolves a failure into the error panel without a wipe", async () => {
    const steps = staged();
    const page = mount();
    void page.load(steps.caller, { demo: false });
    await steps.release();
    await steps.release();
    await steps.release();
    showAll();
    tick(100);
    expect(live().length).toBeGreaterThan(0);
    (root.querySelector(".sign-out") as HTMLButtonElement).click();
    expect(live()).toHaveLength(0);
    expect(frames.size).toBe(0);
    expect(root.querySelector(".boot")).toBeNull();
    steps.releaseAll();

    const failing = staged(true);
    void mount().load(failing.caller, { demo: false });
    await failing.release();
    await failing.release();
    await failing.release();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
    expect(root.querySelector(".boot, .handoff, .hero.handed")).toBeNull();
    expect(root.querySelector(".vehicle-line")).not.toBeNull();
    expect(live()).toHaveLength(0);
  });
});
