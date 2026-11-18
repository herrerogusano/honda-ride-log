// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Route } from "../src/domain/model";
import type { RiderData } from "../src/ui/data";
import { createRouteList, NARROW_LIST, toggleLabel, type RouteList } from "../src/ui/routesView";
import { rides } from "./helpers";

/**
 * The list of «04 Rutas» folded behind «Ver las N rutas» on narrow screens
 * (docs/PLAN.md, section 13). jsdom with a hand-driven `matchMedia`: it
 * proves the contract as we read it (state, attributes, focus, no scroll),
 * not what a browser draws; the stylesheet rules are read as text.
 */
const NOW = Date.parse("2026-11-09T20:00:00.000Z");

let narrow = true;
let listeners: { fn: () => void; signal: AbortSignal | undefined }[] = [];

function setWidth(isNarrow: boolean): void {
  narrow = isNarrow;
  for (const one of listeners) if (one.signal?.aborted !== true) one.fn();
}

beforeEach(() => {
  narrow = true;
  listeners = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === NARROW_LIST ? narrow : false;
    },
    media: query,
    addEventListener: (_type: string, fn: () => void, options?: AddEventListenerOptions) => void listeners.push({ fn, signal: options?.signal }),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const many = (length: number): Route[] =>
  rides(Array.from({ length }, (_, index) => ({ start: new Date(Date.parse("2025-01-01T20:00:00Z") + index * 86_400_000).toISOString(), km: 1 + (index % 7) })));

const data = (routes: readonly Route[]): RiderData => ({
  vehicle: { status: null, batteryPercent: null, lastCommunicationMs: null, odometer: null },
  info: null,
  routes,
  figures: routes,
  hiddenShort: 0,
  shortCounted: false,
  skipped: 0,
  demo: false,
  nowMs: NOW,
});

function show(routes: readonly Route[], signal?: AbortSignal): RouteList {
  const list = createRouteList(data(routes), () => undefined, { visibleTop: () => 0, signal });
  document.body.replaceChildren(list.element);
  return list;
}

const toggle = (): HTMLButtonElement => document.querySelector(".routes-toggle") as HTMLButtonElement;
const panel = (): HTMLElement => document.querySelector(".route-list-panel") as HTMLElement;
/** Folded as the user sees it: the panel is hidden. */
const isFolded = (): boolean => panel().hidden === true;

describe("the button's text", () => {
  it("counts every route in Spanish format, and says how to close", () => {
    expect(toggleLabel(1234, false)).toBe("Ver las 1.234 rutas");
    expect(toggleLabel(12, false)).toBe("Ver las 12 rutas");
    expect(toggleLabel(1, false)).toBe("Ver la ruta");
    expect(toggleLabel(12, true)).toBe("Ocultar las rutas");
    expect(toggleLabel(1, true)).toBe("Ocultar la ruta");
  });
});

describe("folding the list", () => {
  it("starts folded behind a real button that names the panel it controls", () => {
    show(many(250));
    const button = toggle();
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(button.getAttribute("aria-controls") ?? "")).toBe(panel());
    expect(panel().querySelector(".routes-table")).not.toBeNull();
    expect(button.textContent).toBe("Ver las 250 rutas");
    expect(button.hidden).toBe(false);
    expect(isFolded()).toBe(true);
  });

  it("on wide screens shows the list and no button", () => {
    narrow = false;
    show(many(3));
    expect(toggle().hidden).toBe(true);
    expect(isFolded()).toBe(false);
  });

  it("opens and closes on each press, keeping the focus on the button", () => {
    show(many(3));
    toggle().focus();
    toggle().click();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().textContent).toBe("Ocultar las rutas");
    expect(isFolded()).toBe(false);
    toggle().click();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toBe("Ver las 3 rutas");
    expect(isFolded()).toBe(true);
    expect(document.activeElement).toBe(toggle());
  });

  it("counts the routes, not the ones the search leaves", () => {
    show(many(12));
    toggle().click();
    const input = document.querySelector<HTMLInputElement>('input[type="search"]') as HTMLInputElement;
    input.value = "no existe";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    toggle().click();
    expect(toggle().textContent).toBe("Ver las 12 rutas");
  });

  it("has no button for an account without routes", () => {
    show([]);
    expect(toggle()).toBeNull();
  });
});

describe("a route opened from elsewhere while the list is folded", () => {
  it("leaves the list folded and the page still, and marks the row for when it opens", () => {
    const routes = many(3);
    const list = show(routes);
    const onPage = vi.fn();
    vi.stubGlobal("scrollTo", onPage);
    const row = (document.querySelectorAll("tbody tr")[2] as HTMLElement);
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ top: 900, bottom: 960 } as DOMRect);
    // Newest first: the oldest route is the last row.
    list.mark(routes[0] as Route, true);
    expect(onPage).not.toHaveBeenCalled();
    expect(isFolded()).toBe(true);
    expect(row.classList.contains("is-chosen")).toBe(true);
    // Open, the same call brings the row into view as before.
    toggle().click();
    list.mark(routes[0] as Route, true);
    expect(onPage).toHaveBeenCalledTimes(1);
  });

  it("on wide screens the list is never folded: the row comes into view as before", () => {
    narrow = false;
    const routes = many(3);
    const list = show(routes);
    const onPage = vi.fn();
    vi.stubGlobal("scrollTo", onPage);
    vi.spyOn(document.querySelectorAll("tbody tr")[2] as HTMLElement, "getBoundingClientRect").mockReturnValue({ top: 900, bottom: 960 } as DOMRect);
    list.mark(routes[0] as Route, true);
    expect(onPage).toHaveBeenCalledTimes(1);
  });
});

describe("changing width", () => {
  it("opens the list when the screen narrows while the focus is in it, so the focus is never hidden", () => {
    narrow = false;
    show(many(3));
    (document.querySelector(".row-button") as HTMLButtonElement).focus();
    setWidth(true);
    expect(isFolded()).toBe(false);
    expect(toggle().hidden).toBe(false);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.classList.contains("row-button")).toBe(true);
  });

  it("keeps the user's choice across widths when the focus is elsewhere", () => {
    narrow = false;
    show(many(3));
    setWidth(true);
    expect(isFolded()).toBe(true);
    toggle().click();
    setWidth(false);
    expect(toggle().hidden).toBe(true);
    expect(isFolded()).toBe(false);
    setWidth(true);
    expect(isFolded()).toBe(false);
  });

  it("moves the focus to the list when the screen widens while it is on the button", () => {
    show(many(3));
    toggle().focus();
    setWidth(false);
    expect(toggle().hidden).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('input[type="search"]'));
  });

  it("stops watching the width when the view is released", () => {
    narrow = false;
    const released = new AbortController();
    show(many(3), released.signal);
    released.abort();
    setWidth(true);
    // Nobody listens any more: the released list is left as it was.
    expect(toggle().hidden).toBe(true);
    expect(isFolded()).toBe(false);
  });
});

describe("the stylesheet", () => {
  const css = readFileSync("src/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = (opening: string): string[] => {
    const found: string[] = [];
    for (let start = css.indexOf(opening); start >= 0; start = css.indexOf(opening, start + 1)) {
      let depth = 0;
      for (let index = css.indexOf("{", start); index < css.length; index += 1) {
        if (css[index] === "{") depth += 1;
        if (css[index] === "}" && --depth === 0) {
          found.push(css.slice(css.indexOf("{", start) + 1, index));
          break;
        }
      }
    }
    return found;
  };

  it("hides with `hidden` for good, adds no box to the wide layout and never folds on paper", () => {
    // The code hides the button and the panel with `hidden`; it must win over `.button`'s display.
    expect(css).toMatch(/\n\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
    expect(css).toMatch(/\n\.route-list-panel\s*\{\s*display:\s*contents;/);
    const print = blocks("@media only print").join("\n");
    expect(print).toMatch(/\.route-list\s*>\s*\.routes-toggle\s*\{\s*display:\s*none\s*!important;/);
    expect(print).toMatch(/\.route-list-panel\[hidden\]\s*\{\s*display:\s*contents\s*!important;/);
  });

  it("matches the width where the list stops having its own box", () => {
    // `.archive` goes side by side from 1024 px: the fold must end exactly there.
    expect(NARROW_LIST).toBe("(max-width: 1023px)");
    expect(blocks("@media (min-width: 1024px)").some((body) => /\.archive-list \.routes-scroll/.test(body))).toBe(true);
  });

  /** The declarations of `selector` inside a block's text, or null. */
  const rule = (body: string, selector: string): string | null => {
    const at = body.indexOf(`${selector} {`);
    return at < 0 ? null : body.slice(body.indexOf("{", at) + 1, body.indexOf("}", at));
  };
  const narrowScreen = (): string => blocks("@media only screen and (max-width: 1023px)").join("\n");

  it("on narrow screens puts the open list's rows in a box of their own, with room around it", () => {
    const box = rule(narrowScreen(), ".route-list:not(.is-folded) .routes-scroll");
    expect(box).not.toBeNull();
    // Its own scroll, a fixed height that fits under the bar and the pinned map, never more than 58svh.
    expect(box).toMatch(/overflow-y:\s*auto;/);
    expect(box).toMatch(/height:\s*clamp\(240px,\s*calc\(100svh - var\(--bar-h, 101px\) - var\(--map-h, 360px\) - 40px\),\s*58svh\);/);
    // At its ends the gesture goes on with the page; the sides stay outside it.
    expect(box).toMatch(/overscroll-behavior-y:\s*auto;/);
    expect(box).not.toMatch(/overscroll-behavior[^;]*:\s*(contain|none)/);
    expect(box).toMatch(/margin-inline:\s*22px;/);
  });

  it("keeps the box to narrow screens with the list open, and off paper", () => {
    // Folded, the panel is hidden; wide screens have their own box (`.archive-list .routes-scroll`).
    const outside = css.replace(/@media (only screen and \(max-width: 1023px\)|\(min-width: 1024px\))\s*\{[\s\S]*?\n\}/g, "");
    expect(outside).not.toMatch(/\.routes-scroll\s*\{[^}]*overflow-y:\s*auto/);
    expect(outside).not.toContain(":not(.is-folded) .routes-scroll");
    expect(blocks("@media (max-width: 1023px)").join("\n")).not.toMatch(/\.routes-scroll/);
  });

  it("does not pin the map over a folded list, where it covered «Ver las N rutas»", () => {
    expect(rule(narrowScreen(), ".archive:has(.route-list.is-folded) .archive-map")).toMatch(/position:\s*static;/);
  });
});

describe("the open list's box on narrow screens", () => {
  it("brings the row from «Ruta anterior / siguiente» into view inside the box, never moving the page", () => {
    const routes = many(30);
    const list = show(routes);
    toggle().click();
    const box = document.querySelector(".routes-scroll") as HTMLElement;
    // jsdom does not apply the stylesheet: the box is given its overflow and sizes by hand.
    box.style.overflowY = "auto";
    Object.defineProperty(box, "scrollHeight", { value: 3000 });
    Object.defineProperty(box, "clientHeight", { value: 300 });
    vi.spyOn(box, "getBoundingClientRect").mockReturnValue({ top: 400, bottom: 700 } as DOMRect);
    const inBox = vi.fn();
    box.scrollTo = inBox as typeof box.scrollTo;
    const onPage = vi.fn();
    vi.stubGlobal("scrollTo", onPage);
    const last = document.querySelectorAll("tbody tr")[29] as HTMLElement;
    vi.spyOn(last, "getBoundingClientRect").mockReturnValue({ top: 2900, bottom: 2960 } as DOMRect);
    list.mark(routes[0] as Route, true);
    expect(inBox).toHaveBeenCalledTimes(1);
    expect(onPage).not.toHaveBeenCalled();
  });
});

describe("the height of the screen", () => {
  it("never hides the button when the visible height changes (browser toolbars coming and going)", () => {
    show(many(3));
    const original = window.innerHeight;
    for (const height of [812, 700, 812]) {
      Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("scroll"));
      expect(toggle().hidden).toBe(false);
      expect(toggle().isConnected).toBe(true);
      expect(isFolded()).toBe(true);
    }
    Object.defineProperty(window, "innerHeight", { value: original, configurable: true });
  });
});
