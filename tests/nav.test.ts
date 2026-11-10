// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sectionNav, type NavSection } from "../src/ui/nav";
import { sectionHeader } from "../src/ui/sectionHeader";

/**
 * The section links of the top bar in jsdom, with a hand-driven
 * IntersectionObserver, ResizeObserver, frame queue and `scrollTo`. jsdom
 * lays nothing out, so every box is given by the test: this proves the
 * wiring (what is scrolled to, focused, marked, replayed and released), not
 * what a browser shows. The browser checks are in docs/PLAN.md, section 12.
 */
class FakeObserver {
  static all: FakeObserver[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
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
  report(target: Element, isIntersecting: boolean): void {
    this.callback([{ target, isIntersecting } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

class FakeResize {
  static live = 0;
  observe(): void {
    FakeResize.live += 1;
  }
  disconnect(): void {
    FakeResize.live -= 1;
  }
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
function tick(at = 0): void {
  const waiting = [...frames.values()];
  frames.clear();
  for (const callback of waiting) callback(at);
}
let scrolled: ScrollToOptions[];
let reduced: boolean;
/** Each test releases its navigation, so no listener of one test answers in the next. */
let testScope: AbortController;

function install(): void {
  FakeObserver.all = [];
  FakeResize.live = 0;
  frames = new Map();
  nextFrame = 0;
  scrolled = [];
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
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query }));
  vi.stubGlobal("scrollTo", vi.fn((options: ScrollToOptions) => void scrolled.push(options)));
  // jsdom has no `scrollend`; the browsers this page targets do (Chrome 114+, Firefox 109+).
  Reflect.set(window, "onscrollend", null);
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 10_000 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
}

/** Three sections whose tops are at 1000, 2000 and 3000 px of the page, their headers 120 px lower (the top padding), scrolled to the top. */
function build(signal?: AbortSignal): { nav: ReturnType<typeof sectionNav>; sections: NavSection[]; links: HTMLButtonElement[]; ink: HTMLElement } {
  const names = [
    ["resumen", "Resumen"],
    ["ritmo", "Ritmo"],
    ["taller", "Taller"],
  ] as const;
  const sections = names.map(([id, label], index) => {
    const header = sectionHeader(`0${index + 1}`, label, ["Uno", "dos"], `h-${id}`);
    const element = document.createElement("section");
    element.append(header.element);
    document.body.append(element);
    const top = 1000 * (index + 1);
    vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => ({ top: top - window.scrollY, bottom: top + 900 - window.scrollY }) as DOMRect);
    vi.spyOn(header.element, "getBoundingClientRect").mockImplementation(() => ({ top: top + 120 - window.scrollY, bottom: top + 320 - window.scrollY }) as DOMRect);
    return { id, label, element, header };
  });
  const nav = sectionNav(sections, { signal: signal ?? testScope.signal, offset: () => 64 });
  document.body.prepend(nav.progress, nav.element);
  const links = [...nav.element.querySelectorAll<HTMLButtonElement>("button")];
  links.forEach((link, index) => Object.defineProperties(link, { offsetLeft: { value: index * 100 }, offsetWidth: { value: 80 + index } }));
  return { nav, sections, links, ink: nav.element.querySelector(".nav-ink") as HTMLElement };
}

function setScroll(y: number): void {
  Object.defineProperty(window, "scrollY", { configurable: true, value: y });
}

beforeEach(() => {
  document.body.replaceChildren();
  testScope = new AbortController();
  install();
  setScroll(0);
});

afterEach(() => {
  testScope.abort();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "onscrollend");
  Reflect.deleteProperty(document.documentElement, "scrollHeight");
  Reflect.deleteProperty(window, "scrollY");
});

describe("section links", () => {
  it("builds one button per section, named as a navigation, with one decorative underline and a progress bar", () => {
    const { nav, links } = build();
    expect(nav.element.tagName).toBe("NAV");
    expect(nav.element.getAttribute("aria-label")).toBe("Secciones");
    expect(links.map((link) => [link.textContent, link.type, link.dataset["section"]])).toEqual([
      ["Resumen", "button", "resumen"],
      ["Ritmo", "button", "ritmo"],
      ["Taller", "button", "taller"],
    ]);
    expect(nav.element.querySelectorAll(".nav-ink")).toHaveLength(1);
    expect(nav.element.querySelector(".nav-ink")?.getAttribute("aria-hidden")).toBe("true");
    expect(nav.progress.getAttribute("aria-hidden")).toBe("true");
    // Nothing is current at the top of the page.
    expect(nav.current()).toBeNull();
    expect(links.some((link) => link.hasAttribute("aria-current"))).toBe(false);
  });

  it("scrolls smoothly to bring the section header just below the bar, focuses its title and marks its link, without the address", () => {
    const { nav, sections, links, ink } = build();
    const before = location.href;
    links[1]?.click();
    expect(scrolled).toEqual([{ top: 2120 - 64 - 16, behavior: "smooth" }]);
    expect(document.activeElement).toBe(sections[1]?.header.heading);
    expect(nav.current()).toBe("ritmo");
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual([null, "true", null]);
    expect([ink.style.getPropertyValue("--ink-x"), ink.style.getPropertyValue("--ink-w")]).toEqual(["100px", "81"]);
    expect(ink.classList.contains("off")).toBe(false);
    expect(location.href).toBe(before);
  });

  it("replays the entrance of the section when the scroll ends there, with the red rule, and only then", () => {
    const { sections, links } = build();
    const header = sections[2]?.header.element as HTMLElement;
    header.classList.add("in");
    links[2]?.click();
    // Still on its way: nothing replays off screen.
    expect(header.classList.contains("replay")).toBe(false);
    setScroll(3000 - 80);
    window.dispatchEvent(new Event("scrollend"));
    expect([...header.classList]).toEqual(["sec-head", "rv", "in", "replay", "sweep"]);
    // The end of another scroll later replays nothing more.
    header.classList.remove("replay", "sweep");
    window.dispatchEvent(new Event("scrollend"));
    expect(header.classList.contains("replay")).toBe(false);
  });

  it("does not replay a section that the scroll left off screen (the user scrolled away)", () => {
    const { sections, links } = build();
    links[2]?.click();
    setScroll(0);
    window.dispatchEvent(new Event("scrollend"));
    expect(sections[2]?.header.element.classList.contains("replay")).toBe(false);
  });

  it("replays at once when the section is already where the link would bring it, or as far as the page can scroll", () => {
    const { sections, links } = build();
    setScroll(1120 - 80);
    links[0]?.click();
    expect(scrolled).toEqual([]);
    expect(sections[0]?.header.element.classList.contains("sweep")).toBe(true);
    // The page ends before the last section can reach the bar: it scrolls to the end and arrives there.
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 3500 });
    setScroll(3500 - 800);
    links[2]?.click();
    expect(scrolled).toEqual([]);
    expect(sections[2]?.header.element.classList.contains("sweep")).toBe(true);
  });

  it("jumps without smoothness and replays nothing with reduced motion", () => {
    reduced = true;
    const { sections, links } = build();
    links[1]?.click();
    expect(scrolled).toEqual([{ top: 2120 - 64 - 16, behavior: "instant" }]);
    expect(document.activeElement).toBe(sections[1]?.header.heading);
    expect(sections[1]?.header.element.classList.contains("replay")).toBe(false);
  });

  it("waits for a few still frames where the browser has no scrollend", () => {
    Reflect.deleteProperty(window, "onscrollend");
    const { sections, links } = build();
    links[1]?.click();
    const header = sections[1]?.header.element as HTMLElement;
    setScroll(500);
    tick();
    setScroll(1920);
    // The frame that sees the change, then five still ones: not yet.
    for (let frame = 0; frame < 6; frame += 1) tick();
    expect(header.classList.contains("replay")).toBe(false);
    tick();
    expect(header.classList.contains("replay")).toBe(true);
  });
});

describe("scroll spy", () => {
  it("marks the section that crosses a line at a third of the screen, and none above the first", () => {
    const { nav, sections, links } = build();
    const spy = FakeObserver.all.find((observer) => observer.targets.size === 3) as FakeObserver;
    // A thin band at 35 % of the screen height.
    expect(spy.options?.rootMargin).toBe("-35% 0px -64% 0px");
    spy.report(sections[0]?.element as Element, true);
    expect(nav.current()).toBe("resumen");
    spy.report(sections[0]?.element as Element, false);
    spy.report(sections[1]?.element as Element, true);
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual([null, "true", null]);
    // Below the last section (the footer), the last one stays current.
    spy.report(sections[1]?.element as Element, false);
    setScroll(5000);
    spy.report(sections[2]?.element as Element, true);
    spy.report(sections[2]?.element as Element, false);
    expect(nav.current()).toBe("taller");
    // Back at the top (the hero), nothing is current and the underline fades.
    setScroll(0);
    spy.report(sections[0]?.element as Element, false);
    expect(nav.current()).toBeNull();
    expect(nav.element.querySelector(".nav-ink")?.classList.contains("off")).toBe(true);
  });

  it("clears the mark after a jump from the footer to the hero, which crosses no section on the line", () => {
    const { nav, sections } = build();
    const spy = FakeObserver.all.find((observer) => observer.targets.size === 3) as FakeObserver;
    setScroll(5000);
    spy.report(sections[2]?.element as Element, true);
    spy.report(sections[2]?.element as Element, false);
    expect(nav.current()).toBe("taller");
    // One jump to the top: the observer says nothing; the next scroll frame looks.
    setScroll(0);
    window.dispatchEvent(new Event("scroll"));
    expect(nav.current()).toBe("taller");
    tick();
    expect(nav.current()).toBeNull();
  });

  it("does not let the sections a link scrolls past take the mark", () => {
    const { nav, sections, links } = build();
    const spy = FakeObserver.all.find((observer) => observer.targets.size === 3) as FakeObserver;
    links[2]?.click();
    spy.report(sections[0]?.element as Element, true);
    spy.report(sections[1]?.element as Element, true);
    expect(nav.current()).toBe("taller");
    setScroll(2920);
    window.dispatchEvent(new Event("scrollend"));
    spy.report(sections[0]?.element as Element, false);
    spy.report(sections[1]?.element as Element, false);
    spy.report(sections[2]?.element as Element, true);
    expect(nav.current()).toBe("taller");
  });
});

describe("reading progress", () => {
  it("is painted in one frame per burst of scrolling, never without one", () => {
    const { nav } = build();
    expect(frames.size).toBe(0);
    setScroll(4600);
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(1);
    tick();
    expect(nav.progress.style.getPropertyValue("--progress")).toBe("0.5000");
    expect(frames.size).toBe(0);
  });
});

describe("release", () => {
  it("stops the spy, the size observer, the frames and every listener when its signal aborts", () => {
    const controller = new AbortController();
    const { nav, sections, links } = build(controller.signal);
    expect(FakeResize.live).toBe(1);
    links[1]?.click();
    setScroll(100);
    window.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBeGreaterThan(0);
    const removed = vi.spyOn(window, "removeEventListener");
    controller.abort();
    expect(FakeObserver.all.every((observer) => observer.disconnected)).toBe(true);
    expect(FakeResize.live).toBe(0);
    expect(frames.size).toBe(0);
    expect(removed.mock.calls.map((call) => call[0]).sort()).toEqual(["scroll", "scrollend"]);
    // Nothing answers any more: a scroll asks for no frame, the end of the scroll replays nothing.
    window.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(0);
    setScroll(1920);
    window.dispatchEvent(new Event("scrollend"));
    expect(sections[1]?.header.element.classList.contains("replay")).toBe(false);
    expect(nav.progress.style.getPropertyValue("--progress")).toBe("");
  });

  it("asks for nothing when its signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    build(controller.signal);
    expect(FakeObserver.all.every((observer) => observer.disconnected)).toBe(true);
    expect(FakeResize.live).toBe(0);
    window.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(0);
  });
});
