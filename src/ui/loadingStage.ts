/**
 * The first load of a rider's data as an instrument cluster booting
 * (docs/PLAN.md, section 14): a dark first screen with, bottom left, the
 * red slanted tag holding the year being read, a huge counter of the routes
 * loaded so far with its small red unit, the status line and the tick
 * ruler of the readout strip. The house scan line sweeps the stage while it
 * waits.
 *
 * Honest instruments: the total is unknown (the load stops at the first
 * year without routes), so there is no percentage. The counter shows the
 * real number reported by the loader; a short run of red ticks moves one
 * step along the ruler per request that completes.
 *
 * When the data is ready, `handOff` lays the stage over the new page and a
 * red wedge wipes across it and settles where the hero's wedge lives, while
 * the hero's title rises beneath; then the stage goes. On a failure the
 * page simply puts the error panel in its place.
 *
 * Only classes, custom properties and `countUp`; the stylesheet moves
 * things with transform and opacity and the motion tokens. With reduced
 * motion (or without IntersectionObserver) the figure and the year just
 * change, nothing sweeps, flips or wipes. `signal` stops everything.
 */
import { formatNumber } from "../domain/format";
import { el } from "./dom";
import { canAnimate, countUp, durationToken, scanLine } from "./motion";

/** Steps of the ruler run per lap: after this many requests it starts again from the left. */
export const RULER_STEPS = 16;
/** The stage stays at least this long, so a fast load still reads as a boot; it never holds data longer than `MAX_HOLD_MS`. */
export const MIN_SHOW_MS = 650;
export const MAX_HOLD_MS = 300;

export interface LoadingStage {
  readonly element: HTMLElement;
  /** The status line (`role="status"`): the texts the page has always written. */
  readonly status: HTMLElement;
  /** Puts the vehicle line above the status, as soon as the state is known. */
  showVehicle(line: HTMLElement): void;
  /** A step before the routes: the status text and the tag («Estado», «Vehículo»). */
  step(tag: string, text: string): void;
  /** A request of the routes completed: the year being read and the routes loaded so far. */
  progress(year: number, loaded: number): void;
  /** Resolves when the stage has been seen long enough (at most `MAX_HOLD_MS` from now). */
  settle(): Promise<void>;
  /**
   * Lays the stage over the hero of the new page
   * and plays the wipe; the stage goes at the end, or at once when
   * `signal` aborts or motion is off.
   */
  handOff(hero: HTMLElement, signal: AbortSignal): void;
}

export function loadingStage(options: { readonly signal: AbortSignal; readonly now?: () => number }): LoadingStage {
  const { signal } = options;
  const now = options.now ?? (() => performance.now());
  const started = now();
  const motion = canAnimate();

  const yearBox = el("b", { class: "sec-num boot-year" }, el("span", { class: "boot-year-in" }, "Estado"));
  const caption = el("span", { class: "boot-caption" }, "Arrancando");
  const number = el("span", { class: "boot-num" });
  number.textContent = "0";
  const status = el("p", { class: "loading boot-status", attrs: { role: "status" } }, "Leyendo el estado de la moto…");
  const run = el("span", { class: "boot-run" });
  // The passed ticks: a box that slides open while its ticks slide the other way, so they stay put.
  const trail = el("span", { class: "boot-trail" }, el("span", { class: "boot-trail-ticks" }));
  const scan = scanLine("scan-box boot-scan");
  const wedge = el("span", { class: "boot-wedge", attrs: { "aria-hidden": "true" } });
  const vehicleSlot = el("div", { class: "boot-vehicle" });
  const element = el(
    "div",
    { class: "boot" },
    scan,
    wedge,
    el(
      "div",
      { class: "boot-in" },
      // The tag and the digits are decoration: the status line says the same in words.
      el("p", { class: "sec-tag boot-tag", attrs: { "aria-hidden": "true" } }, yearBox, " ", caption),
      el("p", { class: "boot-count", attrs: { "aria-hidden": "true" } }, number, el("small", { class: "unit" }, "rutas")),
      vehicleSlot,
      status,
    ),
    el("div", { class: "boot-ruler", attrs: { "aria-hidden": "true" } }, trail, run),
  );

  let shown = 0;
  let steps = 0;
  let year: number | null = null;
  const timers = new Set<number>();
  const later = (callback: () => void, ms: number): void => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      callback();
    }, ms);
    timers.add(id);
  };
  // The scan loop runs only while the stage is on screen and the tab is visible.
  let observer: IntersectionObserver | null = null;
  let onScreen = true;
  const pause = (): void => {
    element.classList.toggle("paused", !onScreen || document.hidden);
  };
  if (motion) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) onScreen = entry.isIntersecting;
      pause();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", pause);
  }
  let counting: AbortController | null = null;
  const stop = (): void => {
    observer?.disconnect();
    observer = null;
    document.removeEventListener("visibilitychange", pause);
    counting?.abort();
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
    element.classList.add("paused");
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });

  /** Puts `text` in the tag; with motion the old text leaves upward and the new one rises in. */
  function flip(text: string): void {
    const current = yearBox.querySelector(".boot-year-in:not(.leave)");
    if (current?.textContent === text) return;
    const next = el("span", { class: "boot-year-in" }, text);
    if (!motion || signal.aborted || current === null) {
      yearBox.replaceChildren(next);
      return;
    }
    current.classList.add("leave");
    next.classList.add("enter");
    yearBox.append(next);
    later(() => current.remove(), durationToken("--dur-ui", 200));
  }

  return {
    element,
    status,
    showVehicle(line) {
      vehicleSlot.replaceChildren(line);
    },
    step(tag, text) {
      status.textContent = text;
      flip(tag);
    },
    progress(nextYear, loaded) {
      // A load that was replaced or abandoned may still report: the stage is gone, nothing moves.
      if (signal.aborted) return;
      status.textContent = `Cargando rutas de ${nextYear}… ${formatNumber(loaded)} hasta ahora.`;
      if (year !== nextYear) {
        year = nextYear;
        caption.textContent = "Leyendo el historial";
        flip(String(nextYear));
      }
      if (loaded !== shown) {
        counting?.abort();
        counting = new AbortController();
        countUp(number, loaded, (value) => formatNumber(Math.round(value)), {
          from: shown,
          durationMs: durationToken("--dur-reveal", 520),
          signal: counting.signal,
        });
        shown = loaded;
      }
      // One step of the red run per completed request; the passed ticks stay a little brighter.
      steps += 1;
      run.style.setProperty("--step", String(steps % RULER_STEPS));
      trail.style.setProperty("--trail", ((steps % RULER_STEPS) / RULER_STEPS).toFixed(4));
      element.classList.add("reading");
    },
    settle() {
      if (!motion || signal.aborted) return Promise.resolve();
      const wait = Math.min(MAX_HOLD_MS, Math.max(0, MIN_SHOW_MS - (now() - started)));
      if (wait === 0) return Promise.resolve();
      return new Promise((resolve) => {
        const id = window.setTimeout(() => {
          timers.delete(id);
          resolve();
        }, wait);
        timers.add(id);
        // A replaced view resolves at once; the caller checks that it is still current.
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    handOff(hero, viewSignal) {
      stop();
      // The status and the vehicle go at once: the page now says everything.
      status.remove();
      vehicleSlot.remove();
      element.setAttribute("aria-hidden", "true");
      if (!canAnimate() || viewSignal.aborted) {
        element.remove();
        return;
      }
      hero.classList.add("handed");
      element.classList.add("handoff");
      // Inside the new hero, over its whole box, so the wedge settles exactly on the hero's own wedge.
      hero.append(element);
      const done = (): void => {
        window.clearTimeout(id);
        element.remove();
        hero.classList.remove("handed");
      };
      const id = window.setTimeout(done, durationToken("--dur-hero", 800) + durationToken("--dur-ui", 200));
      viewSignal.addEventListener("abort", done, { once: true });
    },
  };
}
