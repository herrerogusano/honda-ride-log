import { describe, expect, it } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import type { LatLng, TraceLine } from "../src/domain/model";
import { TRIM_METERS } from "../src/domain/privacy";
import { sanitizeRouteTrace } from "../src/domain/sanitize";
import { distanceMeters, trimTrace } from "../src/domain/trim";
import type { RawRouteDetail } from "../src/service/contract";

/** Metres per degree of latitude on the sphere the trim uses. */
const M_PER_DEG = (Math.PI * 6_371_008.8) / 180;
const LAT0 = 40;
const LON0 = -1;
/** A point `metres` north of the origin: distances along a meridian are exact. */
const north = (metres: number): LatLng => [LAT0 + metres / M_PER_DEG, LON0];
/** How many metres north of the origin a point is. */
const northing = (point: LatLng): number => (point[0] - LAT0) * M_PER_DEG;

interface TestLine {
  inferred: boolean;
  points: LatLng[];
}

/** A raw detail in the service's shape, start and end `Point` features included. */
function rawDetail(lines: TestLine[]): unknown {
  const raw = (point: LatLng): number[] => [point[1], point[0], 0];
  const first = lines[0]?.points[0] ?? north(0);
  const last = lines[lines.length - 1]?.points.slice(-1)[0] ?? north(0);
  return {
    geojson: {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: raw(first) }, properties: { name: "start", label: "S" } },
        { type: "Feature", geometry: { type: "Point", coordinates: raw(last) }, properties: { name: "end", label: "E" } },
        ...lines.map((line) => ({
          type: "Feature",
          geometry: { type: "LineString", coordinates: line.points.map(raw) },
          properties: { name: line.inferred ? "inferred route" : "detected route", inferred: line.inferred },
        })),
      ],
    },
  };
}

const trim = (lines: TestLine[]) => trimTrace(sanitizeRouteTrace(rawDetail(lines)));
const northings = (line: TraceLine | undefined): number[] => (line?.points ?? []).map(northing);

function expectMetres(actual: number[], expected: number[]): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) => expect(Math.abs(value - (expected[index] as number))).toBeLessThan(0.01));
}

function pathLength(lines: readonly TraceLine[]): number {
  let total = 0;
  for (const line of lines) {
    for (let i = 1; i < line.points.length; i += 1) {
      total += distanceMeters(line.points[i - 1] as LatLng, line.points[i] as LatLng);
    }
  }
  return total;
}

describe("distanceMeters", () => {
  it("matches a known distance between two cities", () => {
    // Madrid to Barcelona is about 505 km as the crow flies.
    const km = distanceMeters([40.4168, -3.7038], [41.3874, 2.1686]) / 1000;
    expect(km).toBeGreaterThan(503);
    expect(km).toBeLessThan(507);
  });

  it("shrinks a degree of longitude with the latitude", () => {
    expect(distanceMeters([0, 0], [0, 1])).toBeCloseTo(M_PER_DEG, 3);
    expect(distanceMeters([60, 0], [60, 1])).toBeCloseTo(M_PER_DEG / 2, -2);
    expect(distanceMeters([10, 20], [10, 20])).toBe(0);
  });
});

describe("trimTrace", () => {
  it("is set to 400 metres", () => {
    expect(TRIM_METERS).toBe(400);
  });

  it("cuts 400 m from each end by distance, inside the segment", () => {
    const result = trim([{ inferred: false, points: [north(0), north(1000), north(2000)] }]);
    expect(result.empty).toBeNull();
    expect(result.lines.length).toBe(1);
    expectMetres(northings(result.lines[0]), [400, 1000, 1600]);
  });

  it("interpolates both ends of a single long segment instead of dropping its points", () => {
    const result = trim([{ inferred: false, points: [north(0), north(5000)] }]);
    expectMetres(northings(result.lines[0]), [400, 4600]);
  });

  it("drops the points inside the cut and keeps the ones between", () => {
    const result = trim([{ inferred: false, points: [north(0), north(100), north(700), north(2500), north(2600)] }]);
    expectMetres(northings(result.lines[0]), [400, 700, 2200]);
  });

  it("never returns the exact start or end of the ride", () => {
    const points = [north(0), north(350), north(900), north(1300)];
    const result = trim([{ inferred: false, points }]);
    const kept = northings(result.lines[0]);
    expect(Math.min(...kept)).toBeGreaterThan(399.99);
    expect(Math.max(...kept)).toBeLessThan(900.01);
  });

  it("leaves nothing of a trace of 800 m or less, and says it is hidden", () => {
    for (const metres of [5, 400, 790, 799.9]) {
      const result = trim([{ inferred: false, points: [north(0), north(metres / 2), north(metres)] }]);
      expect(result.lines).toEqual([]);
      expect(result.empty).toBe("hidden");
    }
  });

  it("keeps only the middle of a trace slightly longer than 800 m", () => {
    const result = trim([{ inferred: false, points: [north(0), north(900)] }]);
    expectMetres(northings(result.lines[0]), [400, 500]);
  });

  it("trims several lines as one trace and keeps each line's inferred flag", () => {
    const result = trim([
      { inferred: true, points: [north(0), north(1000)] },
      { inferred: false, points: [north(1000), north(2000)] },
    ]);
    expect(result.lines.map((line) => line.inferred)).toEqual([true, false]);
    expectMetres(northings(result.lines[0]), [400, 1000]);
    expectMetres(northings(result.lines[1]), [1000, 1600]);
  });

  it("removes whole lines that fall inside the trimmed ends", () => {
    const result = trim([
      { inferred: true, points: [north(0), north(300)] },
      { inferred: false, points: [north(300), north(1500)] },
      { inferred: true, points: [north(1500), north(1800)] },
    ]);
    expect(result.lines.length).toBe(1);
    expect(result.lines[0]?.inferred).toBe(false);
    expectMetres(northings(result.lines[0]), [400, 1400]);
  });

  it("does not count the gap between two lines as travelled distance", () => {
    const result = trim([
      { inferred: false, points: [north(0), north(600)] },
      { inferred: false, points: [north(5000), north(5600)] },
    ]);
    expectMetres(northings(result.lines[0]), [400, 600]);
    expectMetres(northings(result.lines[1]), [5000, 5200]);
  });

  it("survives repeated points without producing NaN", () => {
    const result = trim([{ inferred: false, points: [north(0), north(0), north(1000), north(1000), north(2000)] }]);
    expectMetres(northings(result.lines[0]), [400, 1000, 1600]);
  });

  it("measures along a parallel too, where a degree of longitude is shorter", () => {
    const metresPerDegLon = M_PER_DEG * Math.cos((60 * Math.PI) / 180);
    const east = (metres: number): LatLng => [60, metres / metresPerDegLon];
    const result = trim([{ inferred: false, points: [east(0), east(2000)] }]);
    const [from, to] = (result.lines[0]?.points ?? []) as LatLng[];
    expect(distanceMeters(east(0), from as LatLng)).toBeCloseTo(400, 0);
    expect(distanceMeters(to as LatLng, east(2000))).toBeCloseTo(400, 0);
  });

  it("reports a detail without any line as having no geometry", () => {
    expect(trimTrace(sanitizeRouteTrace({ geojson: null }))).toEqual({ lines: [], empty: "no_geometry" });
    expect(trim([])).toEqual({ lines: [], empty: "no_geometry" });
    expect(trim([{ inferred: false, points: [north(0)] }])).toEqual({ lines: [], empty: "no_geometry" });
  });

  it("shortens every synthetic trace by 800 m and hides the short ones", async () => {
    const rider = generateRider({ seed: 5, nowMs: Date.parse("2026-11-09T12:00:00.000Z") });
    const service = createDemoService(rider);
    let drawn = 0;
    let hidden = 0;
    for (const route of rider.routes.slice(0, 120)) {
      const raw = (await service.callTool("get_route_detail", { route_id: route.route_id })) as RawRouteDetail;
      const rawLines: TraceLine[] = (raw.geojson?.features ?? []).flatMap((feature) =>
        feature.geometry.type === "LineString"
          ? [{ inferred: null, points: feature.geometry.coordinates.map(([lon, lat]): LatLng => [lat, lon]) }]
          : [],
      );
      const total = pathLength(rawLines);
      const result = trimTrace(sanitizeRouteTrace(raw));
      if (total <= 2 * TRIM_METERS) {
        expect(result).toEqual({ lines: [], empty: "hidden" });
        hidden += 1;
        continue;
      }
      drawn += 1;
      expect(Math.abs(pathLength(result.lines) - (total - 2 * TRIM_METERS))).toBeLessThan(0.5);
      const start = rawLines[0]?.points[0] as LatLng;
      const end = rawLines[rawLines.length - 1]?.points.slice(-1)[0] as LatLng;
      for (const line of result.lines) {
        for (const point of line.points) {
          expect(point).not.toEqual(start);
          expect(point).not.toEqual(end);
          expect(Number.isFinite(point[0]) && Number.isFinite(point[1])).toBe(true);
        }
      }
    }
    // The sample must contain both kinds, or this test proves nothing.
    expect(drawn).toBeGreaterThan(50);
    expect(hidden).toBeGreaterThan(0);
  });
});
