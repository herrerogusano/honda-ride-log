// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { axisTicks, barChart } from "../src/ui/charts";
import { el, svg } from "../src/ui/dom";

describe("axisTicks", () => {
  it("labels whole values only, from zero up to the first that reaches the peak", () => {
    expect(axisTicks(0)).toEqual([0, 1]);
    expect(axisTicks(-3)).toEqual([0, 1]);
    expect(axisTicks(1)).toEqual([0, 1]);
    expect(axisTicks(2)).toEqual([0, 1, 2]);
    expect(axisTicks(3)).toEqual([0, 1, 2, 3]);
    expect(axisTicks(4.2)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(axisTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(axisTicks(23)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(axisTicks(80)).toEqual([0, 20, 40, 60, 80]);
    expect(axisTicks(100)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(axisTicks(1274)).toEqual([0, 500, 1000, 1500]);
    expect(axisTicks(0.3)).toEqual([0, 1]);
  });

  it("never needs more than five steps and never stops short of the peak", () => {
    for (let peak = 1; peak < 30_000; peak += 7.3) {
      const ticks = axisTicks(peak);
      expect(ticks.length).toBeLessThanOrEqual(6);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(peak);
      expect(ticks[ticks.length - 2]).toBeLessThan(peak);
      expect(ticks.every((tick) => Number.isInteger(tick))).toBe(true);
    }
  });
});

describe("barChart", () => {
  const chart = barChart({
    title: "Km por mes",
    categories: ["ene", "feb", "mar"],
    categoryNames: ["enero", "febrero", "marzo"],
    categoryHeader: "Mes",
    series: [
      { label: "2025", values: [10, 0, 30] },
      { label: "2026", values: [5, 80, 0] },
    ],
    formatValue: (value) => `${value} km`,
  });

  it("draws one bar per value above zero, as tall as its share of the axis", () => {
    const bars = [...chart.querySelectorAll("rect")];
    expect(bars.map((bar) => bar.querySelector("title")?.textContent)).toEqual([
      "enero, 2025: 10 km",
      "enero, 2026: 5 km",
      "febrero, 2026: 80 km",
      "marzo, 2025: 30 km",
    ]);
    const height = (index: number): number => Number(bars[index]?.getAttribute("height"));
    // Heights are proportional to the values, and every bar stands on the same line.
    expect(height(2) / height(0)).toBeCloseTo(8, 6);
    expect(height(3) / height(0)).toBeCloseTo(3, 6);
    const base = (index: number): number => Number(bars[index]?.getAttribute("y")) + height(index);
    expect(base(0)).toBeCloseTo(base(2), 6);
    // Bars of the same month sit side by side, and months go left to right.
    const x = (index: number): number => Number(bars[index]?.getAttribute("x"));
    expect(x(1)).toBeGreaterThan(x(0));
    expect(x(2)).toBeGreaterThan(x(1));
    expect(x(3)).toBeGreaterThan(x(2));
  });

  it("prints on each axis line exactly the value where the line is", () => {
    const labels = [...chart.querySelectorAll(".chart-tick-y")];
    expect(labels.map((label) => label.textContent)).toEqual(["0 km", "20 km", "40 km", "60 km", "80 km"]);
    const lines = [...chart.querySelectorAll("line")].map((line) => Number(line.getAttribute("y1")));
    // Evenly spaced, the zero at the bottom and the top bar touching the last line.
    const gaps = lines.slice(1).map((y, index) => (lines[index] as number) - y);
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0] as number, 6);
    expect(gaps[0]).toBeGreaterThan(0);
    const tallest = [...chart.querySelectorAll("rect")][2];
    expect(Number(tallest?.getAttribute("y"))).toBeCloseTo(lines[4] as number, 6);
    const months = [...chart.querySelectorAll('text[text-anchor="middle"]')];
    expect(months.map((label) => label.textContent)).toEqual(["ene", "feb", "mar"]);
    const positions = months.map((label) => Number(label.getAttribute("x")));
    expect(positions[1]).toBeGreaterThan(positions[0] as number);
    expect(positions[2]).toBeGreaterThan(positions[1] as number);
    // A count chart with a single ride per bar has no half rides on its axis.
    const few = barChart({ title: "t", categories: ["a", "b"], categoryHeader: "c", series: [{ label: "s", values: [1, 3] }], formatValue: String });
    expect([...few.querySelectorAll(".chart-tick-y")].map((label) => label.textContent)).toEqual(["0", "1", "2", "3"]);
    expect([...chart.querySelectorAll("rect")].map((bar) => bar.getAttribute("class"))).toEqual([
      "chart-bar series-0",
      "chart-bar series-1",
      "chart-bar series-1",
      "chart-bar series-0",
    ]);
  });

  it("is an image with a title and a description that names the maximum", () => {
    const drawing = chart.querySelector("svg");
    expect(drawing?.getAttribute("role")).toBe("img");
    expect(drawing?.querySelector("title")?.textContent).toBe("Km por mes");
    expect(drawing?.querySelector("desc")?.textContent).toContain("Máximo: febrero (2026), 80 km.");
    const labelled = drawing?.getAttribute("aria-labelledby")?.split(" ") ?? [];
    expect(labelled).toEqual([drawing?.querySelector("title")?.id, drawing?.querySelector("desc")?.id]);
  });

  it("has a legend and a table with every figure, zeros included", () => {
    expect([...chart.querySelectorAll(".chart-legend li")].map((item) => item.textContent)).toEqual(["2025", "2026"]);
    const rows = [...chart.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["enero", "10 km", "5 km"],
      ["febrero", "0 km", "80 km"],
      ["marzo", "30 km", "0 km"],
    ]);
    expect([...chart.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(["Mes", "2025", "2026"]);
    expect(chart.querySelector("table caption")?.textContent).toBe("Km por mes");
  });

  it("needs no legend for one series, and says so when there is no data", () => {
    const single = barChart({
      title: "Salidas",
      categories: ["a", "b"],
      categoryHeader: "Día",
      series: [{ label: "Salidas", values: [0, 0] }],
      formatValue: String,
    });
    expect(single.querySelector(".chart-legend")).toBeNull();
    expect(single.classList.contains("chart-single")).toBe(true);
    expect(single.querySelectorAll("rect").length).toBe(0);
    expect(single.querySelector("desc")?.textContent).toBe("Sin datos.");
    // Two equal maxima: the description names the first.
    const tie = barChart({ title: "t", categories: ["a", "b"], categoryHeader: "c", series: [{ label: "s", values: [5, 5] }], formatValue: String });
    expect(tie.querySelector("desc")?.textContent).toContain("Máximo: a, 5.");
    expect(single.querySelectorAll("tbody tr").length).toBe(2);
  });

  it("labels one category in every few when asked", () => {
    const hours = barChart({
      title: "Horas",
      categories: Array.from({ length: 24 }, (_, hour) => String(hour)),
      categoryHeader: "Hora",
      series: [{ label: "Salidas", values: new Array<number>(24).fill(1) }],
      formatValue: String,
      labelEvery: 3,
    });
    const labels = [...hours.querySelectorAll('text[text-anchor="middle"]')].map((label) => label.textContent);
    expect(labels).toEqual(["0", "3", "6", "9", "12", "15", "18", "21"]);
  });
});

describe("barChart for phones", () => {
  it("adds a second drawing, as wide as a phone, with short labels, and keeps one table", () => {
    const chart = barChart({
      title: "Km por mes",
      categories: ["ene", "feb", "mar"],
      categoryNames: ["enero", "febrero", "marzo"],
      categoryHeader: "Mes",
      series: [
        { label: "2025", values: [10, 0, 1200], tone: "tone-prev" },
        { label: "2026", values: [20, 5, 0], tone: "tone-now" },
      ],
      formatValue: (value) => `${value} km`,
      narrow: { categories: ["E", "F", "M"], formatTick: String },
    });
    const [wide, narrow] = [...chart.querySelectorAll("svg")] as [SVGSVGElement, SVGSVGElement];
    expect(chart.querySelectorAll("svg")).toHaveLength(2);
    expect([wide.getAttribute("class"), narrow.getAttribute("class")]).toEqual(["chart-svg chart-wide", "chart-svg chart-narrow"]);
    expect(chart.classList.contains("chart-dual")).toBe(true);
    expect(narrow.getAttribute("viewBox")).toBe("0 0 400 300");
    expect([...narrow.querySelectorAll('text[text-anchor="middle"]')].map((label) => label.textContent)).toEqual(["E", "F", "M"]);
    // Axis labels without the unit; the bars still say it in their titles.
    expect([...narrow.querySelectorAll(".chart-tick-y")].map((label) => label.textContent)).toEqual(["0", "500", "1000", "1500"]);
    expect(narrow.querySelector("rect title")?.textContent).toBe("enero, 2025: 10 km");
    // Both drawings are titled for whoever meets them; the figures are in one table only.
    for (const drawing of [wide, narrow]) expect((drawing.getAttribute("aria-labelledby") ?? "").split(" ")).toHaveLength(2);
    expect(wide.getAttribute("aria-labelledby")).not.toBe(narrow.getAttribute("aria-labelledby"));
    expect(chart.querySelectorAll("table")).toHaveLength(1);
    // Without the option there is one drawing, as before.
    const single = barChart({ title: "x", categories: ["a"], categoryHeader: "x", series: [{ label: "x", values: [1] }], formatValue: String });
    expect([single.querySelectorAll("svg").length, single.classList.contains("chart-dual"), single.querySelector("svg")?.getAttribute("class")]).toEqual([1, false, "chart-svg"]);
  });
});

describe("dom helpers", () => {
  it("put text in as text, never as markup", () => {
    const node = el("p", {}, "<img src=x onerror=alert(1)>", el("b", {}, "ok"));
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toBe("<img src=x onerror=alert(1)>ok");
  });

  it("refuse inline styles and handlers, which the security policy would block", () => {
    expect(() => el("p", { attrs: { style: "color:red" } })).toThrow("attribute not allowed");
    expect(() => el("p", { attrs: { onclick: "x()" } })).toThrow("attribute not allowed");
    expect(() => el("p", { attrs: { ONLOAD: "x()" } })).toThrow("attribute not allowed");
    expect(() => svg("rect", { attrs: { Style: "fill:red" } })).toThrow("attribute not allowed");
    expect(() => el("iframe", { attrs: { srcdoc: "x" } })).toThrow("attribute not allowed");
  });

  it("set classes, ids, attributes and listeners, and skip absent values", () => {
    let clicks = 0;
    const node = el("button", {
      class: "a b",
      id: "the-id",
      attrs: { type: "button", disabled: true, hidden: false, title: null, "data-n": 3 },
      on: { click: () => (clicks += 1) },
    });
    node.click();
    expect(clicks).toBe(0);
    node.disabled = false;
    node.click();
    expect(clicks).toBe(1);
    expect([node.className, node.id, node.getAttribute("type"), node.getAttribute("data-n")]).toEqual(["a b", "the-id", "button", "3"]);
    expect(node.hasAttribute("hidden")).toBe(false);
    expect(node.hasAttribute("title")).toBe(false);
    expect(svg("svg").namespaceURI).toBe("http://www.w3.org/2000/svg");
  });
});
