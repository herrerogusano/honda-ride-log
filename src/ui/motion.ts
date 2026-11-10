/**
 * Motion helpers, with no animation library (docs/PLAN.md, decision D-027).
 *
 * - Durations and curves live in the stylesheet as tokens (`--dur-*`,
 *   `--stagger`, `--ease-*`); this module only adds classes and custom
 *   properties, so CSS decides how things move.
 * - Without IntersectionObserver (jsdom, old browsers) or with
 *   `prefers-reduced-motion: reduce`, everything is in its final state at
 *   once and no animation frame is requested.
 * - Nothing starts off screen or in a hidden tab, and every helper can be
 *   cancelled: through the function it returns or an AbortSignal, which the
 *   page aborts when it replaces the view.
 */

export interface MotionOptions {
  /** Aborting it cancels the helper and leaves its final state. */
  readonly signal?: AbortSignal | undefined;
}

export interface CountUpOptions extends MotionOptions {
  /** How long the count lasts; by default the `--dur-hero` token. */
  readonly durationMs?: number | undefined;
}

/** The most stagger steps one batch of revealed elements gets, so nothing waits long. */
export const MAX_STAGGER = 8;

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function canAnimate(): boolean {
  return typeof IntersectionObserver === "function" && typeof requestAnimationFrame === "function" && !prefersReducedMotion();
}

/** How the page scrolls when a button moves it: smoothly, or at once with reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "instant" : "smooth";
}

/**
 * Keeps track of which of `targets` are on screen now, so a change can
 * animate only what can be seen. Without IntersectionObserver or with
 * reduced motion nothing counts as on screen (nothing will animate) and no
 * observer is made. The observer goes when `signal` aborts.
 */
export function watchOnScreen(targets: readonly Element[], options: MotionOptions = {}): (target: Element) => boolean {
  if (!canAnimate() || targets.length === 0) return () => false;
  const onScreen = new Set<Element>();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) onScreen.add(entry.target);
      else onScreen.delete(entry.target);
    }
  });
  for (const target of targets) observer.observe(target);
  onAbort(options.signal, () => {
    observer.disconnect();
    onScreen.clear();
  });
  return (target) => onScreen.has(target);
}

function onAbort(signal: AbortSignal | undefined, cancel: () => void): void {
  if (signal === undefined) return;
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
}

/** A duration token of the stylesheet, in milliseconds (`800ms` or `.8s`), or `fallback`. */
export function durationToken(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith("ms") ? value : raw.endsWith("s") ? value * 1000 : fallback;
}

/**
 * Adds `.in` to every `.rv` element under `root` (and to `root` itself) the
 * first time it comes on screen, then stops watching it. Elements that
 * arrive together get a stagger index in `--d` (0 to MAX_STAGGER), which
 * the stylesheet multiplies by `--stagger`.
 */
export function reveal(root: Element, options: MotionOptions = {}): () => void {
  const targets = [...(root.matches(".rv") ? [root] : []), ...root.querySelectorAll(".rv")].filter(
    (target) => !target.classList.contains("in"),
  );
  if (targets.length === 0) return () => undefined;
  if (!canAnimate()) {
    for (const target of targets) target.classList.add("in");
    return () => undefined;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      let index = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLElement;
        target.style.setProperty("--d", String(Math.min(index, MAX_STAGGER)));
        index += 1;
        target.classList.add("in");
        observer.unobserve(target);
      }
    },
    { rootMargin: "0px 0px -6% 0px" },
  );
  for (const target of targets) observer.observe(target);
  let done = false;
  const dispose = (): void => {
    if (done) return;
    done = true;
    observer.disconnect();
    // What was never seen is shown as it is, without a transition to wait for.
    for (const target of targets) target.classList.add("in");
  };
  onAbort(options.signal, dispose);
  return dispose;
}

/** Strong ease-out, close to the `--ease-out` curve. */
const easeOut = (t: number): number => 1 - (1 - t) ** 5;

/**
 * Writes `format(value)` into `element` and, when the element first comes
 * on screen, counts up to it from 0 with animation frames.
 *
 * The exact final text is always in the element (`.cu-final`), so screen
 * readers and copy-paste get it; while counting it is transparent and an
 * `aria-hidden` copy (`.cu-anim`) shows the passing digits on top. When the
 * count ends, is cancelled or the tab is hidden, the copy goes away and
 * the element's text is exactly `format(value)`.
 */
export function countUp(element: HTMLElement, value: number, format: (value: number) => string, options: CountUpOptions = {}): () => void {
  const final = document.createElement("span");
  final.className = "cu-final";
  final.textContent = format(value);
  element.replaceChildren(final);
  element.classList.add("cu");
  if (!canAnimate() || !Number.isFinite(value) || value === 0) return () => undefined;

  let frame = 0;
  let copy: HTMLElement | null = null;
  let done = false;
  const onVisibility = (): void => {
    if (document.hidden) finish();
  };
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    start();
  });

  function finish(): void {
    if (done) return;
    done = true;
    observer.disconnect();
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    copy?.remove();
    copy = null;
    element.classList.remove("counting");
    document.removeEventListener("visibilitychange", onVisibility);
  }

  function start(): void {
    if (done) return;
    if (document.hidden) {
      finish();
      return;
    }
    const duration = options.durationMs ?? durationToken("--dur-hero", 800);
    const running = document.createElement("span");
    running.className = "cu-anim";
    running.setAttribute("aria-hidden", "true");
    running.textContent = format(0);
    copy = running;
    element.append(running);
    element.classList.add("counting");
    document.addEventListener("visibilitychange", onVisibility);
    let began: number | null = null;
    const step = (now: number): void => {
      began ??= now;
      const t = duration > 0 ? (now - began) / duration : 1;
      if (t >= 1) {
        finish();
        return;
      }
      running.textContent = format(value * easeOut(Math.max(0, t)));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  observer.observe(element);
  onAbort(options.signal, finish);
  return finish;
}
