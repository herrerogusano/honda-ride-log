// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import { routesToCsv } from "../src/domain/csv";
import type { LatLng } from "../src/domain/model";
import { untrimmedLines } from "../src/domain/sanitize";
import { screenTrace } from "../src/domain/trim";
import { loadAllRoutes, loadRouteTrace } from "../src/service/loader";
import { cardContent, cardText, drawCard } from "../src/ui/card";
import { createTraceStore } from "../src/ui/traceStore";

/**
 * The whole trace is drawn on the signed-in rider's screen only
 * (docs/PLAN.md, section 4). What can leave that screen (the shared card,
 * its text, the CSV download, the visit counters) carries no trace at all:
 * not whole, not trimmed. These tests run on the synthetic demo rider with
 * every route detail read first, so whole traces are in memory while the
 * card and the CSV are made.
 */
const NOW = Date.parse("2026-11-09T20:00:00.000Z");
const rider = generateRider({ seed: 8, nowMs: NOW });

/** Every way a coordinate could be written: as JavaScript prints it and cut to 3 to 6 decimals, with a point or a comma. */
function spellings(points: readonly LatLng[]): Set<string> {
  const all = new Set<string>();
  for (const point of points) {
    for (const value of point) {
      const forms = [String(value), ...[3, 4, 5, 6].map((digits) => value.toFixed(digits))];
      for (const form of forms) {
        all.add(form);
        all.add(form.replace(".", ","));
      }
    }
  }
  return all;
}

/** Every number with three or more decimals in a text. */
const decimals = (text: string): string[] => text.match(/-?\d+[.,]\d{3,}/g) ?? [];

/** A canvas whose context records every call with its arguments. */
function recordingCanvas(): { canvas: HTMLCanvasElement; calls: string[] } {
  const calls: string[] = [];
  const state: Record<string | symbol, unknown> = { font: "", fillStyle: "", letterSpacing: "0px" };
  const context = new Proxy(state, {
    get(_target, name) {
      if (name in state) return state[name];
      if (name === "measureText") return (text: string) => ({ width: text.length * 20 });
      return (...args: unknown[]) => void calls.push(`${String(name)}(${args.map(String).join(",")})`);
    },
    set(_target, name, value) {
      state[name] = value;
      return true;
    },
    has: (_target, name) => name in state,
  });
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  return { canvas, calls };
}

describe("what leaves the screen carries no trace", () => {
  it("the card, its text and the CSV hold no coordinate of any route, with every whole trace in memory", async () => {
    const service = createDemoService(rider);
    const routes = (await loadAllRoutes(service, NOW)).routes;
    const points: LatLng[] = [];
    // The store the map and the atlas share, really holding the whole traces.
    const store = createTraceStore(service);
    for (const route of routes.slice(0, 40)) {
      const trace = await loadRouteTrace(service, route.ref);
      points.push(...untrimmedLines(trace).flatMap((line) => line.points));
      expect(screenTrace(trace).lines.length).toBeGreaterThan(0);
      await store.get(route);
      expect(store.known(route.ref)?.lines).toEqual(screenTrace(trace).lines);
    }
    expect(points.length).toBeGreaterThan(100);
    const forbidden = spellings(points);

    const content = cardContent(routes, "all", false);
    const recorded = recordingCanvas();
    expect(drawCard(recorded.canvas, content)).toBe(true);
    const outputs = {
      card: JSON.stringify(content),
      cardText: cardText(content),
      cardDrawing: recorded.calls.join("\n"),
      csv: routesToCsv(routes),
    };
    for (const [name, text] of Object.entries(outputs)) {
      expect(text.length, name).toBeGreaterThan(0);
      expect(
        decimals(text).filter((number) => forbidden.has(number)),
        name,
      ).toEqual([]);
    }
  }, 30_000);

  it("the modules that make them import nothing that reaches a trace", () => {
    // A trace reaches code through the sealed detail (sanitize.ts), the trim
    // (trim.ts), the request for it (loadRouteTrace) or the store of the map
    // and the atlas (traceStore.ts). The card, the CSV, the download and the
    // visit counters import none of them; the map is not imported either.
    const files = [
      "src/ui/card.ts",
      "src/domain/csv.ts",
      "src/ui/download.ts",
      "src/ui/summary.ts",
      "src/analytics/tracker.ts",
      "src/analytics/config.ts",
      "src/analytics/consentNotice.ts",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)"/gm)].map((match) => match[0]);
      for (const line of imports) {
        expect(line, file).not.toMatch(/\/(trim|sanitize|traceStore|traceDraw|mapView|leafletSurface|atlas\/[^"]*)"|loadRouteTrace/);
      }
    }
  });
});
