/**
 * The period selector of the top bar, in two forms that share one choice:
 *
 * - A segmented control made of radio inputs (the years with routes, newest
 *   first, and «Todo»), on wide screens. The arrow keys move between options
 *   as in any radio group. The chosen option sits on a red pill, one element
 *   that slides between options with a transform (like the underline of the
 *   section links). With many years the row scrolls inside its own box and
 *   keeps the chosen one in view.
 * - A native `<select>` with the same options, on narrow screens (640 px or
 *   less), where the row of years would crowd the brand and «Salir» out.
 *
 * The style sheet shows one form and hides the other with `display: none`,
 * so a keyboard or a screen reader only ever meets the one on screen.
 * Changing either moves the other to the same option and calls `onChange`
 * once.
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

const optionText = (value: Period): string => (value === "all" ? "Todo" : String(value));

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
    el("label", { class: "period-opt" }, inputs[index] as HTMLInputElement, el("span", {}, optionText(value))),
  );
  // Decorative: the chosen option is said by the checked input.
  const pill = el("span", { class: "period-pill", attrs: { "aria-hidden": "true" } });
  const track = el("div", { class: "period-track" }, pill, ...labels);
  const segmented = el("fieldset", { class: "period-control" }, el("legend", { class: "sr-only" }, "Periodo"), track);

  const selectId = uniqueId("period-select");
  const select = el(
    "select",
    { id: selectId, class: "period-select" },
    ...values.map((value) => el("option", { attrs: { value: String(value), selected: value === initial } }, optionText(value))),
  );
  const compact = el(
    "div",
    { class: "period-compact" },
    el("label", { class: "sr-only", attrs: { for: selectId } }, "Periodo"),
    select,
    // The arrow is drawn, not typed into the options: a screen reader reads only «2026».
    el("span", { class: "period-caret", attrs: { "aria-hidden": "true" } }),
  );
  const element = el("div", { class: "period" }, segmented, compact);

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

  const periodOf = (value: string): Period => (value === "all" ? "all" : Number(value));

  for (const input of inputs) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      select.value = input.value;
      place();
      onChange(periodOf(input.value));
    });
  }
  select.addEventListener("change", () => {
    const input = inputs.find((one) => one.value === select.value);
    if (input === undefined || input.checked) return;
    input.checked = true;
    place();
    onChange(periodOf(select.value));
  });
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
