import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Rules of src/styles.css that nothing else checks (docs/PLAN.md, section
 * 11): the motion tokens and nothing else (D-027), the reduced-motion
 * block, the revealed state, the focus outline and the 44 px targets. It
 * reads the stylesheet as text: it proves the rules are written, not that a
 * browser applies them (for that, the checks in a real browser listed in
 * section 11).
 */
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
const outsideRoot = css.replace(rootBlock, "");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string, within = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const found = new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(within);
  if (found === null) throw new Error(`no rule ${selector}`);
  return found[1] as string;
}

/** The body of an at-rule block, braces balanced. */
function block(opening: string): string {
  const start = css.indexOf(opening);
  if (start < 0) throw new Error(`no block ${opening}`);
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, index);
  }
  throw new Error(`unclosed ${opening}`);
}

const declaration = (body: string, property: string): string | undefined =>
  new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+);`).exec(body)?.[1]?.trim();
const px = (value: string | undefined): number => Number.parseFloat(value ?? "0");

describe("motion tokens (D-027)", () => {
  it("declares exactly the agreed durations and curves", () => {
    const tokens = [...rootBlock.matchAll(/(--(?:dur|stagger|ease)[\w-]*)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2]?.trim()]);
    expect(tokens).toEqual([
      ["--dur-press", "120ms"],
      ["--dur-ui", "200ms"],
      ["--dur-reveal", "520ms"],
      ["--dur-hero", "800ms"],
      ["--stagger", "60ms"],
      ["--ease-out", "cubic-bezier(0.23, 1, 0.32, 1)"],
      ["--ease-in-out", "cubic-bezier(0.77, 0, 0.175, 1)"],
    ]);
    expect(outsideRoot).not.toMatch(/--(?:dur|stagger|ease)[\w-]*\s*:/);
  });

  it("uses no other timing anywhere: no time literal but zero, no curve keyword or function", () => {
    const times = [...outsideRoot.matchAll(/(?<![\w-])(\d*\.?\d+)m?s\b/g)].filter((match) => Number(match[1]) !== 0).map((match) => match[0]);
    expect(times).toEqual([]);
    const motion = [...outsideRoot.matchAll(/(?:transition|animation)[\w-]*\s*:\s*([^;]+);/g)].map((match) => match[1] as string);
    expect(motion.length).toBeGreaterThan(5);
    for (const value of motion) {
      expect(value.replace(/var\(--[\w-]+\)/g, ""), value).not.toMatch(/cubic-bezier|steps\(|\b(?:ease|ease-in|ease-out|ease-in-out|linear)\b/);
    }
  });
});

describe("reduced motion and revealed state", () => {
  it("turns every animation and transition off and shows hidden parts in their final state", () => {
    const reduced = block("@media (prefers-reduced-motion: reduce)");
    const all = rule("*,\n  *::before,\n  *::after", reduced);
    expect(declaration(all, "animation")).toBe("none !important");
    expect(declaration(all, "transition")).toBe("none !important");
    const final = rule(".rv,\n  .sec-head .sec-tag,\n  .sec-head .ln-in", reduced);
    expect([declaration(final, "opacity"), declaration(final, "transform")]).toEqual(["1", "none"]);
  });

  it("shows a revealed element fully", () => {
    const shown = rule(".rv.in");
    expect([declaration(shown, "opacity"), declaration(shown, "transform")]).toEqual(["1", "none"]);
  });
});

describe("focus and targets", () => {
  it("draws a visible focus outline and never removes it for keyboard focus", () => {
    expect(declaration(rule(":focus-visible"), "outline")).toBe("2px solid var(--red-hi)");
    for (const match of css.matchAll(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/g)) {
      expect(declaration(match[2] as string, "outline") ?? "", match[1]?.trim()).not.toMatch(/^(?:none|0)\b/);
    }
  });

  it("makes every control at least 44 px tall", () => {
    expect(px(declaration(rule(".button"), "min-height"))).toBeGreaterThanOrEqual(44);
    expect(px(declaration(rule('select,\ninput[type="search"],\ninput[type="number"]'), "min-height"))).toBeGreaterThanOrEqual(44);
    expect(px(declaration(rule(".tab"), "min-height"))).toBeGreaterThanOrEqual(44);
    expect(px(declaration(rule(".row-button"), "min-height"))).toBeGreaterThanOrEqual(44);
    expect(px(declaration(rule(".chart-data summary"), "min-height"))).toBeGreaterThanOrEqual(44);
    const zoom = rule(".map-canvas.leaflet-container .leaflet-bar a,\n.map-canvas.leaflet-touch .leaflet-bar a");
    expect([px(declaration(zoom, "width")), px(declaration(zoom, "height"))]).toEqual([44, 44]);
  });
});
