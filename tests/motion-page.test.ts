// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoCaller } from "../src/demo/scenarios";
import { startApp, type App } from "../src/ui/app";
import { createMapView } from "../src/ui/mapView";

/**
 * Motion as the page drives it: the counts and reveals of the rider's page,
 * the section links, the scroll spy, the progress bar and the period pill
 * stop when the page replaces the view (another scenario, leaving the demo,
 * signing out), and a period change cancels the running counts and counts
 * again, shorter. jsdom, with a hand-driven IntersectionObserver,
 * ResizeObserver and frame queue: this proves the wiring, not what a
 * browser shows.
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
  static all: FakeResize[] = [];
  disconnected = false;
  constructor() {
    FakeResize.all.push(this);
  }
  observe(): void {
    // Sizes never change in jsdom.
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

/** Reports every watched element as on screen, observer by observer. */
function showAll(): void {
  for (const observer of [...FakeObserver.all]) {
    if (observer.disconnected || observer.targets.size === 0) continue;
    const entries = [...observer.targets].map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry);
    observer.callback(entries, observer as unknown as IntersectionObserver);
  }
}

/** Reports these elements as on screen to whichever live observers watch them. */
function showOnly(...targets: Element[]): void {
  for (const observer of [...FakeObserver.all]) {
    const mine = targets.filter((target) => !observer.disconnected && observer.targets.has(target));
    if (mine.length === 0) continue;
    observer.callback(mine.map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry), observer as unknown as IntersectionObserver);
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

const NOW = Date.parse("2026-11-09T20:00:00.000Z");
let root: HTMLElement;
let mounted: App | undefined;

function mount(hash: string, account = false): App {
  mounted?.dispose();
  history.replaceState(null, "", `/${hash}`);
  root = document.createElement("main");
  document.body.replaceChildren(root);
  const surface = { show: () => undefined, clear: () => undefined, frame: (_lines: unknown, _fly: unknown, settled: () => void) => settled(), paint: () => undefined, resize: () => undefined, destroy: () => undefined };
  mounted = startApp({
    root,
    now: () => NOW,
    demoDelayMs: 0,
    createMap: (data, caller, options) => createMapView(data, caller, options, () => surface),
    ...(account ? { account: { signIn: () => Promise.resolve(), signOut: () => undefined } } : {}),
  });
  return mounted;
}

/** Waits for a rider's page that is not `previous`; returns its first section. */
async function view(previous: Element | null = null): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await vi.waitFor(() => {
    found = root.querySelector<HTMLElement>('section[data-section="resumen"]');
    expect(found).not.toBeNull();
    expect(found).not.toBe(previous);
  });
  return found as unknown as HTMLElement;
}

const running = (scope: ParentNode): number => scope.querySelectorAll(".readout .cu-anim").length;
const button = (label: string): HTMLButtonElement | undefined => [...root.querySelectorAll("button")].find((one) => one.textContent === label);
/** Picks a period in the bar's selector, as a click on its option does. */
function pick(index: number): void {
  const options = [...root.querySelectorAll<HTMLInputElement>(".period-control input")];
  options[index]?.click();
}
/** The block of the page whose heading is `title`. */
const block = (title: string): HTMLElement =>
  [...root.querySelectorAll<HTMLElement>("section.block")].find((one) => one.querySelector("h3")?.textContent === title) as HTMLElement;
const live = (): FakeObserver[] => FakeObserver.all.filter((observer) => !observer.disconnected);

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  FakeObserver.all = [];
  FakeResize.all = [];
  frames = new Map();
  reduced = false;
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubGlobal("ResizeObserver", FakeResize);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void frames.delete(id));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query }));
  vi.stubGlobal("scrollTo", () => undefined);
});

afterEach(() => {
  mounted?.dispose();
  mounted = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("motion of the rider's page", () => {
  it("stops the counts and reveals of a view when another scenario replaces it, and on leaving the demo", async () => {
    mount("#demo");
    const first = await view();
    showAll();
    tick(1000);
    expect(running(root)).toBe(4);
    expect(frames.size).toBeGreaterThan(0);
    const before = [...FakeObserver.all];

    const scenario = root.querySelector<HTMLSelectElement>(".demo-banner select") as HTMLSelectElement;
    scenario.value = [...scenario.options].map((option) => option.value).find((value) => value !== scenario.value) as string;
    scenario.dispatchEvent(new Event("change"));
    await view(first);
    // Nothing of the old view still asks for frames or watches the screen; it shows its final text.
    expect(frames.size).toBe(0);
    expect(before.every((observer) => observer.disconnected)).toBe(true);
    expect(running(first)).toBe(0);

    showAll();
    tick(2000);
    expect(running(root)).toBe(4);
    const watching = live();
    button("Salir de la demo")?.click();
    expect(frames.size).toBe(0);
    expect(watching.every((observer) => observer.disconnected)).toBe(true);
    expect(running(root)).toBe(0);
  });

  it("cancels the counts on a period change, counts again shorter, reveals the new blocks and stops when the view goes", async () => {
    mount("#demo");
    await view();
    showAll();
    tick(1000);
    // First count: the hero duration (800 ms without a stylesheet), still running after 600 ms.
    tick(1600);
    expect(running(root)).toBe(4);

    pick(1);
    // The old counts are gone at once; the new ones wait for the screen.
    expect(frames.size).toBe(0);
    expect(running(root)).toBe(0);

    showAll();
    // Every block drawn for the new period is revealed by a live observer.
    expect(root.querySelectorAll(".content .rv:not(.in)")).toHaveLength(0);
    tick(3000);
    expect(running(root)).toBe(4);
    // A re-count lasts the reveal duration (520 ms), so it is over after 600 ms.
    tick(3600);
    expect(running(root)).toBe(0);
    expect(frames.size).toBe(0);

    // Counts of the new period also stop when the page replaces the view.
    pick(0);
    showAll();
    tick(4000);
    expect(running(root)).toBe(4);
    button("Salir de la demo")?.click();
    expect(frames.size).toBe(0);
    expect(running(root)).toBe(0);
  });
});

describe("a period change", () => {
  it("fades in, one after another, the blocks of the period that are on screen, and leaves the others to their reveal", async () => {
    mount("#demo");
    await view();
    showAll();
    const fixed = ["Km por mes", "Mes frente a mes", "Rachas", "Mantenimiento", "Estado"].map(block);
    const header = root.querySelector('section[data-section="resumen"] .sec-head') as HTMLElement;
    // The records and the weekday chart are on screen; the short trips and the card are not.
    for (const observer of live()) {
      for (const target of observer.targets) {
        if (target.classList.contains("slot") || target === header) {
          observer.callback([{ target, isIntersecting: false } as unknown as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
        }
      }
    }
    showOnly(block("Récords").parentElement as Element, block("Días y horas").parentElement as Element, header);
    pick(1);
    const [records, habits, short, card] = ["Récords", "Días y horas", "Trayectos cortos", "Tarjeta para compartir"].map(block) as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect([records, habits].map((one) => [one.classList.contains("swap"), one.classList.contains("in"), one.style.getPropertyValue("--d")])).toEqual([
      [true, true, "0"],
      [true, true, "1"],
    ]);
    // Their charts are shown at once, so their bars grow again.
    expect(habits.querySelectorAll(".rv:not(.in)")).toHaveLength(0);
    // Off screen: no fade now; revealed when they come on screen.
    expect([short, card].map((one) => [one.classList.contains("swap"), one.classList.contains("in")])).toEqual([
      [false, false],
      [false, false],
    ]);
    for (const waiting of [short, card]) expect(live().some((observer) => observer.targets.has(waiting))).toBe(true);
    // The title of section 01 plays its entrance again, without the rule.
    expect([header.classList.contains("replay"), header.classList.contains("sweep")]).toEqual([true, false]);
    // The blocks that do not follow the period are the very same nodes, untouched.
    expect(["Km por mes", "Mes frente a mes", "Rachas", "Mantenimiento", "Estado"].map(block)).toEqual(fixed);
    expect(fixed.some((one) => one.classList.contains("swap"))).toBe(false);
  });

  it("leaves no observer watching a block it removed", async () => {
    mount("#demo");
    await view();
    pick(1);
    pick(2);
    pick(0);
    for (const observer of live()) {
      for (const target of observer.targets) expect(target.isConnected, (target as HTMLElement).className).toBe(true);
    }
  });

  it("shows the final state at once with reduced motion: no fade, no replay, nothing watched", async () => {
    reduced = true;
    mount("#demo");
    await view();
    expect(FakeObserver.all).toHaveLength(1);
    pick(1);
    expect(root.querySelectorAll(".swap, .replay")).toHaveLength(0);
    expect(root.querySelectorAll(".content .rv:not(.in)")).toHaveLength(0);
    expect(running(root)).toBe(0);
    expect(frames.size).toBe(0);
    // Only the scroll spy watches: it marks the current section, it moves nothing.
    expect(live()).toHaveLength(1);
  });
});

describe("the bar's motion goes with the view", () => {
  async function loadedWithMotion(): Promise<{ observers: FakeObserver[]; sizes: FakeResize[] }> {
    await view();
    // A scroll asks the progress bar for a frame; the spy and the size observers are live.
    window.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBeGreaterThan(0);
    const sizes = FakeResize.all.filter((one) => !one.disconnected);
    // The links' underline, the period pill and the bar's height (for the pinned map).
    expect(sizes.length).toBe(3);
    return { observers: live(), sizes };
  }
  function expectReleased(observers: FakeObserver[], sizes: FakeResize[]): void {
    expect(frames.size).toBe(0);
    expect(observers.every((observer) => observer.disconnected)).toBe(true);
    expect(sizes.every((one) => one.disconnected)).toBe(true);
    // The page no longer listens to scrolling: a scroll asks for nothing.
    window.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(0);
  }

  it("on another scenario", async () => {
    mount("#demo");
    const { observers, sizes } = await loadedWithMotion();
    const first = root.querySelector('section[data-section="resumen"]');
    const scenario = root.querySelector<HTMLSelectElement>(".demo-banner select") as HTMLSelectElement;
    scenario.value = "heavy";
    scenario.dispatchEvent(new Event("change"));
    expectReleased(observers, sizes);
    await view(first);
  });

  it("on leaving the demo", async () => {
    mount("#demo");
    const { observers, sizes } = await loadedWithMotion();
    button("Salir de la demo")?.click();
    expectReleased(observers, sizes);
  });

  it("on signing out of an account", async () => {
    const app = mount("", true);
    void app.load(createDemoCaller("commuter", NOW, 0), { demo: false });
    const { observers, sizes } = await loadedWithMotion();
    button("Salir")?.click();
    expectReleased(observers, sizes);
    expect(root.querySelector(".page-nav, .period-control")).toBeNull();
  });
});
