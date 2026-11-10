/**
 * Hand-written SVG bar charts. Each chart is a <figure> with a titled SVG,
 * a legend when there is more than one series and a table with the same
 * figures, so nothing depends on colour or on seeing the drawing.
 */
import { el, svg, uniqueId } from "./dom";

export interface BarSeries {
  readonly label: string;
  readonly values: readonly number[];
  /** Extra class for the bars and the legend key of this series (a colour of the stylesheet). */
  readonly tone?: string;
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
  /**
   * A second drawing for phones, shown instead of the wide one on narrow
   * screens (stylesheet): about as wide as a phone, with these shorter
   * category labels and these axis labels. Without it a wide chart scrolls
   * inside its own box on a phone.
   */
  readonly narrow?: {
    readonly categories: readonly string[];
    readonly formatTick: (value: number) => string;
  };
}

const RIGHT = 8;
const TOP = 12;
const BOTTOM = 26;

/** The size and labels of one drawing of a chart. */
interface Frame {
  readonly width: number;
  readonly height: number;
  /** Room for the longest axis label at the largest tick size of the stylesheet. */
  readonly left: number;
  readonly categories: readonly string[];
  readonly labelEvery: number;
  readonly formatTick: (value: number) => string;
  readonly className: string;
}

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
  const peak = Math.max(0, ...series.flatMap((one) => one.values));
  const ticks = axisTicks(peak);
  const top = ticks[ticks.length - 1] as number;

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

  function draw(frame: Frame): SVGSVGElement {
    const { width, height, left } = frame;
    const plotWidth = width - left - RIGHT;
    const plotHeight = height - TOP - BOTTOM;
    const band = plotWidth / Math.max(1, categories.length);
    const groupWidth = band * 0.78;
    const barWidth = groupWidth / Math.max(1, series.length);
    const y = (value: number): number => TOP + plotHeight - (value / top) * plotHeight;
    const titleId = uniqueId("chart-title");
    const descId = uniqueId("chart-desc");
    const drawing = svg(
      "svg",
      { class: frame.className, attrs: { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-labelledby": `${titleId} ${descId}` } },
      svg("title", { id: titleId }, options.title),
      svg("desc", { id: descId }, summary),
    );

    for (const value of ticks) {
      const lineY = y(value);
      drawing.append(
        svg("line", { class: value === 0 ? "chart-base" : "chart-grid", attrs: { x1: left, x2: width - RIGHT, y1: lineY, y2: lineY } }),
        svg("text", { class: "chart-tick chart-tick-y", attrs: { x: left - 6, y: lineY + 4, "text-anchor": "end" } }, frame.formatTick(value)),
      );
    }

    frame.categories.forEach((category, c) => {
      const groupX = left + band * c + (band - groupWidth) / 2;
      series.forEach((one, s) => {
        const value = one.values[c] ?? 0;
        if (!(value > 0)) return;
        const barHeight = Math.max(1, (value / top) * plotHeight);
        const owner = series.length > 1 ? `, ${one.label}` : "";
        const tone = one.tone === undefined ? "" : ` ${one.tone}`;
        // In a one-series chart the tallest bars wear the bright red.
        const peakClass = series.length === 1 && value === peak ? " peak" : "";
        const bar = svg(
          "rect",
          {
            class: `chart-bar series-${s}${tone}${peakClass}`,
            attrs: {
              x: groupX + barWidth * s + 1,
              y: TOP + plotHeight - barHeight,
              width: Math.max(1, barWidth - 2),
              height: barHeight,
              rx: Math.min(3, barWidth / 4),
            },
          },
          svg("title", {}, `${names[c]}${owner}: ${formatValue(value)}`),
        );
        // Bars grow from the base on reveal, one category after another.
        bar.style.setProperty("--i", String(c));
        drawing.append(bar);
      });
      if (c % frame.labelEvery === 0) {
        drawing.append(
          svg("text", { class: "chart-tick", attrs: { x: left + band * c + band / 2, y: height - 8, "text-anchor": "middle" } }, category),
        );
      }
    });
    return drawing;
  }

  const compact = options.compact === true;
  // A wide chart is drawn about as wide as it is shown on a desktop, so its labels keep their
  // size; the stylesheet enlarges them on phones, where the drawing is scaled down.
  const wide = draw({
    width: compact ? 440 : 1100,
    height: compact ? 230 : 340,
    // Room for the longest axis label («1.500 km») at the largest tick size of the stylesheet.
    left: compact ? 56 : 104,
    categories,
    labelEvery: options.labelEvery ?? 1,
    formatTick: formatValue,
    className: options.narrow === undefined ? "chart-svg" : "chart-svg chart-wide",
  });
  // The phone drawing: as wide as a phone shows it, so its labels need no enlarging.
  const narrow =
    options.narrow === undefined
      ? null
      : draw({
          width: 400,
          height: 300,
          left: 50,
          categories: options.narrow.categories,
          labelEvery: 1,
          formatTick: options.narrow.formatTick,
          className: "chart-svg chart-narrow",
        });

  const classes = [
    "chart",
    series.length === 1 ? "chart-single" : null,
    compact ? "chart-compact" : null,
    narrow === null ? null : "chart-dual",
    "rv",
  ];
  // On a narrow screen a wide chart without a phone drawing keeps a readable size and scrolls inside this box, never the page.
  const figure = el("figure", { class: classes.filter(Boolean).join(" ") }, el("div", { class: "chart-scroll" }, wide, narrow));
  if (series.length > 1) {
    figure.append(
      el(
        "ul",
        { class: "chart-legend", attrs: { "aria-label": "Leyenda" } },
        ...series.map((one, s) =>
          el("li", {}, el("span", { class: `chart-key series-${s}${one.tone === undefined ? "" : ` ${one.tone}`}`, attrs: { "aria-hidden": "true" } }), one.label),
        ),
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
