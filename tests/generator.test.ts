import { describe, expect, it } from "vitest";
import { DEMO_BASE, generateRider, type SyntheticRider } from "../src/demo/generator";
import { MAX_RETURNED_ROUTES, type RawRouteSummary } from "../src/service/contract";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const commuter = generateRider({ seed: 7, nowMs: NOW });
const heavy = generateRider({ seed: 7, nowMs: NOW, profile: "heavy" });

// Field names and types as recorded from real answers (shape only).
const SUMMARY_SHAPE: Record<keyof RawRouteSummary, string[]> = {
  route_id: ["string"],
  started_at: ["string"],
  ended_at: ["string"],
  distance: ["number"],
  distance_km: ["number"],
  conversion_basis: ["string"],
  has_inferred_segments: ["boolean"],
  inference_quality_status: ["string"],
  inference_quality_source: ["string"],
  inference_quality_warning: ["string"],
  average_speed: ["number"],
  maximum_speed: ["number"],
  complete: ["boolean"],
  timezone: ["string", "null"],
  odometer_start: ["null"],
  odometer_end: ["null"],
};

const typeName = (value: unknown): string => (value === null ? "null" : typeof value);

function expectSummaryShape(item: object): void {
  const record = item as Record<string, unknown>;
  for (const [key, allowed] of Object.entries(SUMMARY_SHAPE)) {
    expect(allowed, `field ${key}`).toContain(typeName(record[key]));
  }
}

function semesterCounts(rider: SyntheticRider): number[] {
  const counts = new Map<string, number>();
  for (const route of rider.routes) {
    const date = new Date(route.started_at as string);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth() < 6 ? 1 : 2}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()];
}

describe("synthetic rider", () => {
  it("is reproducible for a seed and differs between seeds", () => {
    const again = generateRider({ seed: 7, nowMs: NOW });
    expect(again.routes).toEqual(commuter.routes);
    expect(again.status).toEqual(commuter.status);
    const firstId = commuter.routes[0]?.route_id as string;
    expect(again.detail(firstId)).toEqual(commuter.detail(firstId));
    const other = generateRider({ seed: 8, nowMs: NOW });
    expect(other.routes.map((r) => r.route_id)).not.toEqual(commuter.routes.map((r) => r.route_id));
  });

  it("gives every route exactly the fields and types of a real list item", () => {
    expect(commuter.routes.length).toBeGreaterThan(300);
    for (const route of commuter.routes) {
      expect(Object.keys(route).sort()).toEqual(Object.keys(SUMMARY_SHAPE).sort());
      expectSummaryShape(route);
      expect(route.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Number.isInteger(route.distance)).toBe(true);
      expect(route.distance_km).toBeCloseTo((route.distance as number) / 1000, 9);
      expect(route.complete).toBe(false);
    }
  });

  it("uses visibly synthetic ids of the real length, all different", () => {
    const ids = commuter.routes.map((route) => route.route_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^rt-DEMO[0-9A-Za-z]{23}$/);
  });

  it("is ordered, never overlaps and never runs past now", () => {
    let previousEnd = 0;
    for (const route of commuter.routes) {
      const start = Date.parse(route.started_at as string);
      const end = Date.parse(route.ended_at as string);
      expect(start).toBeGreaterThanOrEqual(previousEnd);
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(NOW);
      previousEnd = end;
    }
  });

  it("contains the awkward cases seen in real data", () => {
    const routes = commuter.routes;
    expect(routes.some((r) => (r.distance as number) < 100)).toBe(true);
    expect(routes.some((r) => (r.distance_km as number) < 0.3)).toBe(true);
    expect(routes.some((r) => r.has_inferred_segments === true)).toBe(true);
    expect(routes.some((r) => r.has_inferred_segments === false)).toBe(true);
    expect(routes.some((r) => r.timezone === null)).toBe(true);
    expect(routes.some((r) => (r.distance_km as number) > 100)).toBe(true);
    for (const route of routes) {
      expect(route.inference_quality_status).toBe(
        route.has_inferred_segments ? "inferred_present" : "none_marked_inferred",
      );
    }
  });

  it("has whole months without routes inside the history", () => {
    const busy = new Set(commuter.routes.map((r) => (r.started_at as string).slice(0, 7)));
    const first = new Date(commuter.routes[0]?.started_at as string);
    const lastKey = new Date(NOW).toISOString().slice(0, 7);
    const empty: string[] = [];
    for (let month = first.getUTCMonth(); ; month += 1) {
      const key = new Date(Date.UTC(first.getUTCFullYear(), month, 1)).toISOString().slice(0, 7);
      if (key > lastKey) break;
      if (!busy.has(key)) empty.push(key);
    }
    expect(empty.length).toBeGreaterThanOrEqual(2);
    expect(busy.has(lastKey)).toBe(true);
  });

  it("has a heavy profile that exceeds the list limit in one semester, and a commuter that does not", () => {
    expect(Math.max(...semesterCounts(heavy))).toBeGreaterThan(MAX_RETURNED_ROUTES);
    expect(Math.max(...semesterCounts(commuter))).toBeLessThan(MAX_RETURNED_ROUTES);
  });

  it("builds details with the real GeoJSON layout", () => {
    let fourFeatures = 0;
    let trimmed = 0;
    for (const route of commuter.routes.slice(0, 250)) {
      const detail = commuter.detail(route.route_id);
      if (detail === undefined || detail.geojson === null) throw new Error("missing detail");
      expectSummaryShape(detail);
      expect(detail.metric_unit).toBe("mapit_native_unconfirmed");
      expect(typeof detail.merged).toBe("boolean");
      expect(typeof detail.starts_at_last_known).toBe("boolean");
      const features = detail.geojson.features;
      expect([3, 4]).toContain(features.length);
      if (features.length === 4) fourFeatures += 1;
      if (detail.geometry_trimmed_end_m !== undefined) trimmed += 1;
      const [start, end, ...lines] = features;
      expect(start?.geometry.type).toBe("Point");
      expect(start?.properties.name).toBe("start");
      expect(end?.geometry.type).toBe("Point");
      expect(end?.properties.name).toBe("end");
      const all: number[][] = [];
      for (const line of lines) {
        expect(line.geometry.type).toBe("LineString");
        const coordinates = line.geometry.coordinates as number[][];
        expect(coordinates.length).toBeGreaterThanOrEqual(2);
        expect(coordinates.length).toBeLessThanOrEqual(181);
        all.push(...coordinates);
      }
      for (const [longitude, latitude, third, ...rest] of all) {
        // GeoJSON order: longitude first. The base point tells them apart.
        expect(Math.abs((latitude as number) - DEMO_BASE[0])).toBeLessThan(3);
        expect(Math.abs((longitude as number) - DEMO_BASE[1])).toBeLessThan(4);
        expect(third).toBe(0);
        expect(rest).toEqual([]);
      }
      expect(start?.geometry.coordinates).toEqual(all[0]);
      expect(end?.geometry.coordinates).toEqual(all[all.length - 1]);
      expect(lines.some((line) => line.properties.inferred === true)).toBe(route.has_inferred_segments);
    }
    expect(fourFeatures).toBeGreaterThan(0);
    expect(trimmed).toBeGreaterThan(0);
    expect(commuter.detail("rt-unknown")).toBeUndefined();
  });

  it("marks every field the web must hide in the vehicle details", () => {
    const { model, mileage, units_confirmed: unitsConfirmed, dealer, ...hidden } = commuter.details;
    expect(model).toBe("Demo 125");
    expect(typeof mileage).toBe("number");
    expect(unitsConfirmed).toBe(false);
    for (const value of [...Object.values(hidden), ...Object.values(dealer ?? {}).flat()]) {
      expect(String(value).toUpperCase()).toContain("NO-MOSTRAR");
    }
  });
});
