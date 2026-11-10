// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CARD_FONTS, CARD_SCALE, CARD_SIZE, cardContent, cardText, drawCard, paintCard, splitUnit } from "../src/ui/card";
import { rides } from "./helpers";

/**
 * The share card drawn on a recording canvas context (docs/PLAN.md, section
 * 3, «Tarjeta para compartir»). jsdom has no canvas: the context below
 * records every call and every text, so this proves what is drawn as text
 * and in which fonts, not how the PNG looks (that was checked in a browser,
 * section 14).
 */
interface Recorded {
  readonly canvas: HTMLCanvasElement;
  readonly texts: { text: string; font: string; fill: string }[];
  readonly calls: string[];
}

function recordingCanvas(): Recorded {
  const texts: Recorded["texts"] = [];
  const calls: string[] = [];
  const state = { font: "", fillStyle: "", letterSpacing: "0px" };
  const context = new Proxy(state as unknown as CanvasRenderingContext2D, {
    get(_target, name) {
      if (name in state) return (state as Record<string | symbol, unknown>)[name];
      if (name === "fillText") return (text: string) => void texts.push({ text, font: state.font, fill: state.fillStyle });
      if (name === "measureText") return (text: string) => ({ width: text.length * 20 });
      return (...args: unknown[]) => void calls.push(`${String(name)}(${args.join(",")})`);
    },
    set(_target, name, value) {
      (state as Record<string | symbol, unknown>)[name] = value;
      return true;
    },
    has(_target, name) {
      return name in state;
    },
  });
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  return { canvas, texts, calls };
}

const list = rides([
  { start: "2026-07-04T09:00:00-07:00", km: 70, minutes: 60, speed: 47, maxSpeed: 123 },
  { start: "2026-07-05T09:00:00-07:00", km: 12.5, minutes: 30, speed: 25, maxSpeed: 98 },
]);

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, "fonts");
});

describe("share card drawing", () => {
  it("draws the title and the five figures, numbers apart from their red units, at twice the size", () => {
    const demo = recordingCanvas();
    const content = cardContent(list, 2026, true);
    expect(drawCard(demo.canvas, content)).toBe(true);
    expect([demo.canvas.width, demo.canvas.height]).toEqual([CARD_SIZE * CARD_SCALE, CARD_SIZE * CARD_SCALE]);
    expect(demo.calls).toContain(`setTransform(${CARD_SCALE},0,0,${CARD_SCALE},0,0)`);
    const all = demo.texts.map((one) => one.text);
    expect(all).toEqual(expect.arrayContaining(["TU 2026", "EN MOTO", "KILÓMETROS", "SALIDAS", "HORAS EN MARCHA", "RUTA MÁS LARGA", "MES CON MÁS KM"]));
    // Each figure: the number in white Barlow, its unit after it in red.
    for (const item of content.items) {
      const [number, unit] = splitUnit(item.value);
      const drawn = demo.texts.find((one) => one.text === number);
      expect(drawn, item.label).toBeDefined();
      expect(drawn?.font).toMatch(/^700 \d+px "Barlow Condensed"/);
      if (unit !== "") expect(demo.texts.find((one) => one.text === unit.toUpperCase())?.fill).toBe("#ff4a4a");
    }
    // 82,5 km, 2 rides, 1,5 h (whole hours on the card, as in section 01), 70 km, July.
    expect(all).toEqual(expect.arrayContaining(["83", "2", "70,0", "julio · 83", "H"]));
    // Labels in Manrope, title in Barlow 800.
    expect(demo.texts.find((one) => one.text === "SALIDAS")?.font).toMatch(/"Manrope"/);
    expect(demo.texts.find((one) => one.text === "TU 2026")?.font).toMatch(/^800 \d+px "Barlow Condensed"/);
    // Numbered red tags 01 to 05.
    expect(["01", "02", "03", "04", "05"].every((tag) => all.includes(tag))).toBe(true);
  });

  it("never draws a speed, a coordinate or a date of a single ride, and marks synthetic data only in the demo", () => {
    const demo = recordingCanvas();
    drawCard(demo.canvas, cardContent(list, 2026, true));
    const real = recordingCanvas();
    drawCard(real.canvas, cardContent(list, 2026, false));
    for (const drawn of [demo, real]) {
      const text = drawn.texts.map((one) => one.text).join(" | ");
      expect(text).not.toMatch(/km\/h|KM\/H|123|98|47\b|velocidad|VELOCIDAD/i);
      expect(text).not.toMatch(/-?\d+\.\d{3,}/);
      expect(text).not.toMatch(/\b(?:4|5) jul|2026-07/);
    }
    expect(demo.texts.map((one) => one.text)).toContain("DATOS DE EJEMPLO");
    expect(real.texts.map((one) => one.text)).not.toContain("DATOS DE EJEMPLO");
    expect(real.texts.length).toBe(demo.texts.length - 1);
    expect(cardText(cardContent(list, 2026, false))).not.toMatch(/km\/h|123/);
  });

  it("says so when the browser gives no canvas", () => {
    const none = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(drawCard(none, cardContent(list, 2026, true))).toBe(false);
    expect(paintCard(none, cardContent(list, 2026, true), () => undefined)).toBe(false);
  });
});

describe("share card fonts", () => {
  function fontsThatLoad(): { load: ReturnType<typeof vi.fn>; release: () => void; fail: () => void } {
    let release = (): void => undefined;
    let fail = (): void => undefined;
    const waiting = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = () => reject(new Error("font"));
    });
    const load = vi.fn(() => waiting);
    Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
    return { load, release, fail };
  }

  it("waits for the page's fonts before drawing, then draws once", async () => {
    const fonts = fontsThatLoad();
    const card = recordingCanvas();
    const drawn = vi.fn();
    expect(paintCard(card.canvas, cardContent(list, 2026, true), drawn)).toBe(true);
    expect(fonts.load.mock.calls.map((call) => call[0])).toEqual([...CARD_FONTS]);
    await Promise.resolve();
    expect(card.texts).toHaveLength(0);
    expect(drawn).not.toHaveBeenCalled();
    fonts.release();
    await vi.waitFor(() => expect(drawn).toHaveBeenCalledTimes(1));
    expect(card.texts.length).toBeGreaterThan(10);
  });

  it("draws with the fallback fonts when the fonts fail or take too long", async () => {
    const failing = fontsThatLoad();
    const one = recordingCanvas();
    const drawnOne = vi.fn();
    paintCard(one.canvas, cardContent(list, 2026, true), drawnOne);
    failing.fail();
    await vi.waitFor(() => expect(drawnOne).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    fontsThatLoad();
    const two = recordingCanvas();
    const drawnTwo = vi.fn();
    paintCard(two.canvas, cardContent(list, 2026, true), drawnTwo, { fontTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(drawnTwo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(drawnTwo).toHaveBeenCalledTimes(1);
  });

  it("draws nothing when the page replaced the card before the fonts arrived", async () => {
    const fonts = fontsThatLoad();
    const card = recordingCanvas();
    const drawn = vi.fn();
    const view = new AbortController();
    paintCard(card.canvas, cardContent(list, 2026, true), drawn, { signal: view.signal });
    view.abort();
    fonts.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drawn).not.toHaveBeenCalled();
    expect(card.texts).toHaveLength(0);
  });
});
