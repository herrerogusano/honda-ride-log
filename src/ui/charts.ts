/**
 * Hand-written SVG bar charts. Each chart is a <figure> with a titled SVG,
 * a legend when there is more than one series and a table with the same
 * figures, so nothing depends on colour or on seeing the drawing.
 */
import { el, svg, uniqueId } from "./dom";

export interface BarSeries {
  readonly label: string;
  readonly values: readonly number[];
}

export interface BarChartOptions {
  readonly title: string;
  /** Short labels under the axis, one per category. */
  readonly categories: readonly string[];
  /** Full category names for the table and the tooltips; defaults to `categories`. */
  readonly categoryNames?: readonly string[];
  /** Header of the category column in the table. */
  readonly categoryHeader: string;
  readonly series: readonly BarSeries[];
  readonly formatValue: (value: number) => string;
  /** Draw one axis label every this many categories (default: all). */
  readonly labelEvery?: number;
  /** A narrower drawing, for charts shown side by side: the text stays readable. */
  readonly compact?: boolean;
}

const LEFT = 48;
const RIGHT = 8;
const TOP = 12;
const BOTTOM = 26;

/**
 * Values to label on the axis: from 0 up to the first one that reaches
 * `peak`, in whole steps of 1, 2 or 5 times a power of ten, at most five
 * steps. Whole steps, so that a label printed without decimals says exactly
 * where its line is (the charts show counts and whole km).
 */
export function axisTicks(peak: number): number[] {
  if (!(peak > 0)) return [0, 1];
  let power = 1;
  while (peak / (5 * power) > 5) power *= 10;
  const step = ([1, 2, 5].find((candidate) => peak / (candidate * power) <= 5) as number) * power;
  const ticks: number[] = [];
  for (let value = 0; value < peak + step; value += step) ticks.push(value);
  return ticks;
}

export function barChart(options: BarChartOptions): HTMLElement {
  const { categories, series, formatValue } = options;
  const names = options.categoryNames ?? categories;
  const WIDTH = options.compact === true ? 440 : 720;
  const HEIGHT = options.compact === true ? 230 : 250;
  const peak = Math.max(0, ...series.flatMap((one) => one.values));
  const ticks = axisTicks(peak);
  const top = ticks[ticks.length - 1] as number;
  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const band = plotWidth / Math.max(1, categories.length);
  const groupWidth = band * 0.78;
  const barWidth = groupWidth / Math.max(1, series.length);
  const y = (value: number): number => TOP + plotHeight - (value / top) * plotHeight;

  const titleId = uniqueId("chart-title");
  const descId = uniqueId("chart-desc");
  let summary = "Sin datos.";
  if (peak > 0) {
    let best = { series: 0, category: 0 };
    series.forEach((one, s) =>
      one.values.forEach((value, c) => {
        if (value > (series[best.series]?.values[best.category] ?? 0)) best = { series: s, category: c };
      }),
    );
    const owner = series.length > 1 ? ` (${series[best.series]?.label})` : "";
    summary = `Máximo: ${names[best.category]}${owner}, ${formatValue(peak)}. Las cifras están en la tabla que sigue al gráfico.`;
  }

  const drawing = svg(
    "svg",
    { class: "chart-svg", attrs: { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: "img", "aria-labelledby": `${titleId} ${descId}` } },
    svg("title", { id: titleId }, options.title),
    svg("desc", { id: descId }, summary),
  );

  for (const value of ticks) {
    const lineY = y(value);
    drawing.append(
      svg("line", { class: value === 0 ? "chart-base" : "chart-grid", attrs: { x1: LEFT, x2: WIDTH - RIGHT, y1: lineY, y2: lineY } }),
      svg("text", { class: "chart-tick chart-tick-y", attrs: { x: LEFT - 6, y: lineY + 4, "text-anchor": "end" } }, formatValue(value)),
    );
  }

  const every = options.labelEvery ?? 1;
  categories.forEach((category, c) => {
    const groupX = LEFT + band * c + (band - groupWidth) / 2;
    series.forEach((one, s) => {
      const value = one.values[c] ?? 0;
      if (!(value > 0)) return;
      const height = Math.max(1, (value / top) * plotHeight);
      const owner = series.length > 1 ? `, ${one.label}` : "";
      drawing.append(
        svg(
          "rect",
          {
            class: `chart-bar series-${s}`,
            attrs: {
              x: groupX + barWidth * s + 1,
              y: TOP + plotHeight - height,
              width: Math.max(1, barWidth - 2),
              height,
              rx: Math.min(3, barWidth / 4),
            },
          },
          svg("title", {}, `${names[c]}${owner}: ${formatValue(value)}`),
        ),
      );
    });
    if (c % every === 0) {
      drawing.append(
        svg("text", { class: "chart-tick", attrs: { x: LEFT + band * c + band / 2, y: HEIGHT - 8, "text-anchor": "middle" } }, category),
      );
    }
  });

  const figure = el("figure", { class: series.length === 1 ? "chart chart-single" : "chart" }, drawing);
  if (series.length > 1) {
    figure.append(
      el(
        "ul",
        { class: "chart-legend", attrs: { "aria-label": "Leyenda" } },
        ...series.map((one, s) => el("li", {}, el("span", { class: `chart-key series-${s}`, attrs: { "aria-hidden": "true" } }), one.label)),
      ),
    );
  }

  const table = el(
    "table",
    { class: "data-table" },
    el("caption", { class: "sr-only" }, options.title),
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { attrs: { scope: "col" } }, options.categoryHeader),
        ...series.map((one) => el("th", { class: "num", attrs: { scope: "col" } }, one.label)),
      ),
    ),
    el(
      "tbody",
      {},
      ...categories.map((_, c) =>
        el(
          "tr",
          {},
          el("th", { attrs: { scope: "row" } }, names[c] ?? ""),
          ...series.map((one) => el("td", { class: "num" }, formatValue(one.values[c] ?? 0))),
        ),
      ),
    ),
  );
  figure.append(
    el("details", { class: "chart-data" }, el("summary", {}, "Ver los datos en tabla"), el("div", { class: "table-scroll" }, table)),
  );
  return figure;
}
