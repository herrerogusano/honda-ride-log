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
  untrimmedLines,
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
    expect(() => sanitizeVehicleStatus({ odometer: "12000" })).toThrow(ShapeError);
    let textMessage = "";
    try {
      sanitizeVehicleDetails({ model: 987654321 });
    } catch (error) {
      textMessage = (error as ShapeError).message;
    }
    expect(textMessage).toContain("get_vehicle_details.model");
    expect(textMessage).not.toContain("987654321");
  });

  it("discards values that cannot be true and trims labels", () => {
    const state = sanitizeVehicleStatus({ status: " AT_REST\n", battery: 9999, odometer: -3, last_communication: -1 });
    expect(state).toEqual({ status: "AT_REST", batteryPercent: null, lastCommunicationMs: null, odometer: null });
    expect(sanitizeVehicleStatus({ battery: 0 }).batteryPercent).toBe(0);
    expect(sanitizeVehicleStatus({ battery: 100 }).batteryPercent).toBe(100);
    const info = sanitizeVehicleDetails({ model: "M".repeat(500), mileage: -1 });
    expect(info.model?.length).toBe(60);
    expect(info.mileage).toBeNull();
    expect(sanitizeVehicleDetails({ model: "   " }).model).toBeNull();
    // Zero is a real value, not an absent one.
    expect(sanitizeVehicleStatus({ odometer: 0, last_communication: 0 })).toMatchObject({
      odometer: 0,
      lastCommunicationMs: 0,
    });
    expect(sanitizeVehicleDetails({ mileage: 0 }).mileage).toBe(0);
    // JSON can carry -0: it is kept as 0, never as -0 (which Intl writes "-0").
    expect(Object.is(sanitizeVehicleStatus({ odometer: -0 }).odometer, 0)).toBe(true);
    expect(Object.is(sanitizeVehicleDetails({ mileage: -0 }).mileage, 0)).toBe(true);
    expect(Object.is(sanitizeVehicleStatus(JSON.parse('{"odometer": -0}')).odometer, 0)).toBe(true);
    // Tab, DEL, a bidi override and a zero-width space are not label text.
    expect(sanitizeVehicleDetails({ model: "A\tB\u007fC\u202eD\u200bE" }).model).toBe("A B C D E");
    const emoji = "\u{1F3CD}";
    const cut = sanitizeVehicleDetails({ model: "M".repeat(59) + emoji + "tail" }).model as string;
    expect(Array.from(cut).length).toBe(60);
    expect(cut.endsWith(emoji)).toBe(true);
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
        // Added deliberately by the owner's decision of 2026-11-10; nothing else joins it.
        "maxSpeed",
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

  it("copies the maximum speed, and nothing else the list sends about it", () => {
    expect(typeof sample.maximum_speed).toBe("number");
    expect(sample.maximum_speed).not.toBe(sample.average_speed);
    const route = sanitizeRouteList(listOf([sample])).routes[0];
    expect(route?.maxSpeed).toBe(sample.maximum_speed);
    expect(sanitizeRouteList(listOf([{ ...sample, maximum_speed: 0 }])).routes[0]?.maxSpeed).toBe(0);
    expect(sanitizeRouteList(listOf([{ ...sample, maximum_speed: 97.5 }])).routes[0]?.maxSpeed).toBe(97.5);
    // A -0 from JSON becomes 0 for both speeds, so no "-0" is ever written.
    const zero = sanitizeRouteList(JSON.parse(JSON.stringify(listOf([{ ...sample }])).replace(/"average_speed":[^,}]+/, '"average_speed":-0').replace(/"maximum_speed":[^,}]+/, '"maximum_speed":-0'))).routes[0];
    expect([Object.is(zero?.averageSpeed, 0), Object.is(zero?.maxSpeed, 0)]).toEqual([true, true]);
    // Still dropped: the route's odometers, time zone and the service's quality texts.
    const text = JSON.stringify(
      sanitizeRouteList(listOf([{ ...sample, odometer_start: 12345, odometer_end: 12399, timezone: "Europe/Madrid" }])),
    );
    expect(text).not.toContain("12345");
    expect(text).not.toContain("Europe/");
    expect(text).not.toContain("inferred_present");
    expect(text).not.toContain("none_marked_inferred");
  });

  it("turns a maximum speed that cannot be true into an absent one, without losing the route", () => {
    for (const bad of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, "88", "", true, {}, [90], null, undefined]) {
      const page = sanitizeRouteList(listOf([{ ...sample, maximum_speed: bad }]));
      expect(page.skipped, String(bad)).toBe(0);
      expect(page.routes[0]?.maxSpeed, String(bad)).toBeNull();
    }
    const withoutMax: Record<string, unknown> = { ...sample };
    delete withoutMax["maximum_speed"];
    expect(sanitizeRouteList(listOf([withoutMax])).routes[0]?.maxSpeed).toBeNull();
  });

  it("lets only the detail request recover the service id", () => {
    const page = sanitizeRouteList(listOf([sample]));
    const ref = page.routes[0]?.ref;
    if (ref === undefined) throw new Error("no route");
    expect(serviceRouteId(ref)).toBe(sample.route_id);
    // Nothing on the handle itself, enumerable or not, own or inherited.
    expect(Reflect.ownKeys(ref)).toEqual([]);
    expect(Object.getPrototypeOf(ref)).toBe(Object.prototype);
    expect(Object.isFrozen(ref)).toBe(true);
    expect(JSON.stringify(ref)).toBe("{}");
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

  it("accepts instants with an offset and an end equal to the start", () => {
    const page = sanitizeRouteList(
      listOf([{ ...sample, started_at: "2026-03-01T12:00:00+02:00", ended_at: "2026-03-01T10:00:00.000Z" }]),
    );
    expect(page.routes[0]?.startMs).toBe(Date.parse("2026-03-01T10:00:00.000Z"));
    expect(page.routes[0]?.endMs).toBe(Date.parse("2026-03-01T10:00:00.000Z"));
    expect(page.routes[0]?.durationS).toBe(0);
  });

  it("skips impossible calendar dates instead of rolling them over", () => {
    const page = sanitizeRouteList(
      listOf([
        { ...sample, route_id: "rt-DEMO-k", started_at: "2026-02-30T10:00:00.000Z" },
        { ...sample, route_id: "rt-DEMO-l", started_at: "2026-03-01T24:00:00.000Z" },
        { ...sample, route_id: "rt-DEMO-m", started_at: "2026-13-01T10:00:00.000Z" },
      ]),
    );
    expect(page.routes).toEqual([]);
    expect(page.skipped).toBe(3);
    const valid = sanitizeRouteList(
      listOf([
        { ...sample, route_id: "rt-DEMO-n", started_at: "2024-02-29T23:59:59.000Z", ended_at: null },
        { ...sample, route_id: "rt-DEMO-o", started_at: "2026-12-31T00:00:00-08:00", ended_at: null },
      ]),
    );
    expect(valid.routes.map((r) => r.startMs)).toEqual([
      Date.parse("2024-02-29T23:59:59.000Z"),
      Date.parse("2026-12-31T08:00:00.000Z"),
    ]);
    expect(sanitizeRouteList(listOf([{ ...sample, average_speed: 0 }])).routes[0]?.averageSpeed).toBe(0);
  });

  it("treats an answer with more matches than routes as truncated, whatever the flag says", () => {
    const page = sanitizeRouteList({ routes: [sample], truncated: false, matched_routes: 900 });
    expect(page.truncated).toBe(true);
    expect(sanitizeRouteList({ routes: [sample], truncated: false, matched_routes: 1 }).truncated).toBe(false);
    expect(sanitizeRouteList({ routes: [sample], truncated: false, matched_routes: 2 }).truncated).toBe(true);
    expect(sanitizeRouteList({ routes: [], truncated: true, matched_routes: 0 }).truncated).toBe(true);
  });

  it("drops a negative average speed", () => {
    expect(sanitizeRouteList(listOf([{ ...sample, average_speed: -5 }])).routes[0]?.averageSpeed).toBeNull();
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
    expect(() => sanitizeRouteList(listOf([{ ...sample, route_id: "r".repeat(257) }]))).toThrow(ShapeError);
    expect(sanitizeRouteList(listOf([{ ...sample, route_id: "r".repeat(256) }])).routes.length).toBe(1);
    expect(() => sanitizeRouteList({ routes: [sample], truncated: false, matched_routes: 1.5 })).toThrow(ShapeError);
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
    const lines = untrimmedLines(trace);
    const rawLines = detail.geojson?.features.filter((f) => f.geometry.type === "LineString") ?? [];
    expect(rawLines.length).toBe(2);
    expect(lines.length).toBe(rawLines.length);
    expect(lines.length).toBe((detail.geojson?.features.length ?? 0) - 2);
    lines.forEach((line, index) => {
      const raw = rawLines[index]?.geometry.coordinates as number[][];
      expect(line.points).toEqual(raw.map(([longitude, latitude]) => [latitude, longitude]));
      expect(line.inferred).toBe(rawLines[index]?.properties.inferred);
    });
    expect(lines.some((line) => line.inferred === true)).toBe(true);
  });

  it("seals the untrimmed lines so nothing can draw them by accident", () => {
    const trace = sanitizeRouteTrace(detail);
    expect(Reflect.ownKeys(trace)).toEqual([]);
    expect(Object.getPrototypeOf(trace)).toBe(Object.prototype);
    expect(JSON.stringify(trace)).toBe("{}");
    expect(() => untrimmedLines({} as typeof trace)).toThrow(ShapeError);
  });

  it("treats a missing flag as unknown and a missing geometry as no lines", () => {
    const first = detail.geojson?.features.find((f) => f.geometry.type === "LineString");
    const noFlag = { geojson: { type: "FeatureCollection", features: [{ ...first, properties: {} }] } };
    expect(untrimmedLines(sanitizeRouteTrace(noFlag))[0]?.inferred).toBeNull();
    expect(untrimmedLines(sanitizeRouteTrace({ geojson: null }))).toEqual([]);
    expect(untrimmedLines(sanitizeRouteTrace({}))).toEqual([]);
    const noGeometry = {
      geojson: { type: "FeatureCollection", features: [{ type: "Feature", geometry: null }, { type: "Feature" }, first] },
    };
    expect(untrimmedLines(sanitizeRouteTrace(noGeometry)).length).toBe(1);
  });

  it("rejects coordinates that are not a place on Earth", () => {
    const bad = (coordinates: unknown): unknown => ({
      geojson: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: { type: "LineString", coordinates }, properties: {} }],
      },
    });
    expect(() => sanitizeRouteTrace(bad([[0, 91, 0]]))).toThrow(ShapeError);
    expect(() => sanitizeRouteTrace(bad([[181, 0, 0]]))).toThrow(ShapeError);
    expect(untrimmedLines(sanitizeRouteTrace(bad([[180, -90, 0]])))[0]?.points).toEqual([[-90, 180]]);
    expect(() => sanitizeRouteTrace(bad([["a", 1, 0]]))).toThrow(ShapeError);
    expect(() => sanitizeRouteTrace(bad("x"))).toThrow(ShapeError);
  });
});
