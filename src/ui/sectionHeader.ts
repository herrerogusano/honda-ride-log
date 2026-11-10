/**
 * The header of a numbered section: a red slanted box with the number and
 * a small-caps tag («01 · RESUMEN»), and a huge uppercase title below it,
 * one or two lines. On reveal the tag slides in from the left and each
 * title line rises out of its own clipped box (stylesheet, `.sec-head`).
 *
 * `replay` plays that entrance again on a header that is already shown:
 * the page does it when a link of the top bar brings the section on screen
 * (with the red rule sweeping under the title) and when the period changes
 * the title (without the rule). It only toggles classes; the stylesheet
 * moves the parts, and with reduced motion nothing moves.
 */
import { el } from "./dom";
import { prefersReducedMotion } from "./motion";

export interface SectionHeader {
  readonly element: HTMLElement;
  readonly heading: HTMLHeadingElement;
  /** Replaces the title lines without replaying the reveal. */
  setTitle(lines: readonly string[]): void;
  /** Plays the entrance again; `sweep` adds the red rule. Does nothing with reduced motion. */
  replay(options?: { readonly sweep?: boolean }): void;
}

export function sectionHeader(number: string, tag: string, lines: readonly string[], headingId: string): SectionHeader {
  // Focusable by script only: a link of the top bar moves the keyboard focus here.
  const heading = el("h2", { id: headingId, class: "sec-title", attrs: { tabindex: -1 } });
  function setTitle(next: readonly string[]): void {
    heading.replaceChildren();
    next.forEach((line, index) => {
      // A real space between lines, so the accessible name reads as a sentence.
      if (index > 0) heading.append(" ");
      const inner = el("span", { class: "ln-in" }, line);
      const outer = el("span", { class: "ln" }, inner);
      outer.style.setProperty("--l", String(index));
      heading.append(outer);
    });
  }
  setTitle(lines);
  const element = el(
    "div",
    { class: "sec-head rv" },
    el("p", { class: "sec-tag" }, el("b", { class: "sec-num" }, number), " ", el("span", { class: "sec-name" }, tag)),
    heading,
    el("span", { class: "sec-rule", attrs: { "aria-hidden": "true" } }),
  );

  function replay(options: { readonly sweep?: boolean } = {}): void {
    if (prefersReducedMotion()) return;
    element.classList.remove("replay", "sweep");
    // Reading the layout restarts the CSS animations when the classes come back.
    void element.offsetWidth;
    element.classList.add("in", "replay");
    if (options.sweep === true) element.classList.add("sweep");
  }

  return { element, heading, setTitle, replay };
}
