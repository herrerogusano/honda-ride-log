import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * WCAG contrast of the colour tokens of src/styles.css (docs/PLAN.md,
 * section 11). The tokens are read from the stylesheet itself, converted
 * from oklch to sRGB, and every pair the page uses for text, control
 * borders and chart series is checked.
 *
 * What this does not prove: colours outside the sRGB gamut are clipped per
 * channel, while browsers reduce chroma instead (the luminance differs a
 * little); translucent colours and colours written outside the tokens are
 * not checked; and nothing here sees the rendered page.
 */
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/** The `--name: oklch(L% C H)` declarations of the first `:root` block. */
export function colourTokens(stylesheet: string): Map<string, [number, number, number]> {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(stylesheet)?.[1] ?? "";
  const tokens = new Map<string, [number, number, number]>();
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)\s*;/g)) {
    tokens.set(match[1] as string, [Number(match[2]) / 100, Number(match[3]), Number(match[4])]);
  }
  return tokens;
}

/** Linear sRGB of an oklch colour (Björn Ottosson's OKLab matrices), clipped to the gamut. */
export function oklchToLinearSrgb([l, c, h]: readonly [number, number, number]): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (value: number): number => Math.min(1, Math.max(0, value));
  return [
    clip(4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1),
    clip(-1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1),
    clip(-0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1),
  ];
}

export function luminance(colour: readonly [number, number, number]): number {
  const [r, g, b] = oklchToLinearSrgb(colour);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(one: readonly [number, number, number], two: readonly [number, number, number]): number {
  const [light, dark] = [luminance(one), luminance(two)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const tokens = colourTokens(css);
const token = (name: string): [number, number, number] => {
  const found = tokens.get(name);
  if (found === undefined) throw new Error(`token ${name} missing from src/styles.css`);
  return found;
};

/** [foreground, background, minimum ratio, where it is used]. */
const PAIRS: readonly (readonly [string, string, number, string])[] = [
  // Body text, secondary text, captions and labels, links and red units: 4.5:1 on every surface.
  ...["--fg", "--fg-2", "--fg-3", "--red-hi"].flatMap((fg) =>
    ["--bg", "--surface", "--surface-2"].map((bg) => [fg, bg, 4.5, "text"] as const),
  ),
  ["--on-red", "--red", 4.5, "text of red buttons and of the section number"],
  ["--fg", "--amber-bg", 4.5, "demo banner"],
  ["--fg-2", "--amber-bg", 4.5, "demo banner"],
  ["--amber", "--amber-bg", 4.5, "demo banner flag"],
  // Borders of buttons and fields, and the focus outline: 3:1 against what surrounds them.
  ["--control-line", "--bg", 3, "control border"],
  ["--control-line", "--surface", 3, "control border"],
  ["--red-hi", "--surface-2", 3, "focus outline"],
  // Series of the km-per-month chart (graphical objects) against the page.
  ["--red-hi", "--bg", 3, "this year's bars"],
  ["--bar-prev", "--bg", 3, "last year's bars"],
  ["--bar-old", "--bg", 3, "older years' bars"],
];

describe("colour contrast of the stylesheet tokens", () => {
  it("finds the tokens it checks in src/styles.css", () => {
    for (const name of new Set(PAIRS.flatMap(([fg, bg]) => [fg, bg]))) expect(tokens.has(name), name).toBe(true);
  });

  it("converts oklch like the reference values", () => {
    // White and black, and a known mid grey: oklch(59.987% 0 0) is #808080 (luminance 0.2159).
    expect(luminance([1, 0, 0])).toBeCloseTo(1, 4);
    expect(luminance([0, 0, 0])).toBeCloseTo(0, 6);
    expect(luminance([0.59987, 0, 0])).toBeCloseTo(0.2159, 3);
    expect(contrast([1, 0, 0], [0, 0, 0])).toBeCloseTo(21, 3);
  });

  it.each(PAIRS)("%s on %s reaches %s:1 (%s)", (fg, bg, minimum) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(minimum);
  });

  it("is dark only: one colour scheme and no light-theme block", () => {
    expect(css).toMatch(/color-scheme:\s*dark;/);
    expect(css).not.toMatch(/prefers-color-scheme/);
  });
});
