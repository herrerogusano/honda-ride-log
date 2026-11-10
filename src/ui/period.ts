/**
 * The period selector of the top bar: a segmented control made of radio
 * inputs (the years with routes, newest first, and «Todo»). The arrow keys
 * move between options as in any radio group. The chosen option sits on a
 * red pill, one element that slides between options with a transform (like
 * the underline of the section links). With many years the row scrolls
 * inside its own box and keeps the chosen one in view.
 */
import type { Period } from "../domain/stats";
import { el, uniqueId } from "./dom";
import { scrollBehavior, type MotionOptions } from "./motion";

export interface PeriodControl {
  readonly element: HTMLElement;
  /** Puts the pill under the chosen option again (after a layout change). */
  place(): void;
}

const requestFrame = (callback: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
  else callback();
};

export function periodControl(
  years: readonly number[],
  initial: Period,
  onChange: (period: Period) => void,
  options: MotionOptions = {},
): PeriodControl {
  const name = uniqueId("period");
  const values: Period[] = [...years, "all"];
  const inputs = values.map((value) =>
    el("input", { class: "period-input", attrs: { type: "radio", name, value: String(value), checked: value === initial } }),
  );
  const labels = values.map((value, index) =>
    el("label", { class: "period-opt" }, inputs[index] as HTMLInputElement, el("span", {}, value === "all" ? "Todo" : String(value))),
  );
  // Decorative: the chosen option is said by the checked input.
  const pill = el("span", { class: "period-pill", attrs: { "aria-hidden": "true" } });
  const track = el("div", { class: "period-track" }, pill, ...labels);
  const element = el("fieldset", { class: "period-control" }, el("legend", { class: "sr-only" }, "Periodo"), track);

  function chosen(): HTMLLabelElement | undefined {
    return labels[inputs.findIndex((input) => input.checked)];
  }

  function place(): void {
    const label = chosen();
    if (label === undefined) return;
    pill.style.setProperty("--pill-x", `${label.offsetLeft}px`);
    pill.style.setProperty("--pill-w", String(label.offsetWidth));
    // The first placement does not slide in from the left edge.
    if (label.offsetWidth > 0) requestFrame(() => pill.classList.add("ready"));
    // A long row scrolls inside its box: keep the chosen option in view.
    const left = label.offsetLeft - (track.clientWidth - label.offsetWidth) / 2;
    if (track.scrollWidth > track.clientWidth && typeof track.scrollTo === "function") {
      track.scrollTo({ left: Math.max(0, left), behavior: label.offsetWidth > 0 && pill.classList.contains("ready") ? scrollBehavior() : "instant" });
    }
  }

  for (const input of inputs) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      place();
      onChange(input.value === "all" ? "all" : Number(input.value));
    });
  }
  // Option widths change when the bar is laid out, resized or the fonts arrive.
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => place());
    observer.observe(track);
    options.signal?.addEventListener("abort", () => observer.disconnect(), { once: true });
  }
  void document.fonts?.ready.then(() => {
    if (options.signal?.aborted !== true) place();
  });
  return { element, place };
}
