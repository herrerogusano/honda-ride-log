/**
 * Tabs with the ARIA tabs pattern: arrow keys, Home and End move between
 * tabs and select them; only the selected tab is in the Tab order.
 *
 * The underline of the selected tab is one element (`.tab-ink`) that slides
 * between tabs with a transform; its place and width are custom properties
 * set here and read by the stylesheet.
 */
import { el, uniqueId } from "./dom";

const requestFrame = (callback: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
  else callback();
};

export interface TabSpec {
  readonly id: string;
  readonly label: string;
  readonly panel: HTMLElement;
}

export interface Tabs {
  readonly element: HTMLElement;
  select(id: string, focus?: boolean): void;
  selected(): string;
}

export function createTabs(label: string, specs: readonly TabSpec[], onSelect?: (id: string) => void): Tabs {
  const prefix = uniqueId("tabs");
  let current = specs[0]?.id ?? "";
  const buttons = specs.map((spec) =>
    el("button", {
      class: "tab",
      id: `${prefix}-tab-${spec.id}`,
      attrs: { type: "button", role: "tab", "aria-controls": `${prefix}-panel-${spec.id}`, "data-tab": spec.id },
    }, spec.label),
  );
  specs.forEach((spec, index) => {
    spec.panel.id = `${prefix}-panel-${spec.id}`;
    spec.panel.setAttribute("role", "tabpanel");
    spec.panel.setAttribute("aria-labelledby", (buttons[index] as HTMLElement).id);
    spec.panel.tabIndex = 0;
    spec.panel.classList.add("tabpanel");
  });

  // Decorative: hidden from assistive technology, outside the tabs' roles.
  const ink = el("span", { class: "tab-ink", attrs: { "aria-hidden": "true" } });

  /** Puts the underline under the selected tab. Without layout (jsdom) both numbers are 0. */
  function placeInk(): void {
    const button = buttons[specs.findIndex((spec) => spec.id === current)];
    if (button === undefined) return;
    ink.style.setProperty("--ink-x", `${button.offsetLeft}px`);
    ink.style.setProperty("--ink-w", String(button.offsetWidth));
    // The first placement does not slide in from the left edge.
    if (button.offsetWidth > 0) requestFrame(() => ink.classList.add("ready"));
  }

  function select(id: string, focus = false): void {
    if (!specs.some((spec) => spec.id === id)) return;
    const changed = id !== current;
    current = id;
    specs.forEach((spec, index) => {
      const button = buttons[index] as HTMLButtonElement;
      const active = spec.id === id;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      spec.panel.hidden = !active;
      if (active && focus) button.focus();
    });
    placeInk();
    if (changed) onSelect?.(id);
  }

  const list = el("div", { class: "tablist", attrs: { role: "tablist", "aria-label": label } }, ...buttons, ink);
  // Tab widths change when the list is laid out, resized or the fonts arrive.
  if (typeof ResizeObserver === "function") new ResizeObserver(placeInk).observe(list);
  void document.fonts?.ready.then(placeInk);
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => select((specs[index] as TabSpec).id));
    button.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      const last = specs.length - 1;
      let target: number | null = null;
      if (key === "ArrowRight") target = index === last ? 0 : index + 1;
      else if (key === "ArrowLeft") target = index === 0 ? last : index - 1;
      else if (key === "Home") target = 0;
      else if (key === "End") target = last;
      if (target === null) return;
      event.preventDefault();
      select((specs[target] as TabSpec).id, true);
    });
  });

  const element = el("div", { class: "tabs" }, list, ...specs.map((spec) => spec.panel));
  select(current);
  return { element, select, selected: () => current };
}
