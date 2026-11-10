// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startApp, type App } from "../src/ui/app";
import { createMapView } from "../src/ui/mapView";

/**
 * Motion as the page drives it: the Resumen counts and reveals stop when the
 * page replaces the view, and a period change cancels the running counts and
 * counts again, shorter. jsdom, with a hand-driven IntersectionObserver and
 * frame queue: this proves the wiring, not what a browser shows.
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

/** Reports every watched element as on screen, observer by observer. */
function showAll(): void {
  for (const observer of [...FakeObserver.all]) {
    if (observer.disconnected || observer.targets.size === 0) continue;
    const entries = [...observer.targets].map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry);
    observer.callback(entries, observer as unknown as IntersectionObserver);
  }
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
function tick(at: number): void {
  const waiting = [...frames.values()];
  frames.clear();
  for (const callback of waiting) callback(at);
}

const NOW = Date.parse("2026-11-09T20:00:00.000Z");
let root: HTMLElement;

function mount(hash: string): App {
  history.replaceState(null, "", `/${hash}`);
  root = document.createElement("main");
  document.body.replaceChildren(root);
  const surface = { show: () => undefined, clear: () => undefined, resize: () => undefined, destroy: () => undefined };
  return startApp({ root, now: () => NOW, demoDelayMs: 0, createMap: (data, caller, options) => createMapView(data, caller, options, () => surface) });
}

/** Waits for a Resumen view that is not `previous`. */
async function view(previous: Element | null = null): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await vi.waitFor(() => {
    found = root.querySelector<HTMLElement>(".summary");
    expect(found).not.toBeNull();
    expect(found).not.toBe(previous);
  });
  return found as unknown as HTMLElement;
}

const running = (scope: ParentNode): number => scope.querySelectorAll(".readout .cu-anim").length;

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  FakeObserver.all = [];
  frames = new Map();
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void frames.delete(id));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("motion of the Resumen inside the page", () => {
  it("stops the counts and reveals of a view when another scenario replaces it, and on leaving the demo", async () => {
    mount("#demo");
    const first = await view();
    showAll();
    tick(1000);
    expect(running(first)).toBe(4);
    expect(frames.size).toBeGreaterThan(0);
    const before = [...FakeObserver.all];

    const scenario = root.querySelector<HTMLSelectElement>(".demo-banner select") as HTMLSelectElement;
    scenario.value = [...scenario.options].map((option) => option.value).find((value) => value !== scenario.value) as string;
    scenario.dispatchEvent(new Event("change"));
    const second = await view(first);
    // Nothing of the old view still asks for frames or watches the screen; it shows its final text.
    expect(frames.size).toBe(0);
    expect(before.every((observer) => observer.disconnected)).toBe(true);
    expect(running(first)).toBe(0);

    showAll();
    tick(2000);
    expect(running(second)).toBe(4);
    const live = FakeObserver.all.filter((observer) => !observer.disconnected);
    [...root.querySelectorAll("button")].find((button) => button.textContent === "Salir de la demo")?.click();
    expect(frames.size).toBe(0);
    expect(live.every((observer) => observer.disconnected)).toBe(true);
    expect(running(second)).toBe(0);
  });

  it("cancels the counts on a period change, counts again shorter, reveals the new blocks and stops when the view goes", async () => {
    mount("#demo");
    const summary = await view();
    showAll();
    tick(1000);
    // First count: the hero duration (800 ms without a stylesheet), still running after 600 ms.
    tick(1600);
    expect(running(summary)).toBe(4);

    const period = summary.querySelector<HTMLSelectElement>(".period select") as HTMLSelectElement;
    period.value = period.options[1]?.value as string;
    period.dispatchEvent(new Event("change"));
    // The old counts are gone at once; the new ones wait for the screen.
    expect(frames.size).toBe(0);
    expect(running(summary)).toBe(0);

    showAll();
    // Every block drawn for the new period is revealed by a live observer.
    expect(summary.querySelectorAll(".rv:not(.in)")).toHaveLength(0);
    tick(3000);
    expect(running(summary)).toBe(4);
    // A re-count lasts the reveal duration (520 ms), so it is over after 600 ms.
    tick(3600);
    expect(running(summary)).toBe(0);
    expect(frames.size).toBe(0);

    // Counts of the new period also stop when the page replaces the view.
    period.value = period.options[0]?.value as string;
    period.dispatchEvent(new Event("change"));
    showAll();
    tick(4000);
    expect(running(summary)).toBe(4);
    [...root.querySelectorAll("button")].find((button) => button.textContent === "Salir de la demo")?.click();
    expect(frames.size).toBe(0);
    expect(running(summary)).toBe(0);
  });
});
