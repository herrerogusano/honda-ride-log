/**
 * Tabs with the ARIA tabs pattern: arrow keys, Home and End move between
 * tabs and select them; only the selected tab is in the Tab order.
 */
import { el, uniqueId } from "./dom";

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
    if (changed) onSelect?.(id);
  }

  const list = el("div", { class: "tablist", attrs: { role: "tablist", "aria-label": label } }, ...buttons);
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
