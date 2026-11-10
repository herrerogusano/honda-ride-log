/**
 * The section links of the top bar (docs/PLAN.md, section 12).
 *
 * - Each link is a button that scrolls to its section, below the sticky bar,
 *   and moves the keyboard focus to the section heading. The address is
 *   never touched: its fragment is reserved for `#demo` (decision D-028).
 * - One underline (`.nav-ink`) slides and resizes between links with a
 *   transform. A scroll spy (IntersectionObserver on a thin band of the
 *   screen) says which section is being read; that link gets
 *   `aria-current="true"`.
 * - When a link brings its section on screen, the section header plays its
 *   entrance again, with a red rule sweeping under the title.
 * - A thin reading-progress bar along the top edge, painted in an animation
 *   frame only while the page scrolls.
 *
 * Everything it listens to or asks for (observers, frames, scroll
 * listeners) goes when `signal` aborts: the page aborts it when it replaces
 * the view.
 */
import { el } from "./dom";
import { scrollBehavior, type MotionOptions } from "./motion";
import type { SectionHeader } from "./sectionHeader";

export interface NavSection {
  /** A short internal name, for tests and `data-section`; never written to the address. */
  readonly id: string;
  readonly label: string;
  readonly element: HTMLElement;
  readonly header: SectionHeader;
}

export interface NavOptions extends MotionOptions {
  /** Height of whatever sticks to the top of the screen, in px: the target lands just below it. */
  readonly offset: () => number;
}

export interface SectionNav {
  /** The links, for the top bar. */
  readonly element: HTMLElement;
  /** The reading-progress bar, for the top edge of the bar. */
  readonly progress: HTMLElement;
  /** The section marked as current, or null above the first one. */
  current(): string | null;
}

/** Room left between the bar and the section that a link brings up. */
const GAP = 16;
/** Frames without scrolling that count as "the scroll has ended" where `scrollend` does not exist. */
const STILL_FRAMES = 6;

export function sectionNav(sections: readonly NavSection[], options: NavOptions): SectionNav {
  const { signal } = options;
  const links = sections.map((section) =>
    el("button", { class: "nav-link", attrs: { type: "button", "data-section": section.id } }, section.label),
  );
  // Decorative: hidden from assistive technology, which hears `aria-current`.
  const ink = el("span", { class: "nav-ink off", attrs: { "aria-hidden": "true" } });
  const list = el("div", { class: "nav-links" }, ...links, ink);
  const element = el("nav", { class: "page-nav", attrs: { "aria-label": "Secciones" } }, list);
  const progress = el("div", { class: "nav-progress", attrs: { "aria-hidden": "true" } });

  const cleanups: (() => void)[] = [];
  let disposed = false;
  let active = -1;
  let inkFrame = 0;
  cleanups.push(() => {
    if (inkFrame !== 0) cancelAnimationFrame(inkFrame);
    inkFrame = 0;
  });

  function placeInk(): void {
    const link = links[active];
    if (link === undefined) return;
    ink.style.setProperty("--ink-x", `${link.offsetLeft}px`);
    ink.style.setProperty("--ink-w", String(link.offsetWidth));
    // The first placement does not slide in from the left edge.
    if (link.offsetWidth > 0 && inkFrame === 0 && !ink.classList.contains("ready") && typeof requestAnimationFrame === "function") {
      inkFrame = requestAnimationFrame(() => {
        inkFrame = 0;
        ink.classList.add("ready");
      });
    }
  }

  /** On a narrow screen the links scroll sideways: the current one is brought into view. */
  function keepInView(link: HTMLElement): void {
    if (list.scrollWidth <= list.clientWidth || typeof list.scrollTo !== "function") return;
    list.scrollTo({ left: Math.max(0, link.offsetLeft - (list.clientWidth - link.offsetWidth) / 2), behavior: scrollBehavior() });
  }

  function mark(index: number): void {
    if (index === active) return;
    active = index;
    links.forEach((link, at) => {
      if (at === index) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
    ink.classList.toggle("off", index < 0);
    placeInk();
    const link = links[index];
    if (link !== undefined) keepInView(link);
    // Back at the hero, a strip scrolled sideways shows its first links again.
    else if (list.scrollLeft > 0 && typeof list.scrollTo === "function") list.scrollTo({ left: 0, behavior: scrollBehavior() });
  }

  // ---- scroll spy ----
  /** Index of the section a link is scrolling to; the spy waits until it arrives. */
  let heading: number | null = null;
  const inBand = new Set<number>();
  /** The band is a line at 35 % of the screen height: the section that crosses it is the one being read. */
  const BAND = 0.35;
  function spyUpdate(): void {
    if (heading !== null) return;
    if (inBand.size > 0) {
      mark(Math.max(...inBand));
      return;
    }
    // Nothing on the line: above the first section (the hero) nothing is current;
    // below the last one (the footer) the last stays current.
    const first = sections[0]?.element;
    if (first !== undefined && first.getBoundingClientRect().top > window.innerHeight * BAND) mark(-1);
  }
  if (typeof IntersectionObserver === "function") {
    const spy = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = sections.findIndex((section) => section.element === entry.target);
          if (index < 0) continue;
          if (entry.isIntersecting) inBand.add(index);
          else inBand.delete(index);
        }
        spyUpdate();
      },
      { rootMargin: `-${BAND * 100}% 0px -${(1 - BAND) * 100 - 1}% 0px` },
    );
    for (const section of sections) spy.observe(section.element);
    cleanups.push(() => spy.disconnect());
  }

  // ---- links ----
  /** Each press gets a number; an arrival that is no longer the latest does nothing. */
  let press = 0;

  function onScreen(target: Element): boolean {
    const box = target.getBoundingClientRect();
    return box.bottom > 0 && box.top < window.innerHeight;
  }

  function arrive(index: number, mine: number): void {
    if (disposed || mine !== press) return;
    heading = null;
    const section = sections[index];
    // Only what can be seen moves; reduced motion is handled by `replay`.
    if (section !== undefined && onScreen(section.header.element)) section.header.replay({ sweep: true });
  }

  /** Stops the one wait for the end of a scroll that may be pending; a new press replaces it. */
  let stopWaiting: (() => void) | null = null;
  cleanups.push(() => stopWaiting?.());

  /** Calls `done` once the page stops scrolling: `scrollend` where it exists, else a few still frames. */
  function whenScrollEnds(done: () => void): void {
    stopWaiting?.();
    stopWaiting = null;
    if (Reflect.has(window, "onscrollend")) {
      const listener = (): void => {
        stopWaiting = null;
        done();
      };
      window.addEventListener("scrollend", listener, { once: true });
      stopWaiting = () => window.removeEventListener("scrollend", listener);
      return;
    }
    if (typeof requestAnimationFrame !== "function") {
      done();
      return;
    }
    let last = window.scrollY;
    let still = 0;
    let frame = 0;
    const watch = (): void => {
      if (disposed) return;
      still = window.scrollY === last ? still + 1 : 0;
      last = window.scrollY;
      if (still >= STILL_FRAMES) {
        stopWaiting = null;
        done();
      } else frame = requestAnimationFrame(watch);
    };
    frame = requestAnimationFrame(watch);
    stopWaiting = () => cancelAnimationFrame(frame);
  }

  function go(index: number): void {
    const section = sections[index];
    if (section === undefined) return;
    press += 1;
    const mine = press;
    mark(index);
    heading = index;
    // The header lands just below the bar (the section box starts higher, with its top padding).
    const wanted = section.header.element.getBoundingClientRect().top + window.scrollY - options.offset() - GAP;
    // The page cannot scroll past its end: the last sections may stop short of the bar.
    const reachable = Math.max(0, Math.min(wanted, document.documentElement.scrollHeight - window.innerHeight));
    // The focus goes to the heading without a jump; the scroll below does the moving.
    section.header.heading.focus({ preventScroll: true });
    if (Math.abs(reachable - window.scrollY) < 2) {
      arrive(index, mine);
      return;
    }
    const behavior = scrollBehavior();
    window.scrollTo({ top: reachable, behavior });
    if (behavior === "smooth") whenScrollEnds(() => arrive(index, mine));
    else arrive(index, mine);
  }

  links.forEach((link, index) => link.addEventListener("click", () => go(index)));

  // ---- underline placement ----
  // Link widths change when the bar is laid out, resized or the fonts arrive.
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => placeInk());
    observer.observe(list);
    cleanups.push(() => observer.disconnect());
  }
  void document.fonts?.ready.then(() => {
    if (!disposed) placeInk();
  });

  // ---- reading progress ----
  let progressFrame = 0;
  function paintProgress(): void {
    progressFrame = 0;
    const room = document.documentElement.scrollHeight - window.innerHeight;
    const share = room > 0 ? Math.min(1, Math.max(0, window.scrollY / room)) : 0;
    progress.style.setProperty("--progress", share.toFixed(4));
    // A jump from the footer to the hero crosses no section on the line, so the
    // spy hears nothing: while no section is on it, the frame asks again.
    if (inBand.size === 0) spyUpdate();
  }
  const onScroll = (): void => {
    if (progressFrame !== 0 || typeof requestAnimationFrame !== "function") return;
    progressFrame = requestAnimationFrame(paintProgress);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  cleanups.push(() => {
    window.removeEventListener("scroll", onScroll);
    if (progressFrame !== 0) cancelAnimationFrame(progressFrame);
    progressFrame = 0;
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
  if (signal?.aborted === true) dispose();
  else signal?.addEventListener("abort", dispose, { once: true });

  return {
    element,
    progress,
    current: () => sections[active]?.id ?? null,
  };
}
