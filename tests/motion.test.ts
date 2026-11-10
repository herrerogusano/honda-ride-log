// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatNumber } from "../src/domain/format";
import { barChart } from "../src/ui/charts";
import { countUp, durationToken, MAX_STAGGER, prefersReducedMotion, reveal } from "../src/ui/motion";
import { sectionHeader } from "../src/ui/sectionHeader";
import { createTabs } from "../src/ui/tabs";

/**
 * Motion helpers in jsdom, with a hand-driven IntersectionObserver and
 * animation-frame queue. They prove the contract (when things start, what
 * the text is at each moment, that cancelling leaves the final state), not
 * how anything looks in a browser.
 */
const format = (value: number): string => `${formatNumber(value)} km`;

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
  /** Reports these targets as on screen, in one batch. */
  show(...targets: Element[]): void {
    const entries = targets.map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry);
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
/** Runs the frames waiting now, at time `at`. */
function tick(at: number): void {
  const waiting = [...frames.entries()];
  frames.clear();
  for (const [, callback] of waiting) callback(at);
}

function installMotion(reduced = false): void {
  FakeObserver.all = [];
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query }));
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

beforeEach(() => {
  document.body.replaceChildren();
  setHidden(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("without IntersectionObserver (jsdom) or with reduced motion", () => {
  it("shows every revealed element and the final figure at once, asking for no frame", () => {
    const frame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", frame);
    const root = document.createElement("div");
    root.className = "rv";
    root.append(Object.assign(document.createElement("p"), { className: "rv" }));
    reveal(root);
    expect([root, root.firstElementChild].map((one) => one?.classList.contains("in"))).toEqual([true, true]);
    const value = document.createElement("span");
    countUp(value, 6753, format);
    expect(value.textContent).toBe("6.753 km");
    expect(value.querySelector("[aria-hidden]")).toBeNull();
    expect(frame).not.toHaveBeenCalled();
  });

  it("does the same when the user asks for reduced motion, even with an observer", () => {
    installMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    const root = document.createElement("div");
    root.append(Object.assign(document.createElement("p"), { className: "rv" }));
    reveal(root);
    const value = document.createElement("span");
    countUp(value, 120, format);
    expect(root.firstElementChild?.classList.contains("in")).toBe(true);
    expect(value.textContent).toBe("120 km");
    expect(FakeObserver.all).toHaveLength(0);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});

describe("reveal", () => {
  beforeEach(() => installMotion());

  it("adds .in once, when on screen, with a stagger index per batch, and stops watching", () => {
    const root = document.createElement("div");
    const items = Array.from({ length: 12 }, () => Object.assign(document.createElement("section"), { className: "rv" }));
    root.append(...items);
    reveal(root);
    const observer = FakeObserver.all[0] as FakeObserver;
    expect(observer.targets.size).toBe(12);
    expect(items.some((item) => item.classList.contains("in"))).toBe(false);
    observer.show(items[3] as Element, items[4] as Element);
    expect(items.map((item) => item.classList.contains("in")).filter(Boolean)).toHaveLength(2);
    expect([items[3]?.style.getPropertyValue("--d"), items[4]?.style.getPropertyValue("--d")]).toEqual(["0", "1"]);
    expect(observer.targets.has(items[3] as Element)).toBe(false);
    // A long batch never waits more than MAX_STAGGER steps: the 10 others get 0, 1, ... 8, 8.
    observer.show(...items.filter((_, index) => index !== 3 && index !== 4));
    expect(items.filter((_, index) => index !== 3 && index !== 4).map((item) => item.style.getPropertyValue("--d"))).toEqual(
      ["0", "1", "2", "3", "4", "5", "6", "7", "8", "8"],
    );
    expect(MAX_STAGGER).toBe(8);
    expect(observer.targets.size).toBe(0);
  });

  it("stops watching on abort and leaves everything visible", () => {
    const root = document.createElement("div");
    root.append(Object.assign(document.createElement("div"), { className: "rv" }), Object.assign(document.createElement("div"), { className: "rv in" }));
    const controller = new AbortController();
    reveal(root, { signal: controller.signal });
    const observer = FakeObserver.all[0] as FakeObserver;
    // Already revealed elements are not watched again.
    expect(observer.targets.size).toBe(1);
    controller.abort();
    expect(observer.disconnected).toBe(true);
    expect([...root.children].every((child) => child.classList.contains("in"))).toBe(true);
  });
});

describe("countUp", () => {
  beforeEach(() => installMotion());

  function mounted(value: number, durationMs = 800): { element: HTMLElement; dispose: () => void; observer: FakeObserver } {
    const element = document.createElement("span");
    document.body.append(element);
    const dispose = countUp(element, value, format, { durationMs });
    return { element, dispose, observer: FakeObserver.all.at(-1) as FakeObserver };
  }
  const final = (element: HTMLElement): string => element.querySelector(".cu-final")?.textContent ?? "";
  const shown = (element: HTMLElement): string | null => element.querySelector(".cu-anim")?.textContent ?? null;

  it("waits until the figure is on screen, then counts up with frames and ends on the exact text", () => {
    const { element, observer } = mounted(6753);
    expect(element.textContent).toBe("6.753 km");
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    observer.show(element);
    expect(observer.disconnected).toBe(true);
    // The exact value stays in the element for screen readers; the passing digits are hidden from them.
    expect(final(element)).toBe("6.753 km");
    expect(element.querySelector(".cu-anim")?.getAttribute("aria-hidden")).toBe("true");
    expect(element.classList.contains("counting")).toBe(true);
    tick(1000);
    tick(1200);
    const middle = Number((shown(element) ?? "").replace(/\D/g, ""));
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(6753);
    tick(1500);
    tick(1800);
    expect(shown(element)).toBeNull();
    expect(element.classList.contains("counting")).toBe(false);
    expect(element.textContent).toBe("6.753 km");
    expect(frames.size).toBe(0);
  });

  it("goes to the final text when cancelled, when its signal aborts or when the tab is hidden", () => {
    const first = mounted(500);
    first.observer.show(first.element);
    tick(10);
    first.dispose();
    expect([first.element.textContent, frames.size, first.element.classList.contains("counting")]).toEqual(["500 km", 0, false]);
    expect(cancelAnimationFrame).toHaveBeenCalled();

    const controller = new AbortController();
    const element = document.createElement("span");
    countUp(element, 42, format, { signal: controller.signal });
    const observer = FakeObserver.all.at(-1) as FakeObserver;
    observer.show(element);
    tick(10);
    controller.abort();
    expect([element.textContent, frames.size]).toEqual(["42 km", 0]);

    const third = mounted(900);
    third.observer.show(third.element);
    tick(10);
    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect([third.element.textContent, frames.size]).toEqual(["900 km", 0]);
  });

  it("does not start while the observer reports the figure off screen", () => {
    const { element, observer } = mounted(250);
    const away = [{ target: element, isIntersecting: false }] as unknown as IntersectionObserverEntry[];
    observer.callback(away, observer as unknown as IntersectionObserver);
    expect([observer.disconnected, element.querySelector(".cu-anim"), frames.size]).toEqual([false, null, 0]);
    observer.show(element);
    expect(element.querySelector(".cu-anim")).not.toBeNull();
  });

  it("does not start in a hidden tab, and does not count zero", () => {
    setHidden(true);
    const hidden = mounted(300);
    hidden.observer.show(hidden.element);
    expect(hidden.element.textContent).toBe("300 km");
    expect(hidden.element.querySelector(".cu-anim")).toBeNull();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    setHidden(false);
    const zero = document.createElement("span");
    const before = FakeObserver.all.length;
    countUp(zero, 0, format);
    expect([zero.textContent, FakeObserver.all.length]).toEqual(["0 km", before]);
  });
});

describe("durationToken", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("reads milliseconds and seconds from the stylesheet token, and falls back on anything else", () => {
    const root = document.documentElement.style;
    root.setProperty("--dur-test", "520ms");
    expect(durationToken("--dur-test", 1)).toBe(520);
    root.setProperty("--dur-test", ".8s");
    expect(durationToken("--dur-test", 1)).toBe(800);
    root.setProperty("--dur-test", "fast");
    expect(durationToken("--dur-test", 7)).toBe(7);
    expect(durationToken("--dur-missing", 9)).toBe(9);
  });
});

describe("section header", () => {
  it("draws the number, the tag and one clipped box per title line, readable as one sentence", () => {
    const header = sectionHeader("01", "Resumen", ["Tu año", "en cifras"], "h-1");
    expect(header.element.querySelector(".sec-num")?.textContent).toBe("01");
    expect(header.element.querySelector(".sec-tag")?.textContent).toBe("01 Resumen");
    expect(header.heading.id).toBe("h-1");
    expect(header.heading.textContent).toBe("Tu año en cifras");
    expect([...header.heading.querySelectorAll(".ln > .ln-in")].map((line) => line.textContent)).toEqual(["Tu año", "en cifras"]);
    expect([...header.heading.querySelectorAll(".ln")].map((line) => (line as HTMLElement).style.getPropertyValue("--l"))).toEqual(["0", "1"]);
    expect(header.element.classList.contains("rv")).toBe(true);
    header.setTitle(["Todo", "en cifras"]);
    expect(header.heading.textContent).toBe("Todo en cifras");
    expect(header.heading.querySelectorAll(".ln")).toHaveLength(2);
  });
});

describe("tab underline", () => {
  it("is one decorative element that follows the selected tab", () => {
    const tabs = createTabs("Secciones", [
      { id: "a", label: "A", panel: document.createElement("div") },
      { id: "b", label: "B", panel: document.createElement("div") },
    ]);
    document.body.append(tabs.element);
    const [first, second] = [...tabs.element.querySelectorAll<HTMLElement>('[role="tab"]')] as [HTMLElement, HTMLElement];
    Object.defineProperties(first, { offsetLeft: { value: 0 }, offsetWidth: { value: 80 } });
    Object.defineProperties(second, { offsetLeft: { value: 104 }, offsetWidth: { value: 64 } });
    const inks = tabs.element.querySelectorAll<HTMLElement>(".tab-ink");
    expect(inks).toHaveLength(1);
    const ink = inks[0] as HTMLElement;
    expect(ink.getAttribute("aria-hidden")).toBe("true");
    tabs.select("b");
    expect([ink.style.getPropertyValue("--ink-x"), ink.style.getPropertyValue("--ink-w")]).toEqual(["104px", "64"]);
    tabs.select("a");
    expect([ink.style.getPropertyValue("--ink-x"), ink.style.getPropertyValue("--ink-w")]).toEqual(["0px", "80"]);
  });
});

describe("chart colours and bar growth", () => {
  it("gives each year its tone on bars and legend, and each bar its stagger index", () => {
    const chart = barChart({
      title: "Km por mes",
      categories: ["a", "b"],
      categoryHeader: "Mes",
      series: [
        { label: "2025", values: [1, 2], tone: "tone-prev" },
        { label: "2026", values: [3, 0], tone: "tone-now" },
      ],
      formatValue: String,
    });
    expect([...chart.querySelectorAll("rect")].map((bar) => [bar.getAttribute("class"), bar.style.getPropertyValue("--i")])).toEqual([
      ["chart-bar series-0 tone-prev", "0"],
      ["chart-bar series-1 tone-now", "0"],
      ["chart-bar series-0 tone-prev", "1"],
    ]);
    expect([...chart.querySelectorAll(".chart-key")].map((key) => key.getAttribute("class"))).toEqual([
      "chart-key series-0 tone-prev",
      "chart-key series-1 tone-now",
    ]);
    expect(chart.classList.contains("rv")).toBe(true);
    const single = barChart({ title: "x", categories: ["a", "b", "c"], categoryHeader: "x", series: [{ label: "x", values: [2, 5, 5] }], formatValue: String });
    expect([...single.querySelectorAll("rect")].map((bar) => bar.classList.contains("peak"))).toEqual([false, true, true]);
  });
});
