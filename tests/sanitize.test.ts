import { describe, expect, it } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { FORBIDDEN_MARK, generateRider } from "../src/demo/generator";
import { hideShortRoutes, MIN_ROUTE_KM, TRIM_METERS } from "../src/domain/privacy";
import {
  sanitizeRouteList,
  sanitizeRouteTrace,
  sanitizeVehicleDetails,
  sanitizeVehicleStatus,
  serviceRouteId,
  ShapeError,
} from "../src/domain/sanitize";
import type { RawRouteDetail, RawRouteList, RawRouteSummary } from "../src/service/contract";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const rider = generateRider({ seed: 21, nowMs: NOW });
const service = createDemoService(rider);

async function monthList(): Promise<RawRouteList> {
  return (await service.callTool("list_routes", { from_time: "2026-10-01", to_time: "2026-11-01" })) as RawRouteList;
}

function listOf(routes: unknown[]): unknown {
  return { routes, truncated: false, matched_routes: routes.length };
}

const sample = rider.routes[0] as RawRouteSummary;

describe("vehicle sanitizers", () => {
  it("keeps only model and mileage from the vehicle details", async () => {
    const info = sanitizeVehicleDetails(await service.callTool("get_vehicle_details", {}));
    expect(Object.keys(info).sort()).toEqual(["mileage", "model"]);
    expect(JSON.stringify(info).toUpperCase()).not.toContain(FORBIDDEN_MARK);
    expect(info.model).toBe("Demo 125");
    expect(info.mileage).toBe(rider.details.mileage);
  });

  it("drops the position from the vehicle status", async () => {
    const state = sanitizeVehicleStatus(await service.callTool("get_vehicle_status", {}));
    expect(Object.keys(state).sort()).toEqual(["batteryPercent", "lastCommunicationMs", "odometer", "status"]);
    const text = JSON.stringify(state);
    expect(text).not.toContain(String(rider.status.position.latitude));
    expect(text).not.toContain(String(rider.status.position.longitude));
    expect(text).not.toContain(rider.status.position.label as string);
    expect(state.batteryPercent).toBe(rider.status.battery);
    expect(state.odometer).toBe(rider.status.odometer);
    expect(state.lastCommunicationMs).toBe(rider.status.last_communication);
  });

  it("reports a wrong type by field path, without the value", () => {
    const secret = "valor-que-no-debe-salir";
    let message = "";
    try {
      sanitizeVehicleStatus({ status: "AT_REST", battery: secret, position: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(ShapeError);
      message = (error as ShapeError).message;
    }
    expect(message).toContain("get_vehicle_status.battery");
    expect(message).not.toContain(secret);
    expect(() => sanitizeVehicleDetails(null)).toThrow(ShapeError);
    expect(() => sanitizeVehicleDetails([])).toThrow(ShapeError);
  });
});

describe("route list sanitizer", () => {
  it("keeps every usable route and none of the identifiers", async () => {
    const raw = await monthList();
    const page = sanitizeRouteList(raw);
    expect(raw.routes.length).toBeGreaterThan(5);
    expect(page.routes.length).toBe(raw.routes.length);
    expect(page.skipped).toBe(0);
    expect(page.truncated).toBe(false);
    expect(page.matched).toBe(raw.matched_routes);
    expect(JSON.stringify(page)).not.toContain("rt-");
    for (const route of page.routes) {
      expect(Object.keys(route).sort()).toEqual([
        "averageSpeed",
        "distanceKm",
        "durationS",
        "endMs",
        "hasInferredSegments",
        "ref",
        "startMs",
      ]);
    }
  });

  it("converts instants and durations from the raw fields", () => {
    const page = sanitizeRouteList(listOf([sample]));
    const route = page.routes[0];
    const start = Date.parse(sample.started_at as string);
    const end = Date.parse(sample.ended_at as string);
    expect(route?.startMs).toBe(start);
    expect(route?.endMs).toBe(end);
    expect(route?.durationS).toBe((end - start) / 1000);
    expect(route?.distanceKm).toBe(sample.distance_km);
    expect(route?.averageSpeed).toBe(sample.average_speed);
    expect(route?.hasInferredSegments).toBe(sample.has_inferred_segments);
  });

  it("lets only the detail request recover the service id", () => {
    const page = sanitizeRouteList(listOf([sample]));
    const ref = page.routes[0]?.ref;
    if (ref === undefined) throw new Error("no route");
    expect(serviceRouteId(ref)).toBe(sample.route_id);
    expect(Object.keys(ref)).toEqual([]);
    expect(String(ref)).not.toContain("rt-");
    expect(() => serviceRouteId({} as typeof ref)).toThrow(ShapeError);
  });

  it("skips routes without a start or a km figure, and never converts the native distance", () => {
    const page = sanitizeRouteList(
      listOf([
        sample,
        { ...sample, route_id: "rt-DEMO-a", started_at: null },
        { ...sample, route_id: "rt-DEMO-b", distance_km: null, distance: 5000 },
        { ...sample, route_id: "rt-DEMO-c", started_at: "2026-03-01T10:00:00" },
        { ...sample, route_id: "rt-DEMO-d", distance_km: -1 },
      ]),
    );
    expect(page.routes.length).toBe(1);
    expect(page.skipped).toBe(4);
  });

  it("keeps a route whose end is missing or before its start, without a duration", () => {
    const page = sanitizeRouteList(
      listOf([
        { ...sample, ended_at: null },
        { ...sample, route_id: "rt-DEMO-e", ended_at: "2000-01-01T00:00:00.000Z" },
      ]),
    );
    expect(page.routes.map((r) => [r.endMs, r.durationS])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it("sorts routes by start", () => {
    const later = { ...sample, route_id: "rt-DEMO-f", started_at: "2030-01-01T00:00:00.000Z", ended_at: null };
    const page = sanitizeRouteList(listOf([later, sample]));
    expect(page.routes.map((r) => r.startMs)).toEqual([
      Date.parse(sample.started_at as string),
      Date.parse("2030-01-01T00:00:00.000Z"),
    ]);
  });

  it("rejects an envelope it cannot trust", () => {
    expect(() => sanitizeRouteList({ routes: [], matched_routes: 0 })).toThrow(ShapeError);
    expect(() => sanitizeRouteList({ routes: "x", truncated: false, matched_routes: 0 })).toThrow(ShapeError);
    expect(() => sanitizeRouteList({ routes: [sample], truncated: false, matched_routes: 0 })).toThrow(ShapeError);
    expect(() => sanitizeRouteList(listOf([{ ...sample, route_id: 5 }]))).toThrow(ShapeError);
    expect(() => sanitizeRouteList(listOf([{ ...sample, distance_km: "12" }]))).toThrow(ShapeError);
  });
});

describe("short route rule", () => {
  it("uses the thresholds the owner decided", () => {
    // Changing either number is a privacy decision: update docs/PLAN.md too.
    expect(MIN_ROUTE_KM).toBe(0.3);
    expect(TRIM_METERS).toBe(400);
  });

  it("hides routes under the threshold and counts them", () => {
    const page = sanitizeRouteList(
      listOf([
        { ...sample, route_id: "rt-DEMO-g", distance_km: MIN_ROUTE_KM },
        { ...sample, route_id: "rt-DEMO-h", distance_km: MIN_ROUTE_KM - 0.001 },
        { ...sample, route_id: "rt-DEMO-i", distance_km: 0.04 },
        { ...sample, route_id: "rt-DEMO-j", distance_km: 12 },
      ]),
    );
    const split = hideShortRoutes(page.routes);
    expect(split.visible.map((r) => r.distanceKm)).toEqual([MIN_ROUTE_KM, 12]);
    expect(split.hiddenCount).toBe(2);
  });

  it("finds short routes in the synthetic history", () => {
    const page = sanitizeRouteList(listOf([...rider.routes]));
    const split = hideShortRoutes(page.routes);
    expect(split.hiddenCount).toBeGreaterThan(0);
    expect(split.visible.length + split.hiddenCount).toBe(rider.routes.length);
  });
});

describe("route trace sanitizer", () => {
  const inferredRoute = rider.routes.find(
    (r) => r.has_inferred_segments === true && (r.distance as number) > 5000,
  ) as RawRouteSummary;
  const detail = rider.detail(inferredRoute.route_id) as RawRouteDetail;

  it("keeps the lines in latitude-longitude order and discards the start and end points", () => {
    const trace = sanitizeRouteTrace(detail);
    const rawLines = detail.geojson?.features.filter((f) => f.geometry.type === "LineString") ?? [];
    expect(rawLines.length).toBe(2);
    expect(trace.lines.length).toBe(rawLines.length);
    expect(trace.lines.length).toBe((detail.geojson?.features.length ?? 0) - 2);
    trace.lines.forEach((line, index) => {
      const raw = rawLines[index]?.geometry.coordinates as number[][];
      expect(line.points).toEqual(raw.map(([longitude, latitude]) => [latitude, longitude]));
      expect(line.inferred).toBe(rawLines[index]?.properties.inferred);
    });
    expect(trace.lines.some((line) => line.inferred === true)).toBe(true);
    expect(JSON.stringify(trace)).not.toContain("rt-");
  });

  it("treats a missing flag as unknown and a missing geometry as no lines", () => {
    const first = detail.geojson?.features.find((f) => f.geometry.type === "LineString");
    const noFlag = { geojson: { type: "FeatureCollection", features: [{ ...first, properties: {} }] } };
    expect(sanitizeRouteTrace(noFlag).lines[0]?.inferred).toBeNull();
    expect(sanitizeRouteTrace({ geojson: null }).lines).toEqual([]);
    expect(sanitizeRouteTrace({}).lines).toEqual([]);
  });

  it("rejects coordinates that are not a place on Earth", () => {
    const bad = (coordinates: unknown): unknown => ({
      geojson: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: { type: "LineString", coordinates }, properties: {} }],
      },
    });
    expect(() => sanitizeRouteTrace(bad([[0, 91, 0]]))).toThrow(ShapeError);
    expect(() => sanitizeRouteTrace(bad([["a", 1, 0]]))).toThrow(ShapeError);
    expect(() => sanitizeRouteTrace(bad("x"))).toThrow(ShapeError);
  });
});
