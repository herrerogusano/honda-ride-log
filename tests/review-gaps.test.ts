// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import type { ToolCaller } from "../src/service/contract";
import { loadAllRoutes, LoadError } from "../src/service/loader";
import { axisTicks, barChart } from "../src/ui/charts";
import { errorText } from "../src/ui/errors";

/** Behaviours a second independent check found without a test. */
const NOW = Date.parse("2026-11-09T12:00:00.000Z");

describe("axis of the charts", () => {
  it("uses steps of 1, 2 or 5 times a power of ten, also between two round peaks", () => {
    expect(axisTicks(10)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(axisTicks(11)).toEqual([0, 5, 10, 15]);
    expect(axisTicks(12)).toEqual([0, 5, 10, 15]);
    expect(axisTicks(25)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(axisTicks(26)).toEqual([0, 10, 20, 30]);
    expect(axisTicks(50)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(axisTicks(51)).toEqual([0, 20, 40, 60]);
    expect(axisTicks(250)).toEqual([0, 50, 100, 150, 200, 250]);
    expect(axisTicks(251)).toEqual([0, 100, 200, 300]);
    for (let peak = 0.5; peak < 300; peak += 0.5) {
      const ticks = axisTicks(peak);
      const step = (ticks[1] as number) - (ticks[0] as number);
      expect([1, 2, 5], `peak ${peak}`).toContain(step / 10 ** Math.floor(Math.log10(step)));
      expect(ticks.every((tick) => Number.isInteger(tick)), `peak ${peak}`).toBe(true);
      expect(ticks.length, `peak ${peak}`).toBeLessThanOrEqual(6);
      expect(ticks[ticks.length - 1], `peak ${peak}`).toBeGreaterThanOrEqual(peak);
    }
  });

  it("draws the zero line as the base and the others as grid", () => {
    const chart = barChart({ title: "t", categories: ["a"], categoryHeader: "c", series: [{ label: "s", values: [4] }], formatValue: String });
    expect([...chart.querySelectorAll("line")].map((line) => line.getAttribute("class"))).toEqual([
      "chart-base",
      "chart-grid",
      "chart-grid",
      "chart-grid",
      "chart-grid",
    ]);
  });
});

describe("a load nobody wants any more", () => {
  const rider = generateRider({ seed: 7, nowMs: NOW });

  it("stops before its next request and says it was cancelled, not that something broke", async () => {
    let calls = 0;
    let wanted = true;
    const caller: ToolCaller = {
      async callTool(name, args) {
        calls += 1;
        // The answer to the third request arrives after the user has left.
        if (calls === 3) wanted = false;
        return createDemoService(rider).callTool(name, args);
      },
    };
    let error: unknown;
    try {
      await loadAllRoutes(caller, NOW, undefined, () => wanted);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LoadError);
    const failure = error as LoadError;
    expect([failure.step, failure.kind, failure.detail]).toEqual(["routes", "cancelled", null]);
    expect(calls).toBe(3);
    expect(errorText(failure).code).toBe("routes/cancelled");
    expect(errorText(failure).explanation).toBe("La carga se ha interrumpido antes de terminar.");
  });

  it("asks before the very first request too", async () => {
    let calls = 0;
    const caller: ToolCaller = {
      async callTool(name, args) {
        calls += 1;
        return createDemoService(rider).callTool(name, args);
      },
    };
    await expect(loadAllRoutes(caller, NOW, undefined, () => false)).rejects.toBeInstanceOf(LoadError);
    expect(calls).toBe(0);
  });
});
