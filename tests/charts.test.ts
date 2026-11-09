// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { barChart, niceMax } from "../src/ui/charts";
import { el, svg } from "../src/ui/dom";

describe("niceMax", () => {
  it("rounds the top of the axis up to a round number", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-3)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(18)).toBe(20);
    expect(niceMax(23)).toBe(25);
    expect(niceMax(26)).toBe(50);
    expect(niceMax(100)).toBe(100);
    expect(niceMax(1274)).toBe(2000);
    expect(niceMax(0.3)).toBeCloseTo(0.5, 9);
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
    // The axis tops at 100: 80 km takes 80 % of the plot, 10 km takes 10 %.
    expect(height(2) / height(0)).toBeCloseTo(8, 6);
    expect(height(3) / height(0)).toBeCloseTo(3, 6);
    const base = (index: number): number => Number(bars[index]?.getAttribute("y")) + height(index);
    expect(base(0)).toBeCloseTo(base(2), 6);
    expect(bars.map((bar) => bar.getAttribute("class"))).toEqual([
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
