/**
 * The header of a numbered section: a red slanted box with the number and
 * a small-caps tag («01 · RESUMEN»), and a huge uppercase title below it,
 * one or two lines. On reveal the tag slides in from the left and each
 * title line rises out of its own clipped box (stylesheet, `.sec-head`).
 */
import { el } from "./dom";

export interface SectionHeader {
  readonly element: HTMLElement;
  readonly heading: HTMLHeadingElement;
  /** Replaces the title lines without replaying the reveal. */
  setTitle(lines: readonly string[]): void;
}

export function sectionHeader(number: string, tag: string, lines: readonly string[], headingId: string): SectionHeader {
  const heading = el("h2", { id: headingId, class: "sec-title" });
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
  );
  return { element, heading, setTitle };
}
