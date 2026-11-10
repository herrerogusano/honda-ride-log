// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { maintenanceProgress } from "../src/domain/maintenance";
import { barChart, CHART_HINT } from "../src/ui/charts";
import type { RiderData } from "../src/ui/data";
import { reveal, REVEAL_SAFETY_MS } from "../src/ui/motion";
import { renderRiderPage } from "../src/ui/summary";
import { rides } from "./helpers";

/**
 * Stage 2, phase 4 (docs/PLAN.md, section 14): the maintenance figure and
 * bar, the chart columns that answer the pointer and the keyboard, the
 * years dimmed outside the period, and the safety nets of the reveal.
 * jsdom: the contract, not what a browser shows.
 */
const NOW = Date.parse("2026-11-09T12:00:00-08:00");
const LIST = rides([
  { start: "2025-11-10T08:00:00-08:00", km: 30 },
  { start: "2026-03-08T12:00:00-07:00", km: 50 },
  { start: "2026-11-08T09:00:00-08:00", km: 7 },
]);
const NB = String.fromCharCode(0xa0);

function data(overrides: Partial<RiderData> = {}): RiderData {
  return {
    vehicle: { status: null, batteryPercent: 50, lastCommunicationMs: null, odometer: 15500 },
    info: null,
    routes: LIST,
    figures: LIST,
    hiddenShort: 0,
    shortCounted: false,
    skipped: 0,
    demo: true,
    nowMs: NOW,
    ...overrides,
  };
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function page(overrides: Partial<RiderData> = {}): HTMLElement {
  const made = renderRiderPage(data(overrides), "demo");
  const view = document.createElement("div");
  view.append(...[made.period, made.hero, ...made.sections.map((one) => one.element), made.footer].filter((part) => part !== null));
  document.body.replaceChildren(view);
  return view;
}

describe("maintenance as a big figure and a bar", () => {
  function submit(view: HTMLElement, interval: string, last: string): void {
    const [a, b] = [...view.querySelectorAll<HTMLInputElement>("form.maintenance input")] as [HTMLInputElement, HTMLInputElement];
    a.value = interval;
    b.value = last;
    view.querySelector("form.maintenance")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }
  const figure = (view: HTMLElement): HTMLElement => view.querySelector(".maint-figure") as HTMLElement;

  it("says how much is left in a big figure, fills the bar with the share of the interval ridden, and the sentence stays the status", () => {
    const view = page();
    expect(figure(view).hidden).toBe(true);
    submit(view, "6000", "10000");
    expect(figure(view).hidden).toBe(false);
    expect(figure(view).getAttribute("aria-hidden")).toBe("true");
    expect(figure(view).querySelector(".maint-kicker")?.textContent).toBe("Te faltan");
    expect(figure(view).querySelector(".maint-value")?.textContent).toBe(`500${NB}km`);
    expect((figure(view).querySelector(".maint-fill") as HTMLElement).style.getPropertyValue("--v")).toBe((5500 / 6000).toFixed(4));
    expect(figure(view).classList.contains("fill")).toBe(true);
    expect(view.querySelector(".maintenance-result")?.getAttribute("role")).toBe("status");
    submit(view, "5000", "10000");
    expect([figure(view).querySelector(".maint-kicker")?.textContent, figure(view).classList.contains("over")]).toEqual(["Te has pasado", true]);
    expect((figure(view).querySelector(".maint-fill") as HTMLElement).style.getPropertyValue("--v")).toBe("1.0000");
    submit(view, "", "");
    expect(figure(view).hidden).toBe(true);
  });

  it("works out the share ridden, from empty to full", () => {
    expect(maintenanceProgress({ intervalKm: 6000, lastServiceKm: 10000 }, 13000)).toBe(0.5);
    expect(maintenanceProgress({ intervalKm: 6000, lastServiceKm: 10000 }, 17000)).toBe(1);
    expect(maintenanceProgress({ intervalKm: 6000, lastServiceKm: 10000 }, 9000)).toBe(0);
  });
});

describe("chart columns", () => {
  const chart = (): HTMLElement =>
    barChart({
      title: "Km por mes",
      categories: ["ene", "feb", "mar"],
      categoryNames: ["enero", "febrero", "marzo"],
      categoryHeader: "Mes",
      series: [
        { label: "2025", values: [10, 0, 30] },
        { label: "2026", values: [20, 5, 0] },
      ],
      formatValue: (value) => `${value} km`,
    });

  it("gives every category a column with the same figures as its accessible name, one tab stop, on the tallest", () => {
    const figure = chart();
    const columns = [...figure.querySelectorAll<HTMLElement>(".chart-col")];
    expect(columns.map((one) => one.getAttribute("aria-label"))).toEqual(["enero: 2025, 10 km; 2026, 20 km", "febrero: 2025, 0 km; 2026, 5 km", "marzo: 2025, 30 km; 2026, 0 km"]);
    expect(columns.map((one) => one.tabIndex)).toEqual([-1, -1, 0]);
    expect(columns.map((one) => one.style.getPropertyValue("--x") !== "")).toEqual([true, true, true]);
  });

  it("lights the bars of the category under the pointer, writes its figures in the readout, and moves with the arrows", () => {
    const figure = chart();
    document.body.append(figure);
    const readout = figure.querySelector(".chart-readout") as HTMLElement;
    expect(readout.textContent).toBe(CHART_HINT);
    const columns = [...figure.querySelectorAll<HTMLElement>(".chart-col")];
    columns[0]?.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(readout.textContent).toBe("enero · 2025: 10 km · 2026: 20 km");
    const svg = figure.querySelector("svg") as SVGSVGElement;
    expect(svg.classList.contains("hot")).toBe(true);
    expect([...svg.querySelectorAll(".chart-bar.on")].map((bar) => bar.getAttribute("data-c"))).toEqual(["0", "0"]);
    columns[2]?.focus();
    columns[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement).toBe(columns[1]);
    expect(readout.textContent).toBe("febrero · 2025: 0 km · 2026: 5 km");
    expect(columns.map((one) => one.tabIndex)).toEqual([-1, 0, -1]);
    columns[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(columns[0]);
  });

  it("dims, in the 12-month chart, the years outside the chosen period, and none for the whole history", () => {
    const view = page();
    const months = [...view.querySelectorAll<HTMLElement>("figure.chart-dual")][0] as HTMLElement;
    const dimmed = (): string[] => [...new Set([...months.querySelectorAll(".dim")].map((one) => one.getAttribute("data-series") ?? ""))];
    expect(dimmed()).toEqual(["2025"]);
    (view.querySelector('.period-control input[value="2025"]') as HTMLInputElement).click();
    expect(dimmed()).toEqual(["2026"]);
    (view.querySelector('.period-control input[value="all"]') as HTMLInputElement).click();
    expect(dimmed()).toEqual([]);
  });
});

describe("safety nets of the reveal", () => {
  class SilentObserver {
    static all: SilentObserver[] = [];
    disconnected = false;
    constructor(readonly callback: IntersectionObserverCallback) {
      SilentObserver.all.push(this);
    }
    observe(): void {
      // Never answers: a context that does not render.
    }
    unobserve(): void {
      // Nothing watched.
    }
    disconnect(): void {
      this.disconnected = true;
    }
  }
  beforeEach(() => {
    SilentObserver.all = [];
    vi.stubGlobal("IntersectionObserver", SilentObserver);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
  });
  const parts = (): HTMLElement => {
    const root = document.createElement("div");
    root.append(...[1, 2, 3].map(() => Object.assign(document.createElement("p"), { className: "rv" })));
    document.body.append(root);
    return root;
  };

  it("shows everything if the observer never answers in a visible tab", () => {
    vi.useFakeTimers();
    const root = parts();
    reveal(root);
    vi.advanceTimersByTime(REVEAL_SAFETY_MS - 1);
    expect(root.querySelectorAll(".rv.in")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(root.querySelectorAll(".rv:not(.in)")).toHaveLength(0);
    expect(SilentObserver.all.every((one) => one.disconnected)).toBe(true);
  });

  it("does not fire when the observer did answer, and waits while the tab is hidden", () => {
    vi.useFakeTimers();
    const root = parts();
    reveal(root);
    SilentObserver.all[0]?.callback([], SilentObserver.all[0] as unknown as IntersectionObserver);
    vi.advanceTimersByTime(REVEAL_SAFETY_MS * 2);
    expect(root.querySelectorAll(".rv.in")).toHaveLength(0);

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    const hiddenRoot = parts();
    reveal(hiddenRoot);
    vi.advanceTimersByTime(REVEAL_SAFETY_MS * 2);
    expect(hiddenRoot.querySelectorAll(".rv.in")).toHaveLength(0);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(REVEAL_SAFETY_MS);
    expect(hiddenRoot.querySelectorAll(".rv:not(.in)")).toHaveLength(0);
  });

  it("shows everything before printing, and leaves no timer or listener once the view goes", () => {
    vi.useFakeTimers();
    const root = parts();
    reveal(root);
    window.dispatchEvent(new Event("beforeprint"));
    expect(root.querySelectorAll(".rv:not(.in)")).toHaveLength(0);

    const later = parts();
    const view = new AbortController();
    reveal(later, { signal: view.signal });
    view.abort();
    expect(vi.getTimerCount()).toBe(0);
    later.querySelectorAll(".rv").forEach((one) => one.classList.remove("in"));
    window.dispatchEvent(new Event("beforeprint"));
    expect(later.querySelectorAll(".rv.in")).toHaveLength(0);
  });
});
