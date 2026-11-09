import { describe, expect, it } from "vitest";
import { createRandom } from "../src/demo/random";
import type { LatLng, TraceLine } from "../src/domain/model";
import { sanitizeRouteTrace } from "../src/domain/sanitize";
import { distanceMeters, trimTrace } from "../src/domain/trim";

/**
 * The second rule of the trim: nothing is drawn within 400 m, in a straight
 * line, of where the ride starts or ends, however it got there and in
 * whatever order the service sends the lines.
 */
const M_PER_DEG = (Math.PI * 6_371_008.8) / 180;
const LAT0 = 40;
const LON0 = -1;
const north = (metres: number): LatLng => [LAT0 + metres / M_PER_DEG, LON0];
const northing = (point: LatLng): number => (point[0] - LAT0) * M_PER_DEG;
/** Rounded to whole metres, to compare with numbers worked out by hand. */
const northings = (lines: readonly TraceLine[]): number[][] => lines.map((line) => line.points.map((point) => Math.round(northing(point))));

interface Shape {
  readonly lines: readonly (readonly LatLng[])[];
  /** The start and end `Point` features, when they differ from the ends of the lines. */
  readonly ends?: readonly unknown[];
}

function detail(shape: Shape): unknown {
  const raw = (point: LatLng): number[] => [point[1], point[0], 0];
  const points = shape.ends ?? [];
  return {
    geojson: {
      type: "FeatureCollection",
      features: [
        ...points.map((coordinates) => ({ type: "Feature", geometry: { type: "Point", coordinates }, properties: {} })),
        ...shape.lines.map((line) => ({ type: "Feature", geometry: { type: "LineString", coordinates: line.map(raw) }, properties: { inferred: false } })),
      ],
    },
  };
}

const trim = (shape: Shape) => trimTrace(sanitizeRouteTrace(detail(shape)));

/** The smallest straight distance from anything drawn (points and what lies between them) to a place. */
function nearest(lines: readonly TraceLine[], place: LatLng): number {
  let best = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    for (let i = 1; i < line.points.length; i += 1) {
      const a = line.points[i - 1] as LatLng;
      const b = line.points[i] as LatLng;
      for (let step = 0; step <= 200; step += 1) {
        const t = step / 200;
        best = Math.min(best, distanceMeters([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], place));
      }
    }
  }
  return best;
}

describe("trim by place", () => {
  it("does not draw the start when the ride comes back over it", () => {
    // Out 200 m and back twice, then away: by distance alone the start would be drawn.
    const result = trim({ lines: [[north(0), north(200), north(0), north(200), north(0), north(3000)]] });
    expect(northings(result.lines)).toEqual([[401, 2599]]);
  });

  it("splits a round trip in two around the place where it starts and ends", () => {
    const result = trim({ lines: [[north(0), north(1000), north(0), north(-1000), north(0)]] });
    expect(northings(result.lines)).toEqual([
      [401, 1000, 401],
      [-401, -1000, -401],
    ]);
    expect(nearest(result.lines, north(0))).toBeGreaterThanOrEqual(400);
  });

  it("hides a ride that never leaves the surroundings of its start", () => {
    const loop: LatLng[] = [north(0), north(300), [LAT0 + 300 / M_PER_DEG, LON0 + 0.003], [LAT0, LON0 + 0.003], north(0)];
    const length = loop.slice(1).reduce((sum, point, index) => sum + distanceMeters(loop[index] as LatLng, point), 0);
    // Longer than twice the trim, so only the rule by place can hide it.
    expect(length).toBeGreaterThan(1000);
    expect(trim({ lines: [loop] })).toEqual({ lines: [], empty: "hidden" });
  });

  it("hides the real start and end even if the lines arrive out of order", () => {
    const ends = [[LON0, LAT0, 0], [LON0, LAT0 + 6000 / M_PER_DEG, 0]];
    const result = trim({ lines: [[north(3000), north(6000)], [north(0), north(3000)]], ends });
    expect(northings(result.lines)).toEqual([
      [3401, 5599],
      [401, 2599],
    ]);
    expect(nearest(result.lines, north(0))).toBeGreaterThanOrEqual(400);
    expect(nearest(result.lines, north(6000))).toBeGreaterThanOrEqual(400);
  });

  it("hides the real start even if a line arrives reversed", () => {
    const ends = [[LON0, LAT0, 0], [LON0, LAT0 + 6000 / M_PER_DEG, 0]];
    const result = trim({ lines: [[north(3000), north(0)], [north(3000), north(6000)]], ends });
    expect(nearest(result.lines, north(0))).toBeGreaterThanOrEqual(400);
    expect(nearest(result.lines, north(6000))).toBeGreaterThanOrEqual(400);
    expect(result.lines.length).toBeGreaterThan(0);
  });

  it("ignores a malformed start or end point instead of failing the whole route", () => {
    const result = trim({ lines: [[north(0), north(2000)]], ends: [["x", "y"], null, [LON0, 95, 0]] });
    expect(northings(result.lines)).toEqual([[401, 1599]]);
  });

  it("keeps its distance on long slanted segments, where degrees are not metres", () => {
    for (const [a, b] of [
      [[70, 20], [71, 21.5]],
      [[60, 0], [60.05, 0.1]],
      [[-45, 170], [-44.2, 171.3]],
    ] as [LatLng, LatLng][]) {
      const result = trim({ lines: [[a, b]] });
      expect(result.lines.length).toBe(1);
      expect(nearest(result.lines, a)).toBeGreaterThanOrEqual(400);
      expect(nearest(result.lines, b)).toBeGreaterThanOrEqual(400);
      // And it does not throw away much more than it has to.
      expect(nearest(result.lines, a)).toBeLessThan(410);
      expect(nearest(result.lines, b)).toBeLessThan(410);
    }
  });

  it("never draws within 400 m of the start or the end of random wandering traces", () => {
    const random = createRandom(77);
    let drawn = 0;
    for (let round = 0; round < 300; round += 1) {
      const lines: LatLng[][] = [];
      let position: LatLng = [LAT0 + random.between(-0.01, 0.01), LON0 + random.between(-0.01, 0.01)];
      const lineCount = random.int(1, 3);
      for (let l = 0; l < lineCount; l += 1) {
        const line: LatLng[] = [position];
        const pointCount = random.int(1, 9);
        for (let p = 0; p < pointCount; p += 1) {
          // Short and long hops, often turning back towards where it began.
          const reach = random.chance(0.3) ? 0.02 : 0.004;
          position = random.chance(0.15)
            ? (lines[0]?.[0] ?? line[0] as LatLng)
            : [position[0] + random.between(-reach, reach), position[1] + random.between(-reach, reach)];
          line.push(position);
        }
        lines.push(line);
        if (random.chance(0.3)) position = [position[0] + random.between(-0.005, 0.005), position[1] + random.between(-0.005, 0.005)];
      }
      const start = lines[0]?.[0] as LatLng;
      const end = lines[lines.length - 1]?.slice(-1)[0] as LatLng;
      const result = trim({ lines });
      if (result.lines.length === 0) continue;
      drawn += 1;
      expect(nearest(result.lines, start)).toBeGreaterThanOrEqual(400);
      expect(nearest(result.lines, end)).toBeGreaterThanOrEqual(400);
      for (const line of result.lines) {
        expect(line.points.length).toBeGreaterThanOrEqual(2);
        for (const point of line.points) expect(Number.isFinite(point[0]) && Number.isFinite(point[1])).toBe(true);
      }
    }
    expect(drawn).toBeGreaterThan(150);
  });
});
